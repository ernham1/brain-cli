import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "./providers.js";

export interface PendingDecisionBrief {
  number: number;
  label: string;
  source: "bridge_result" | "expired_task" | "desktop_session_end" | "manual";
  taskId?: string;
  sourceMessageId?: number;
  title: string;
  question?: string;
  options?: string;
  message: string;
  createdAt: string;
  status: "pending";
}

export interface DecisionBriefMetadata {
  source?: PendingDecisionBrief["source"];
  taskId?: string;
  sourceMessageId?: number;
}

export interface SessionData {
  chatId: number;
  userId?: number;
  history: ChatMessage[];
  createdAt: string;
  lastMessageAt: string;
  // 히스토리 한도 초과 시 잘린 대화의 요약
  historySummary?: string;
  // 대기 중인 의사결정 브리프. 이사님이 "클로-12"/"12번"처럼 지시할 때 참조한다.
  pendingDecisionBriefs?: PendingDecisionBrief[];
  decisionBriefSequence?: number;
  // Brain 동기화
  brainLastSyncedAt?: string;    // 마지막으로 확인한 Brain 시점 (ISO 8601)
  brainManifestMtime?: number;   // manifest.json의 mtimeMs (변경 감지용)
  // 재시작 시 미삭제 "생각 중..." 메시지 정리용
  pendingStatusMessageId?: number;
  // /밴딩 on/off: 텔레클로 MCP 경로에서 BandingAI 강제 라우팅 여부
  bandingAiRouting?: {
    forced: boolean;
    updatedAt: string;
    updatedBy?: number;
  };
}

const MAX_MESSAGES = 60; // 최근 30턴 유지
const MAX_PENDING_DECISION_BRIEFS = 30;
const HISTORY_SUMMARY_MAX_CHARS = 8000;
const SUMMARY_EXCERPT_MESSAGES = 12;
const SUMMARY_MESSAGE_MAX_CHARS = 500;
const SESSION_IDLE_RESET_MS = 2 * 60 * 60 * 1000; // 2시간 공백 시 세션 자동 리셋

/** 세션 키 생성: 항상 chatId 기준 (그룹은 모든 참여자가 하나의 세션 공유) */
export function makeSessionKey(chatId: number, _userId?: number): string {
  return `${chatId}`;
}

export class SessionManager {
  private dir: string;

  constructor(sessionDir: string) {
    this.dir = sessionDir;
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  private filePath(sessionKey: string): string {
    // Path Traversal 방지: 숫자(chatId)만 허용
    const safeKey = sessionKey.replace(/[^0-9\-]/g, "");
    return path.join(this.dir, `${safeKey}.json`);
  }

  load(sessionKey: string): SessionData | null {
    const p = this.filePath(sessionKey);
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as SessionData;
    } catch {
      return null;
    }
  }

  save(session: SessionData): void {
    const key = makeSessionKey(session.chatId, session.userId);
    fs.writeFileSync(
      this.filePath(key),
      JSON.stringify(session, null, 2),
      "utf-8",
    );
  }

