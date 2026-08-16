import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";
import { brainCli } from "./brain-resolve.js";
import { resolveBrainCliSrc } from "./brain-resolve.js";
import { executeSessionEngine, type SessionEngineInput } from "./session-engine.js";

const { search, getDefaultBrainRoot, readJsonl } = brainCli;
const execFileAsync = promisify(execFile);

// brain-cli 진입점 — 자식 프로세스 spawn 시 사용.
// in-process BWT 호출 시 Atomics.wait 락이 메인 스레드를 얼려 SDK stdio가 끊기는
// 문제("Stream closed" tool_result)를 우회하기 위해 write는 반드시 자식 프로세스에서 실행.
const BRAIN_CLI_ENTRY = path.join(resolveBrainCliSrc(), "index.js");
const ALLOWED_SOURCE_TYPES = new Set(["user_confirmed", "candidate", "chat_log", "external_doc", "inference"]);
const ALLOWED_RECORD_TYPES = new Set(["rule", "decision", "profile", "log", "ref", "note", "candidate", "reminder", "project_state", "meta_strategy", "wiki"]);
const RECORD_TYPE_ALIASES: Record<string, string> = {
  verification: "log",
  verified: "log",
  work_log: "log",
  milestone: "project_state",
  progress: "project_state",
  state: "project_state",
  status: "project_state",
};
const SOURCE_TYPE_ALIASES: Record<string, string> = {
  internal_doc: "candidate",
  internal: "candidate",
  project_doc: "candidate",
  document: "candidate",
};

// --- Anthropic 도구 정의 ---