  reset(sessionKey: string): void {
    const p = this.filePath(sessionKey);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  listAll(): SessionData[] {
    try {
      return fs.readdirSync(this.dir)
        .filter((f) => f.endsWith(".json") && /^-?[0-9]+\.json$/.test(f))
        .map((f) => {
          try { return JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf-8")) as SessionData; }
          catch { return null; }
        })
        .filter((s): s is SessionData => s !== null);
    } catch {
      return [];
    }
  }

  getOrCreate(chatId: number, userId?: number): SessionData {
    const key = makeSessionKey(chatId, userId);
    const existing = this.load(key);
    if (existing && Array.isArray(existing.history)) {
      // 2시간 이상 공백이면 히스토리를 비우고 새 세션으로 시작
      const lastMsg = existing.lastMessageAt ? new Date(existing.lastMessageAt).getTime() : 0;
      const idle = Date.now() - lastMsg;
      if (idle > SESSION_IDLE_RESET_MS && existing.history.length > 0) {
        // 기존 히스토리를 요약으로 밀어넣고 초기화
        const dateLabel = new Date(existing.lastMessageAt).toLocaleString("ko-KR", {
          timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
        });
        const resetNote = [
          `[${dateLabel} 세션 자동 종료 — 2시간 이상 공백]`,
          "직전 대화 일부:",
          formatHistoryExcerpt(existing.history, SUMMARY_EXCERPT_MESSAGES),
        ].join("\n");
        existing.historySummary = appendHistorySummary(existing.historySummary, resetNote);
        existing.history = [];
        existing.createdAt = new Date().toISOString();
        this.save(existing);
      }
      return existing;
    }

    return {
      chatId,
      userId,
      history: [],
      createdAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
    };
  }

  recordAssistantMessage(chatId: number, message: string, userId?: number): void {
    const session = this.getOrCreate(chatId, userId);
    session.history.push({ role: "assistant", content: message });
    this.trimHistory(session);
    session.lastMessageAt = new Date().toISOString();
    this.save(session);
  }

  recordDecisionBrief(chatId: number, message: string, metadata: DecisionBriefMetadata = {}, userId?: number): string {
    const session = this.getOrCreate(chatId, userId);
    const nextNumber = Math.max(
      session.decisionBriefSequence ?? 0,
      ...(session.pendingDecisionBriefs ?? []).map((item) => item.number),
    ) + 1;
    const label = `클로-${nextNumber}`;
    const numberedMessage = withDecisionNumber(message, label, nextNumber);
    const entry: PendingDecisionBrief = {
      number: nextNumber,
      label,
      source: metadata.source ?? "manual",
      ...(metadata.taskId ? { taskId: metadata.taskId } : {}),
      ...(metadata.sourceMessageId !== undefined ? { sourceMessageId: metadata.sourceMessageId } : {}),
      title: extractBriefLine(numberedMessage, "작업") ?? extractBriefLine(numberedMessage, "프로젝트") ?? "의사결정 브리프",
      ...(extractBriefLine(numberedMessage, "질문") ? { question: extractBriefLine(numberedMessage, "질문") } : {}),
      ...(extractBriefLine(numberedMessage, "선택지") ? { options: extractBriefLine(numberedMessage, "선택지") } : {}),
      message: numberedMessage,
      createdAt: new Date().toISOString(),
      status: "pending",
    };

    session.decisionBriefSequence = nextNumber;
    session.pendingDecisionBriefs = [
      ...(session.pendingDecisionBriefs ?? []).filter((item) => item.status === "pending"),
      entry,
    ].slice(-MAX_PENDING_DECISION_BRIEFS);
    session.history.push({ role: "assistant", content: numberedMessage, contextClass: "decision_brief" });
    this.trimHistory(session);
    session.lastMessageAt = new Date().toISOString();
    this.save(session);
    return numberedMessage;
  }

  trimHistory(session: SessionData): void {
    if (session.history.length > MAX_MESSAGES) {
      const dropped = session.history.slice(0, session.history.length - MAX_MESSAGES);
      const dateLabel = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      const appended = `[${dateLabel} 이전]\n` + formatHistoryExcerpt(dropped);
      session.historySummary = appendHistorySummary(session.historySummary, appended);
      session.history = session.history.slice(-MAX_MESSAGES);
    }
  }
}

function withDecisionNumber(message: string, label: string, number: number): string {
  if (/^결정번호:/m.test(message)) return message;
  return [`결정번호: ${label} (${number}번)`, message].join("\n");
}

function extractBriefLine(message: string, label: string): string | undefined {
  const prefix = `${label}:`;
  const line = message.split(/\r?\n/).find((item) => item.startsWith(prefix));
  const value = line?.slice(prefix.length).trim();
  return value || undefined;
}

function appendHistorySummary(previous: string | undefined, appended: string): string {
  const combined = previous ? `${previous}\n---\n${appended}` : appended;
  return combined.length > HISTORY_SUMMARY_MAX_CHARS
    ? "(이전 생략)\n" + combined.slice(-HISTORY_SUMMARY_MAX_CHARS)
    : combined;
}

function formatHistoryExcerpt(
  messages: ChatMessage[],
  maxMessages = messages.length,
): string {
  const excerpt = messages
    .filter((message) => message.contextClass !== "decision_brief" && !/^결정번호:\s*클로-\d+/m.test(message.content))
    .slice(-maxMessages);
  if (excerpt.length === 0) return "- 기록 없음";

  return excerpt.map((m) => {
    const role = m.role === "assistant" ? "클로" : "이사님";
    const content = m.content.length > SUMMARY_MESSAGE_MAX_CHARS
      ? `${m.content.slice(0, SUMMARY_MESSAGE_MAX_CHARS)}...`
      : m.content;
    return `[${role}] ${content}`;
  }).join("\n");
}