export const brainTools: Anthropic.Messages.Tool[] = [
  {
    name: "brain_recall",
    description:
      "Brain 장기기억에서 관련 기억을 검색합니다. " +
      "이전 대화, 프로젝트 결정, 기술 노트, 사용자 선호 등을 찾을 수 있습니다.",
    input_schema: {
      type: "object" as const,
      properties: {
        goal: {
          type: "string",
          description: "검색 키워드 또는 목표 (예: '텔레그램 봇 설계')",
        },
        topK: {
          type: "number",
          description: "반환할 최대 결과 수 (기본 5)",
        },
      },
      required: ["goal"],
    },
  },
  {
    name: "nexus_search",
    description:
      "Nexus 지식그래프에서 수집된 논문, 오픈소스, AI 피드, 내부 지식 자료를 검색합니다. " +
      "리서치/조사 작업에서는 WebSearch 전에 먼저 호출해 내부 축적 자료를 확인하세요.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "검색어 또는 리서치 주제",
        },
        mode: {
          type: "string",
          enum: ["auto", "keyword", "semantic", "hybrid"],
          description: "검색 모드. 기본 auto",
        },
        limit: {
          type: "number",
          description: "반환할 최대 결과 수. 기본 5, 최대 20",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "brain_write",
    description:
      "Brain 장기기억에 새로운 기억을 저장합니다. " +
      "중요한 결정, 새로운 선호, 프로젝트 상태, 대화 내용 등을 기록할 때 사용합니다. " +
      "intent는 반드시 아래 형식의 JSON 문자열이어야 합니다.\n\n" +
      "필수 필드:\n" +
      '- action: "create" (새 기록) 또는 "update" (기존 수정, recordId 필요)\n' +
      '- sourceRef: 파일 경로 (예: "30_topics/test/note.md", "10_projects/myapp/state.md")\n' +
      "- content: 저장할 본문 (마크다운 문자열)\n" +
      "- record: 아래 필드를 포함하는 객체\n\n" +
      "record 필드:\n" +
      '- scopeType: "user" | "project" | "topic" 중 하나\n' +
      '- scopeId: 스코프 식별자 (예: "ernham", "clo-telegram", "family")\n' +
      '- type: "log" | "note" | "candidate" | "decision" | "rule" | "profile" | "ref" | "reminder" | "project_state" | "meta_strategy" 중 하나\n' +
      '- title: 제목 문자열\n' +
      '- summary: 한 줄 요약\n' +
      '- tags: 배열 (예: ["domain/dev", "intent/retrieval"])\n' +
      '- sourceType: "candidate" | "user_confirmed" | "chat_log" | "external_doc" | "inference" 중 하나\n\n' +
      "예시:\n" +
      '{"action":"create","sourceRef":"30_topics/family/memo.md","content":"# 메모\\n내용","record":{"scopeType":"topic","scopeId":"family","type":"note","title":"메모 제목","summary":"한 줄 요약","tags":["domain/personal","intent/reference"],"sourceType":"candidate"}}',
    input_schema: {
      type: "object" as const,
      properties: {
        intent: {
          type: "string",
          description: "위 형식을 따르는 Intent JSON 문자열",
        },
      },
      required: ["intent"],
    },
  },
  {
    name: "session_engine",
    description:
      "SessionEngine(멀티세션 오케스트레이션 엔진, WSL 127.0.0.1:4870)을 호출합니다. " +
      "프로젝트 단위로 Claude Code 세션들을 기동/발견/메시지라우팅/로그수집/종료할 수 있습니다. " +
      "이사님이 멀티세션 작업(오케스트레이터+팀장+에이전트 배치, 세션 간 지시 전달)을 요청할 때 사용하세요.\n" +
      "op 종류: health(생존확인) / create_project(name,prompt: 오케스트레이터 기동 / external:true면 prompt 없이 호출자 자신이 오케스트레이터) / list_projects / " +
      "delete_project(projectId) / list_sessions(projectId) / spawn_session(projectId,name,prompt[,role]: 세션명은 '<프로젝트명>-' 접두사 필수) / " +
      "send_message(projectId,sessionId,text[,kind,deadline,context]: 봉투 규약 적용. kind=task면 deadline 필수. 실배달 판정 포함, 수십 초 소요) / " +
      "get_logs(projectId,sessionId) / stop_session(projectId,sessionId) / list_tasks(projectId: 과제 장부·overdue 확인) / close_task(projectId,taskId: 과제 마감)",
    input_schema: {
      type: "object" as const,
      properties: {
        op: {
          type: "string",
          enum: ["health", "create_project", "list_projects", "delete_project", "list_sessions", "spawn_session", "send_message", "get_logs", "stop_session", "list_tasks", "close_task"],
          description: "수행할 작업",
        },
        projectId: { type: "string", description: "프로젝트 ID (prj-xxxx)" },
        sessionId: { type: "string", description: "세션 ID (agents 8자리)" },
        name: { type: "string", description: "프로젝트명 또는 세션명" },
        prompt: { type: "string", description: "기동할 세션에 줄 프롬프트" },
        text: { type: "string", description: "라우팅할 메시지 본문" },
        model: { type: "string", description: "모델 오버라이드 (선택)" },
        effort: { type: "string", description: "effort 오버라이드 (선택)" },
        role: { type: "string", description: "세션 역할 표기 (lead/agent 등, 선택)" },
        external: { type: "boolean", description: "create_project 전용: true면 오케스트레이터를 스폰하지 않고 호출자(클로 자신)가 오케스트레이터가 됨. prompt 불필요 (선택)" },
        taskId: { type: "string", description: "과제 ID (tsk-8hex). send_message에서 미지정 시 자동 생성, close_task에서 필수" },
        kind: { type: "string", enum: ["task", "done", "report", "info", "ping"], description: "메시지 유형. task=과제 발행(deadline 필수), 기본 info" },
        from: { type: "string", description: "발신자 표기. 기본 teleclo" },
        deadline: { type: "string", description: "과제 기한 ISO8601. kind=task일 때 필수 — 과제 크기를 보고 직접 정할 것" },
        context: { type: "string", description: "과제 수행에 필요한 맥락 요약 (선택)" },
      },
      required: ["op"],
    },
  },
];

// --- 도구 실행 ---

interface RecallInput {
  goal: string;
  topK?: number;
}

interface NexusSearchInput {
  query: string;
  mode?: "auto" | "keyword" | "semantic" | "hybrid";
  limit?: number;
}

interface WriteInput {
  intent: string;
}

interface DigestCandidate {
  recordId: string;
  score: number;
  title: string;
  summary: string;
  originalChunkPreview?: string;
  _layer?: string;
}

function formatRecallCandidate(candidate: DigestCandidate): string {
  const preview = candidate.originalChunkPreview ? ` | 원본: ${candidate.originalChunkPreview}` : "";
  const layer = candidate._layer ? ` | 근거층: ${candidate._layer}` : "";
  return `[${candidate.score.toFixed(1)}] [${candidate.recordId}] ${candidate.title} — ${candidate.summary}${preview}${layer}`;
}

export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  brainRoot: string,
  chatId?: number,
): Promise<string> {
  switch (toolName) {
    case "brain_recall":
      return executeRecall(input as unknown as RecallInput, brainRoot, chatId);
    case "nexus_search":
      return executeNexusSearch(input as unknown as NexusSearchInput);
    case "brain_write":
      return executeWrite(input as unknown as WriteInput, brainRoot, chatId);
    case "session_engine":
      return executeSessionEngine(input as unknown as SessionEngineInput);
    default:
      return `알 수 없는 도구: ${toolName}`;
  }
}

// brain-server HTTP API 경유 recall — Brain + NeuralfluxBrain peer 합산 검색
const BRAIN_SERVER_URL = process.env.BRAIN_SERVER_URL || "http://127.0.0.1:3849";
const NEXUS_BASE_URL = process.env.NEXUS_BASE_URL || "http://localhost:5080";

export async function executeNexusSearch(input: NexusSearchInput): Promise<string> {
  const query = input.query?.trim();
  if (!query) return "Nexus 검색어가 필요합니다.";

  const limit = Math.max(1, Math.min(Number(input.limit || 5), 20));
  const mode = input.mode || "auto";
  const url = new URL("/api/search", NEXUS_BASE_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("mode", mode);
  url.searchParams.set("limit", String(limit));

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json().catch(() => null) as {
      items?: Array<{
        name?: string;
        nameKo?: string | null;
        type?: string;
        source?: string;
        sourceUrl?: string | null;
        description?: string | null;
        rank?: number;
      }>;
      mode?: string;
      requestedMode?: string;
      tookMs?: number;
      error?: { message?: string };
    } | null;

    if (!res.ok) {
      return `Nexus 검색 실패: HTTP ${res.status}${data?.error?.message ? ` — ${data.error.message}` : ""}`;
    }

    const items = data?.items ?? [];
    if (items.length === 0) {
      return `Nexus 검색 결과 없음: "${query}"`;
    }

    const lines = items.map((item, index) => {
      const title = item.nameKo || item.name || "(제목 없음)";
      const source = [item.type, item.source].filter(Boolean).join(" / ") || "unknown";
      const rank = typeof item.rank === "number" ? ` rank=${item.rank.toFixed(4)}` : "";
      const urlPart = item.sourceUrl ? `\n   sourceUrl: ${item.sourceUrl}` : "";
      const description = item.description ? `\n   ${item.description.slice(0, 220).replace(/\s+/g, " ")}` : "";
      return `${index + 1}. ${title} (${source}${rank})${urlPart}${description}`;
    });

    return [
      `Nexus 검색 결과: "${query}"`,
      `mode=${data?.mode ?? mode}, requested=${data?.requestedMode ?? mode}, tookMs=${data?.tookMs ?? "-"}`,
      ...lines,
    ].join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Nexus 검색 오류: ${msg}`;
  }
}

async function recallViaBrainServer(input: RecallInput): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${BRAIN_SERVER_URL}/api/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: input.goal, topK: input.topK || 5 }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      success: boolean;
      results: { candidates?: DigestCandidate[] };
    };
    if (!data.success || !data.results?.candidates) return null;
    const relevant = data.results.candidates.filter((c) => c.score > 0);
    if (relevant.length === 0) return "관련 기억 없음";
    return relevant
      .map(formatRecallCandidate)
      .join("\n");
  } catch {
    return null; // brain-server 미응답 → 로컬 fallback
  } finally {
    clearTimeout(timeout);
  }
}
export async function executeRecall(input: RecallInput, _brainRoot: string, chatId?: number): Promise<string> {
  const chatInfo = chatId ? ` [chatId=${chatId}]` : "";

  // 1차: brain-server HTTP API (Brain + NeuralfluxBrain peer 합산 검색)
  const serverResult = await recallViaBrainServer(input);
  if (serverResult !== null) {
    return serverResult;
  }
  console.warn(`[Brain] brain_recall${chatInfo}: brain-server 미응답 → 로컬 fallback`);

  // 2차: 로컬 fallback (기존 방식 — Brain만 검색)
  const resolvedRoot = getDefaultBrainRoot();
  if (!resolvedRoot) {
    return "Brain 경로를 찾을 수 없습니다.";
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = search(resolvedRoot, {
        currentGoal: input.goal,
        topK: input.topK || 5,
      });

      const relevant = result.candidates.filter((c: DigestCandidate) => c.score > 0);
      if (relevant.length === 0) return "관련 기억 없음";
      return relevant.map(formatRecallCandidate).join("\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Brain] brain_recall${chatInfo} 시도 ${attempt}: ${msg}`);
      if (attempt === 2) return `Brain 검색 오류: ${msg}`;
    }
  }
  return "알 수 없는 오류";
}

// brain-cli 유틸 re-export (agent.ts에서 사용)
export { getDefaultBrainRoot, readJsonl };

/** LLM의 정본/레거시 입력을 Brain write 정본 구조로 보정한다. */
export function normalizeBrainWriteIntent(intent: Record<string, unknown>): Record<string, unknown> {
  if (!intent.record || typeof intent.record !== "object") {
    intent.record = {};
  }
  const record = intent.record as Record<string, unknown>;

  const rawAction = typeof intent.action === "string" ? intent.action.trim().toLowerCase() : "";
  if (rawAction === "record") intent.action = "create";
  if (rawAction === "upsert") {
    intent.action = typeof intent.recordId === "string" && intent.recordId.trim() ? "update" : "create";
  }

  const legacyTitle = typeof intent.title === "string" ? intent.title.trim() : "";
  const legacySummary = typeof intent.summary === "string" ? intent.summary.trim() : "";
  const legacyProject = typeof intent.project === "string" ? intent.project.trim() : "";
  const legacyTopic = typeof intent.topic === "string" ? intent.topic.trim() : "";
  const legacyScopeId = typeof intent.scopeId === "string" ? intent.scopeId.trim() : "";
  const legacyType = typeof intent.type === "string" ? intent.type.trim().toLowerCase() : "";

  if (!record.title && legacyTitle) record.title = legacyTitle;
  if (!record.summary && legacySummary) record.summary = legacySummary;
  if (!record.scopeType) {
    if (legacyProject || legacyType === "project") record.scopeType = "project";
    else if (legacyType === "user") record.scopeType = "user";
    else record.scopeType = "topic";
  }
  if (!record.scopeId) {
    record.scopeId = legacyProject || legacyTopic || legacyScopeId || inferScopeIdFromTitle(legacyTitle);
  }
  if (!record.type) {
    if (["decision", "project_state", "rule", "log", "note"].includes(legacyType)) {
      record.type = legacyType;
    } else if (/progress|state/.test(legacyType)) {
      record.type = legacyType.includes("state") ? "project_state" : "log";
    } else {
      record.type = "note";
    }
  }
  if (typeof record.type === "string") {
    const normalizedType = record.type.trim().toLowerCase();
    record.type = RECORD_TYPE_ALIASES[normalizedType]
      || (ALLOWED_RECORD_TYPES.has(normalizedType) ? normalizedType : record.type);
  }
  if (!record.sourceType && intent.sourceType) record.sourceType = intent.sourceType;
  if ((!Array.isArray(record.tags) || record.tags.length === 0) && Array.isArray(intent.tags)) {
    record.tags = intent.tags;
  }

  record.sourceType = normalizeSourceType(record.sourceType);
  if (!Array.isArray(record.tags) || record.tags.length === 0) {
    record.tags = ["domain/memory", "intent/retrieval"];
  }

  if (!record.title && typeof intent.content === "string") {
    const match = intent.content.match(/^#\s+(.+)$/m);
    if (match) record.title = match[1].trim();
  }
  if (!record.title) record.title = "텔레그램 메모";

  if (!record.summary) {
    if (typeof intent.content === "string") {
      const firstLine = intent.content.split("\n").find((line) => line.trim() && !line.startsWith("#"));
      record.summary = firstLine?.trim().slice(0, 120) || String(record.title);
    } else {
      record.summary = String(record.title);
    }
  }

  if (!intent.content) {
    const legacyBody = typeof intent.body === "string" ? intent.body.trim() : "";
    const legacyDetail = typeof intent.detail === "string" ? intent.detail.trim() : "";
    const body = legacyBody || legacyDetail || String(record.summary || "");
    intent.content = `# ${record.title}\n\n${body}`;
  }

  if (typeof intent.sourceRef === "string" && intent.sourceRef.trim()) {
    const normalizedRef = normalizeSourceRef(intent.sourceRef);
    intent.sourceRef = isSafeRelativeSourceRef(normalizedRef)
      ? normalizedRef
      : buildGeneratedSourceRef(record, normalizedRef);
  } else {
    intent.sourceRef = buildGeneratedSourceRef(record);
  }

  if (!intent.action) intent.action = "create";
  return intent;
}

function inferScopeIdFromTitle(title: string): string {
  const leadingPhrase = title
    .replace(/\([^)]*\)/g, " ")
    .split(/[—–:|]/, 1)[0]
    .replace(/\b20\d{2}[-./]?\d{0,2}[-./]?\d{0,2}\b/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join("-")
    .replace(/[^a-zA-Z0-9가-힣_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return leadingPhrase || "telegram-memory";
}
export function normalizeSourceType(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "candidate";
  const normalized = value.trim().toLowerCase();
  const aliased = SOURCE_TYPE_ALIASES[normalized] || normalized;
  return ALLOWED_SOURCE_TYPES.has(aliased) ? aliased : "candidate";
}

export function normalizeSourceRef(sourceRef: string): string {
  return sourceRef.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

export function isSafeRelativeSourceRef(sourceRef: string): boolean {
  if (!sourceRef) return false;
  if (/^[a-zA-Z]:\//.test(sourceRef)) return false;
  if (sourceRef.includes(":")) return false;
  const parts = sourceRef.split("/");
  return !parts.some((part) => part === ".." || part === "");
}

export function buildGeneratedSourceRef(record: Record<string, unknown>, originalSourceRef?: string): string {
  const scopeType = String(record.scopeType || "topic");
  const scopeId = String(record.scopeId || "misc").replace(/[^a-zA-Z0-9가-힣_-]/g, "-") || "misc";
  const folder = scopeType === "user" ? "00_user"
    : scopeType === "project" ? "10_projects"
    : "30_topics";
  const rawName = originalSourceRef
    ? path.posix.basename(originalSourceRef, path.posix.extname(originalSourceRef))
    : String(record.title || "note");
  const slug = rawName
    .replace(/[^a-zA-Z0-9가-힣\s_-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60) || "note";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${folder}/${scopeId}/${date}_${slug}.md`;
}

export const BRAIN_WRITE_TIMEOUT_MS = 5 * 60 * 1000;
export const BRAIN_WRITE_MAX_ATTEMPTS = 1;

/**
 * 재시도 시 보존해야 할 BWT 트랜잭션 임시 파일을 진단한다.
 * 파일 정리는 락을 보유한 brain-cli BWT만 수행할 수 있다.
 */
export function listBrainTransactionTmpFiles(brainRoot: string): string[] {
  try {
    const indexDir = path.join(brainRoot, "90_index");
    return fs.readdirSync(indexDir).filter((fileName) => fileName.endsWith(".tmp"));
  } catch {
    return [];
  }
}

async function executeWrite(input: WriteInput, _brainRoot: string, chatId?: number): Promise<string> {
  if (!input?.intent) {
    return "brain_write 오류: intent 필드가 필요합니다. JSON 형식의 intent를 전달하세요.";
  }

  const resolvedRoot = getDefaultBrainRoot();
  if (!resolvedRoot) {
    return "Brain 경로를 찾을 수 없습니다. BRAIN_ROOT 환경변수를 확인하세요.";
  }

  const chatInfo = chatId ? ` [chatId=${chatId}]` : "";

  // 1. intent 문자열 정제 + JSON 파싱 + 자동 보정 (in-process — 빠름, 락 없음)
  let intent: Record<string, unknown>;
  try {
    const rawIntent = input.intent.trim()
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();
    const jsonStart = rawIntent.indexOf("{");
    if (jsonStart === -1) throw new Error("JSON 객체를 찾을 수 없습니다");
    const fromJson = rawIntent.slice(jsonStart);
    const jsonEnd = (() => {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = 0; i < fromJson.length; i++) {
        const ch = fromJson[i];
        if (escape) { escape = false; continue; }
        if (ch === "\\" && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === "{") depth++;
        else if (ch === "}") { if (--depth === 0) return i + 1; }
      }
      return fromJson.length;
    })();
    intent = JSON.parse(fromJson.slice(0, jsonEnd));
    normalizeBrainWriteIntent(intent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Brain] brain_write${chatInfo} intent 파싱 실패: ${msg}`);
    return `Brain 저장 오류: ${msg}. intent JSON 형식을 확인하세요.`;
  }

  // 2. 자식 프로세스(brain-cli write)로 실행 — 메인 스레드 블로킹 없음.
  //    큰 intent는 argv 한도(Windows 8KB)에 걸릴 수 있어 임시 파일 경유로 전달.
  const tmpFile = path.join(
    os.tmpdir(),
    `brain-write-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );

  try {
    fs.writeFileSync(tmpFile, JSON.stringify(intent), "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Brain] brain_write${chatInfo} 임시 파일 쓰기 실패: ${msg}`);
    return `Brain 저장 오류: 임시 파일 생성 실패 (${msg})`;
  }

  for (let attempt = 1; attempt <= BRAIN_WRITE_MAX_ATTEMPTS; attempt++) {
    // BWT 트랜잭션 파일은 다른 writer가 사용 중일 수 있으므로 절대 삭제하지 않는다.
    if (attempt > 1) {
      const transactionTmpFiles = listBrainTransactionTmpFiles(resolvedRoot);
      if (transactionTmpFiles.length > 0) {
        console.log(`[Brain] 활성 BWT .tmp 파일 ${transactionTmpFiles.length}개 보존 후 재시도`);
      }
    }

    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [BRAIN_CLI_ENTRY, "write", tmpFile],
        {
          timeout: BRAIN_WRITE_TIMEOUT_MS,
          encoding: "utf-8",
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        },
      );

      const output = (stdout || "") + (stderr ? `\n${stderr}` : "");
      const recordIdMatch = output.match(/"recordId":\s*"([^"]+)"/);
      if (recordIdMatch) {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        return `저장 완료: ${recordIdMatch[1]}`;
      }
      if (output.includes("SUCCESS")) {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        return "저장 완료";
      }

      // SUCCESS/recordId 둘 다 없으면 실패로 간주
      const tail = output.trim().slice(-500);
      console.error(`[Brain] brain_write${chatInfo} 시도 ${attempt}: ${tail}`);
      if (attempt === BRAIN_WRITE_MAX_ATTEMPTS) {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        return `저장 실패: ${tail || "알 수 없는 응답"}\n\n✅ 올바른 형식:\n{"action":"create","sourceRef":"30_topics/topic/file.md","content":"# 제목\\n본문","record":{"scopeType":"topic","scopeId":"식별자","type":"note","title":"제목","summary":"한 줄 요약","tags":["domain/dev","intent/retrieval"],"sourceType":"candidate"}}`;
      }
    } catch (err) {
      // execFile은 non-zero exit 또는 timeout 시 throw
      const msg = err instanceof Error ? err.message : String(err);
      // execFile 에러 객체는 stdout/stderr를 보유
      const errObj = err as { stdout?: string; stderr?: string };
      const errOutput = ((errObj.stdout || "") + (errObj.stderr || "")).trim().slice(-500);
      console.error(`[Brain] brain_write${chatInfo} 시도 ${attempt}: ${msg} | out=${errOutput}`);
      if (attempt === BRAIN_WRITE_MAX_ATTEMPTS) {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        return `Brain 저장 오류: ${msg}${errOutput ? ` | ${errOutput}` : ""}. 자동 재전송하지 않았습니다.`;
      }
    }
  }

  try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  return "알 수 없는 오류";
}
