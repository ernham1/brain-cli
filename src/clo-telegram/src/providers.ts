import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  query,
  tool,
  createSdkMcpServer,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { brainTools, executeTool } from "./tools.js";
import { resolveClaudeCodePath, resolveBrainCliSrc, brainCli } from "./brain-resolve.js";
import { executeReminderTool } from "./reminder-tools.js";
import { generateImage, type ImageSize } from "./image-gen.js";
import type { ReminderStore } from "./scheduler.js";
import type { Config } from "./config.js";
import { shouldAutoApprove } from "./approval.js";
import type { ToolExecutionEvent } from "./persistence-contract.js";

const MAX_TOOL_ITERATIONS = 5;

/** 깨진 유니코드 서로게이트 문자를 제거 — Anthropic API JSON 파싱 에러 방지 */
function sanitizeText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

function isMaxTurnsErrorMessage(message: string): boolean {
  return /max[_\s-]?turns|maximum number of turns|Reached maximum number of turns/i.test(message);
}

function toolResultToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object" && "text" in item) {
      return String((item as { text?: unknown }).text || "");
    }
    return "";
  }).filter(Boolean).join("\n");
}

function isToolResultError(result: string, explicitError = false): boolean {
  return explicitError || /(?:오류|실패|거부|denied|not allowed|permission)/i.test(result);
}

export function formatSdkResultError(subtype: string | undefined, detail: string): string {
  if (subtype === "error_max_turns" || isMaxTurnsErrorMessage(detail)) {
    return "⚠️ 처리 중 최대 턴 수에 도달해서 세션을 초기화했어요. 같은 요청을 한 번만 다시 보내주세요.";
  }
  if (/rate[_ ]?limit|quota|429|hit your limit|limit\s*[·•]?\s*resets?/i.test(detail)) {
    return "⚠️ Claude Code 사용 한도에 도달했어요. 잠시 후 다시 시도해 주세요.";
  }
  if (/(?:^|\D)529(?:\D|$)|overloaded|server-side issue/i.test(detail)) {
    return "⚠️ Claude Code 서버가 일시적으로 과부하 상태예요. 잠시 후 다시 시도해 주세요.";
  }
  if (detail) {
    console.error(`[Clo] 내부 실행 오류 상세: ${detail.slice(0, 500)}`);
  }
  return "[SKIP]";
}

export function formatSdkAutoTerminationNotice(reason?: string): string {
  if (reason) {
    console.error(`[Clo] 자동 종료 상세: ${reason}`);
  }
  return "[SKIP]";
}

// --- 공통 인터페이스 ---

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  contextClass?: "conversation" | "decision_brief";
}

export function isDecisionBriefHistoryMessage(message: ChatMessage): boolean {
  return message.contextClass === "decision_brief"
    || (message.role === "assistant" && /^결정번호:\s*클로-\d+/m.test(message.content));
}

export function hasSimulatedUserRoleMarker(message: ChatMessage): boolean {
  return message.role === "assistant"
    && /(?:^|\r?\n)\s*(?:user|human)(?:(?:\s*[:：]\s*)|\s+|(?=[가-힣]))/i.test(message.content);
}

export function filterConversationHistoryForPrompt(history: ChatMessage[]): ChatMessage[] {
  return history.filter((message) =>
    !isDecisionBriefHistoryMessage(message) && !hasSimulatedUserRoleMarker(message),
  );
}

export interface ProviderChatOptions {
  cwd?: string;
  maxTokens?: number;
  maxTurns?: number;
  timeoutMs?: number;
  abortController?: AbortController;
  disableTools?: boolean;
  readOnlyTools?: boolean;
  persistSession?: boolean;
  onSessionId?: (sessionId: string) => void;
  onToolResult?: (event: ToolExecutionEvent) => void;
  _isRetry?: boolean;
}

export interface ChatProvider {
  chat(history: ChatMessage[], systemPrompt: string, chatId?: number, sessionKey?: string, onChunk?: (partialText: string) => void, onProgress?: (msg: string) => void, opts?: ProviderChatOptions): Promise<string>;
  resetSession?(chatId: number, sessionKey?: string): void;
  setApprovalService?(service: ApprovalService): void;
  setReminderStore?(store: ReminderStore): void;
}

/** 도구 이름 → 진행 상황 메시지 */
const TOOL_PROGRESS_MESSAGES: Record<string, string> = {
  "brain_recall": "🔍 기억 검색 중...",
  "mcp__brain-tools__brain_recall": "🔍 기억 검색 중...",
  "nexus_search": "🧠 Nexus 검색 중...",
  "mcp__brain-tools__nexus_search": "🧠 Nexus 검색 중...",
  "brain_write": "💾 기억 저장 중...",
  "mcp__brain-tools__brain_write": "💾 기억 저장 중...",
  "WebSearch": "🌐 웹 검색 중...",
  "WebFetch": "🔗 웹 페이지 읽는 중...",
  "Read": "📖 파일 읽는 중...",
  "Glob": "🗂️ 파일 탐색 중...",
  "Grep": "🔎 파일 내용 검색 중...",
  "Edit": "✏️ 파일 수정 중...",
  "Write": "📝 파일 저장 중...",
  "Bash": "⚙️ 명령어 실행 중...",
  "mcp__brain-tools__schedule_reminder": "⏰ 리마인더 설정 중...",
  "mcp__brain-tools__generate_image": "🎨 이미지 생성 중...",
  "mcp__brain-tools__send_file": "📤 파일 전송 중...",
  "mcp__brain-tools__get_weather": "🌤️ 날씨 조회 중...",
  // AgentForge 도구
  "mcp__agentforge__agentforge_list": "🤖 에이전트 목록 조회 중...",
  "mcp__agentforge__agentforge_invoke": "🤖 에이전트 실행 중...",
  "mcp__agentforge__agentforge_workflow": "🤖 워크플로 실행 중...",
  "mcp__agentforge__agentforge_status": "🔍 세션 상태 조회 중...",
  "mcp__agentforge__bandingai_list": "🤖 BandingAI 에이전트 목록 조회 중...",
  "mcp__agentforge__bandingai_invoke": "🤖 BandingAI 에이전트 브리프 확인 중...",
  "mcp__agentforge__bandingai_workflow": "🤖 BandingAI 워크플로 브리프 확인 중...",
  "mcp__agentforge__bandingai_status": "🔍 BandingAI 세션 상태 조회 중...",
  "mcp__agentforge__bandingai_result": "📄 BandingAI 세션 전문 조회 중...",
  "mcp__agentforge__bandingai_chat": "💬 BandingAI 에이전트 대화 브리프 확인 중...",
  "mcp__agentforge__bandingai_log": "📈 BandingAI 실행 로그 제출 중...",
  "mcp__agentforge__bandingai_feedback": "🧭 BandingAI 피드백 제출 중...",
  // 직접 등록된 도구 이름 (MCP prefix 없는 버전)
  "generate_image": "🎨 이미지 생성 중...",
  "send_file": "📤 파일 전송 중...",
  "schedule_reminder": "⏰ 리마인더 설정 중...",
  "list_reminders": "📋 리마인더 확인 중...",
  "cancel_reminder": "🗑️ 리마인더 취소 중...",
  "get_weather": "🌤️ 날씨 조회 중...",
};

const FULL_BUILTIN_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebSearch", "WebFetch"];
const READ_ONLY_BUILTIN_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];

// ApprovalService 타입 (순환 의존 방지용 인터페이스)
export interface ApprovalService {
  requestApproval(
    chatId: number,
    toolName: string,
    input: Record<string, unknown>,
    requesterId?: number,
  ): Promise<boolean>;
}

// --- 도구 스키마 (프로바이더 공통 원본) ---

const toolSchemas = brainTools.map((t) => ({
  name: t.name,
  description: t.description!,
  parameters: t.input_schema,
}));

// =============================================
// Anthropic
// =============================================

class AnthropicProvider implements ChatProvider {
  private client: Anthropic;
  private model: string;
  private brainRoot?: string;
  private brainEnabled: boolean;

  constructor(config: Config) {
    this.client = new Anthropic({ apiKey: config.anthropicApiKey });
    this.model = config.model;
    this.brainRoot = config.brainRoot;
    this.brainEnabled = config.brainEnabled;
  }

  async chat(history: ChatMessage[], systemPrompt: string, chatId?: number, _sessionKey?: string, onChunk?: (partialText: string) => void, _onProgress?: (msg: string) => void, opts?: ProviderChatOptions): Promise<string> {
    const messages: Anthropic.Messages.MessageParam[] = history.map((m) => ({
      role: m.role,
      content: sanitizeText(m.content),
    }));

    const tools = this.brainEnabled && !opts?.disableTools ? brainTools : [];

    let response = await this.client.messages.create({
      model: this.model,
      max_tokens: opts?.maxTokens ?? 4096,
      system: systemPrompt,
      ...(tools.length > 0 ? { tools } : {}),
      messages,
    });

    let iterations = 0;
    while (response.stop_reason === "tool_use" && iterations < MAX_TOOL_ITERATIONS) {
      iterations++;
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const input = block.input as Record<string, unknown>;
          const result = await executeTool(
            block.name,
            input,
            this.brainRoot || "",
            chatId,
          );
          opts?.onToolResult?.({
            toolName: block.name,
            input,
            result,
            isError: isToolResultError(result),
          });
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }
      }
      messages.push({ role: "user", content: toolResults });

      response = await this.client.messages.create({
        model: this.model,
        max_tokens: opts?.maxTokens ?? 4096,
        system: systemPrompt,
        ...(tools.length > 0 ? { tools } : {}),
        messages,
      });
    }

    // 최종 응답 — onChunk 콜백이 있으면 스트리밍으로 2초마다 부분 텍스트 전달
    if (onChunk) {
      let accumulated = "";
      let lastUpdate = Date.now();

      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: opts?.maxTokens ?? 4096,
        system: systemPrompt,
        messages,
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          accumulated += event.delta.text;
          const now = Date.now();
          if (now - lastUpdate >= 2000 && accumulated.length > 0) {
            lastUpdate = now;
            onChunk(accumulated);
          }
        }
      }

      const finalMsg = await stream.finalMessage();
      return (
        finalMsg.content
          .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
          .map((b: Anthropic.Messages.TextBlock) => b.text)
          .join("\n") || "(응답을 생성하지 못했어요)"
      );
    }

    return (
      response.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n") || "(응답을 생성하지 못했어요)"
    );
  }
}

// =============================================
// OpenAI
// =============================================

class OpenAIProvider implements ChatProvider {
  private client: OpenAI;
  private model: string;
  private brainRoot?: string;
  private brainEnabled: boolean;

  constructor(config: Config) {
    this.client = new OpenAI({ apiKey: config.openaiApiKey });
    this.model = config.model;
    this.brainRoot = config.brainRoot;
    this.brainEnabled = config.brainEnabled;
  }

  async chat(history: ChatMessage[], systemPrompt: string, _chatId?: number, _sessionKey?: string, _onChunk?: (partialText: string) => void, _onProgress?: (msg: string) => void, opts?: ProviderChatOptions): Promise<string> {
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined =
      this.brainEnabled && !opts?.disableTools
        ? toolSchemas.map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters as Record<string, unknown>,
            },
          }))
        : undefined;

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: sanitizeText(systemPrompt) },
      ...history.map(
        (m) =>
          ({
            role: m.role,
            content: sanitizeText(m.content),
          }) as OpenAI.Chat.Completions.ChatCompletionMessageParam,
      ),
    ];

    let response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: opts?.maxTokens ?? 4096,
      messages,
      ...(tools ? { tools } : {}),
    });

    let message = response.choices[0].message;
    let iterations = 0;

    while (
      message.tool_calls &&
      message.tool_calls.length > 0 &&
      iterations < MAX_TOOL_ITERATIONS
    ) {
      iterations++;
      messages.push(message);

      for (const toolCall of message.tool_calls) {
        if (!("function" in toolCall)) continue;
        const input = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
        const result = await executeTool(toolCall.function.name, input, this.brainRoot || "");
        opts?.onToolResult?.({
          toolName: toolCall.function.name,
          input,
          result,
          isError: isToolResultError(result),
        });
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }

      response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: opts?.maxTokens ?? 4096,
        messages,
        ...(tools ? { tools } : {}),
      });
      message = response.choices[0].message;
    }

    return message.content || "(응답을 생성하지 못했어요)";
  }
}


// =============================================
// Claude Code (SDK — Max 구독, 추가 비용 0원)
// =============================================

// CLI 경로 (동적 해결) — 환경변수 정리 전에 npm 글로벌 경로 결정
const CLI_PATH = resolveClaudeCodePath();

// PM2가 VS Code Claude 세션 안에서 시작되면 확장의 환경변수를 상속함.
// 핵심 문제: CLAUDE_CODE_EXECPATH가 VS Code 확장의 native binary 경로를 가리킴
//   → SDK가 그 경로로 spawn 시도 → "native binary not found" → 무한 응답 실패
// 해결: CLAUDE_CODE_EXECPATH만 우리가 결정한 npm 글로벌 경로로 덮어씀.
// 다른 CLAUDE_CODE_* 변수는 SDK 내부 동작/인증에 필요할 수 있으므로 보존.
const sdkEnv: Record<string, string | undefined> = { ...process.env };
delete sdkEnv.CLAUDECODE; // 중첩 세션 방지 (기존 동작)
sdkEnv.CLAUDE_CODE_EXECPATH = CLI_PATH;

// MCP 스트림 자동 종료 타임아웃 확장 (기본 60s → 300s)
// SDK 내부에서 MCP 도구 실행이 이 시간을 넘으면 "Stream closed" 에러 발생
// send_file(대용량 파일), generate_image(AI 생성 대기) 등에서 60s 초과 가능
sdkEnv.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = "300000";

// Bash 자식 프로세스 OS 레벨 강제 타임아웃 — SDK hook/canUseTool 우회 시에도 작동.
// 2026-04-25 사고: until/while + sleep 폴링 무한루프로 봇 12분 stuck.
// allowedTools에 Bash 포함 → canUseTool 우회 → 어떤 콜백 deny도 발동 안 함.
// 자식 프로세스 레벨에서 OS가 강제 종료하면 SDK 콜백 작동 여부와 무관하게 차단됨.
//   BASH_DEFAULT_TIMEOUT_MS: 일반 Bash 명령 기본 타임아웃 (1분)
//   BASH_MAX_TIMEOUT_MS: 클로가 명시적으로 timeout 매개변수를 더 크게 잡아도 이 값으로 cap (5분)
//   run_in_background:true 는 별도 채널이라 영향 없음
sdkEnv.BASH_DEFAULT_TIMEOUT_MS = "60000";
sdkEnv.BASH_MAX_TIMEOUT_MS = "300000";
const BRAIN_CLI_SCRIPT = path.join(resolveBrainCliSrc(), "index.js");

// 도구 분류
const SAFE_TOOLS = new Set([
  "Read", "Glob", "Grep",
  "mcp__brain-tools__brain_recall",
  "mcp__brain-tools__nexus_search",
  "mcp__brain-tools__brain_write",
  "mcp__brain-tools__schedule_reminder",
  "mcp__brain-tools__list_reminders",
  "mcp__brain-tools__cancel_reminder",
]);
const APPROVAL_TOOLS = new Set(["Edit", "Write", "Bash"]);

/** 세션 만료 시간: 30분 — 프로세스 크래시 후 stale 세션 resume 방지 */
const SESSION_MAX_AGE_MS = 30 * 60 * 1000;

/** chat() 응답 타임아웃: SSH 이미지 서버 기동 등 장시간 작업 대응 (20분 → 40분) */
const CHAT_TIMEOUT_MS = 40 * 60 * 1000;

/** SDK idle hang 감지 — "활성 tool_use가 0건인 상태가 이 시간 지속" 시 hang 판정.
 *  의미: "아무 도구도 안 쓰고 텍스트 응답도 안 흘러나오는" 진짜 무음만 잡음.
 *  정상 장기 작업(빌드, 테스트 등)은 tool_use가 inflight 상태이므로 면제. */
const IDLE_HANG_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_WATCHDOG_INTERVAL_MS = 60 * 1000;

/** 도구별 단일 호출 상한 — inflight 상태에서 이 시간 초과 시 그 도구 hang으로 판정.
 *  값은 그 도구의 합리적 최악 케이스(빌드/테스트/네트워크 지연 포함). */
const DEFAULT_TOOL_LIMIT_MS = 10 * 60 * 1000; // 10분
const TOOL_LIMITS_MS: Record<string, number> = {
  Bash: 10 * 60 * 1000,        // 빌드/테스트는 run_in_background + 단발 폴링 패턴 권장
  Edit: 2 * 60 * 1000,
  Write: 2 * 60 * 1000,
  Read: 2 * 60 * 1000,
  Glob: 2 * 60 * 1000,
  Grep: 2 * 60 * 1000,
  WebSearch: 3 * 60 * 1000,
  WebFetch: 3 * 60 * 1000,
  // brain_write는 대형 저장소의 전체 정합성 검증과 1회 재시도를 포함한다.
  "mcp__brain-tools__brain_recall": 60 * 1000,
  "mcp__brain-tools__nexus_search": 60 * 1000,
  "mcp__brain-tools__brain_write": 11 * 60 * 1000,
  "mcp__brain-tools__schedule_reminder": 60 * 1000,
  "mcp__brain-tools__list_reminders": 60 * 1000,
  "mcp__brain-tools__cancel_reminder": 60 * 1000,
  "mcp__brain-tools__generate_image": 10 * 60 * 1000,
  "mcp__brain-tools__send_file": 2 * 60 * 1000,
  "mcp__brain-tools__get_weather": 60 * 1000,
  // bandingai (LLM 다중 체이닝)
  "mcp__agentforge__bandingai_list": 2 * 60 * 1000,
  "mcp__agentforge__bandingai_invoke": 15 * 60 * 1000,
  "mcp__agentforge__bandingai_workflow": 15 * 60 * 1000,
  "mcp__agentforge__bandingai_status": 2 * 60 * 1000,
  "mcp__agentforge__bandingai_result": 2 * 60 * 1000,
  "mcp__agentforge__bandingai_chat": 15 * 60 * 1000,
  "mcp__agentforge__bandingai_log": 2 * 60 * 1000,
  "mcp__agentforge__bandingai_feedback": 2 * 60 * 1000,
};

interface SessionEntry {
  sessionId: string;
  updatedAt: number;
}

export class ClaudeCodeProvider implements ChatProvider {
  private model: string;
  private brainRoot?: string;
  private obsidianRoot?: string;
  private brainEnabled: boolean;
  private telegramBotToken: string;
  private sessionMap: Map<string, SessionEntry>; // sessionKey → { sessionId, updatedAt }
  private sessionMapPath: string;
  private approvalService?: ApprovalService;
  private reminderStore?: ReminderStore;
  private autoApprovePaths: string[];
  private autoApproveBashPatterns: string[];
  private agentforgeEnabled: boolean;
  private agentforgeUrl: string;
  private agentforgeApiKey?: string;
  private agentforgeUserId: string;
  // 진행 중인 query() AsyncGenerator 목록 — shutdown 시 일괄 종료
  private activeQueries: Set<AsyncGenerator> = new Set();

  constructor(config: Config) {
    this.model = config.model;
    this.brainRoot = config.brainRoot;
    this.obsidianRoot = config.obsidianRoot;
    this.brainEnabled = config.brainEnabled;
    this.telegramBotToken = config.telegramBotToken;
    this.sessionMapPath = path.join(config.sessionDir, "sdk-sessions.json");
    this.sessionMap = this.loadSessionMap();
    this.autoApprovePaths = config.autoApprovePaths;
    this.autoApproveBashPatterns = config.autoApproveBashPatterns;
    this.agentforgeEnabled = config.agentforgeEnabled;
    this.agentforgeUrl = config.agentforgeUrl;
    this.agentforgeApiKey = config.agentforgeApiKey;
    this.agentforgeUserId = config.agentforgeUserId;
    // 1시간마다 만료된 SDK 세션 정리
    setInterval(() => { this.sessionMap = this.loadSessionMap(); }, 60 * 60 * 1000).unref();
  }

  /** 디스크에서 sessionMap 복원 — 만료된 세션은 자동 제거 */
  private loadSessionMap(): Map<string, SessionEntry> {
    try {
      const data = JSON.parse(fs.readFileSync(this.sessionMapPath, "utf-8"));
      const now = Date.now();
      const map = new Map<string, SessionEntry>();
      let expired = 0;

      for (const [key, val] of Object.entries(data)) {
        // 하위 호환: 기존 plain string 형식 → 만료 처리 (타임스탬프 없으므로)
        if (typeof val === "string") {
          expired++;
          continue;
        }
        const entry = val as SessionEntry;
        if (now - entry.updatedAt > SESSION_MAX_AGE_MS) {
          expired++;
          continue;
        }
        map.set(key, entry);
      }

      if (expired > 0) {
        console.log(`[Clo] ${expired}개 만료된 SDK 세션 정리됨`);
        // 정리된 결과를 즉시 디스크에 반영
        const obj = Object.fromEntries(map);
        fs.writeFileSync(this.sessionMapPath, JSON.stringify(obj, null, 2), "utf-8");
      }

      return map;
    } catch {
      return new Map();
    }
  }

  /** sessionMap을 디스크에 저장 */
  private saveSessionMap(): void {
    const obj = Object.fromEntries(this.sessionMap);
    fs.writeFileSync(this.sessionMapPath, JSON.stringify(obj, null, 2), "utf-8");
  }

  /** 메시지 하나를 표시용 문자열로 변환 (2000자 제한) */
  private formatMessage(m: ChatMessage): string {
    const maxLen = 2000;
    const text = m.content.length > maxLen ? m.content.slice(0, maxLen) + "…(생략)" : m.content;
    if (m.role === "assistant") return `[클로] ${text}`;
    if (m.content.startsWith("[")) return text; // [발신자명] 또는 [워커...] 접두사 그대로
    return `[이사님] ${text}`;
  }

  /** 반복되는 시스템 메시지는 최신 1개만 유지 (dedup) */
  private deduplicateSystemMessages(messages: ChatMessage[]): ChatMessage[] {
    const SYSTEM_PATTERNS = [/^\[워커 완료 인계\]/, /^\[워커 실패 인계\]/];
    const lastIndex = new Map<number, number>(); // patternIndex → 마지막 등장 위치
    messages.forEach((m, i) => {
      if (m.role === "user") {
        SYSTEM_PATTERNS.forEach((pat, pi) => { if (pat.test(m.content)) lastIndex.set(pi, i); });
      }
    });
    return messages.filter((m, i) => {
      if (m.role !== "user") return true;
      for (let pi = 0; pi < SYSTEM_PATTERNS.length; pi++) {
        if (SYSTEM_PATTERNS[pi].test(m.content)) return lastIndex.get(pi) === i;
      }
      return true;
    });
  }

  /** 오래된 메시지 목록을 Haiku로 요약 (압축) */
  private async summarizeMessages(messages: ChatMessage[]): Promise<string> {
    const formatted = messages.map((m) => this.formatMessage(m)).join("\n\n");
    try {
      const client = new Anthropic();
      const result = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: "다음 대화 기록을 3~5문장으로 요약하세요. 핵심 결정사항과 중요 맥락만 포함하세요. 한국어로 작성하세요.",
        messages: [{ role: "user", content: formatted }],
      });
      const block = result.content[0];
      return block.type === "text" ? block.text : formatted.slice(0, 500) + "…";
    } catch {
      return formatted.slice(0, 500) + "…(요약 실패)";
    }
  }

  /** 대화 히스토리를 prompt 문자열로 포맷
   *  - 시스템 메시지 dedup: 같은 유형은 최신 1개만 유지
   *  - LLM 압축: 20개 초과 시 오래된 부분을 Haiku로 요약
   */
  private async formatHistoryPrompt(history: ChatMessage[], lastUserMsg: string): Promise<string> {
    const previous = filterConversationHistoryForPrompt(history.slice(0, -1)); // 현재 메시지와 결정 브리프 제외
    if (previous.length === 0) return lastUserMsg;

    const deduplicated = this.deduplicateSystemMessages(previous);
    const recent = deduplicated.slice(-30); // 최근 15턴

    const COMPRESSION_THRESHOLD = 20;
    let historySection: string;

    if (recent.length > COMPRESSION_THRESHOLD) {
      const oldMessages = recent.slice(0, -10);
      const recentMessages = recent.slice(-10);
      const summary = await this.summarizeMessages(oldMessages);
      const recentLines = recentMessages.map((m) => this.formatMessage(m));
      historySection = `[이전 대화 요약]\n${summary}\n\n[최근 대화]\n${recentLines.join("\n\n")}`;
    } else {
      historySection = recent.map((m) => this.formatMessage(m)).join("\n\n");
    }

    return [
      "<conversation_history>",
      historySection,
      "</conversation_history>",
      "",
      "<current_user_message>",
      lastUserMsg,
      "</current_user_message>",
      "",
      "현재 사용자 메시지에 대한 assistant 답변 하나만 작성하세요.",
      "사용자의 다음 발언을 예측하거나 `user`/`human` 역할 문장을 생성하지 마세요.",
    ].join("\n");
  }

  /** query()마다 새 MCP 서버 인스턴스 생성 (재사용 시 "Already connected" 에러 발생) */
  private createBrainMcp(): ReturnType<typeof createSdkMcpServer> {
    let successfulBrainWriteResult: string | null = null;
    return createSdkMcpServer({
      name: "brain-tools",
      tools: [
        ...(this.brainEnabled ? [
        tool(
          "brain_recall",
          "Brain 장기기억에서 관련 기억을 검색합니다.",
          {
            goal: z.string().describe("검색 키워드 또는 목표"),
            topK: z.number().optional().describe("반환할 최대 결과 수 (기본 5)"),
          },
          async (args) => ({
            content: [
              {
                type: "text" as const,
                text: await executeTool("brain_recall", args, this.brainRoot || ""),
              },
            ],
          }),
        ),
        tool(
          "nexus_search",
          "Nexus 지식그래프에서 수집된 논문, 오픈소스, AI 피드, 내부 지식 자료를 검색합니다. 리서치/조사 작업에서는 WebSearch 전에 먼저 호출하세요.",
          {
            query: z.string().describe("검색어 또는 리서치 주제"),
            mode: z.enum(["auto", "keyword", "semantic", "hybrid"]).optional().describe("검색 모드. 기본 auto"),
            limit: z.number().optional().describe("반환할 최대 결과 수. 기본 5, 최대 20"),
          },
          async (args) => ({
            content: [
              {
                type: "text" as const,
                text: await executeTool("nexus_search", args, this.brainRoot || ""),
              },
            ],
          }),
        ),
        tool(
          "brain_write",
          "Brain 장기기억에 새로운 기억을 저장합니다. 같은 요청에서는 한 번만 호출하세요.",
          {
            intent: z.string().describe("action/sourceRef/content/record를 포함한 Intent JSON 문자열"),
          },
          async (args) => {
            if (successfulBrainWriteResult) {
              return {
                content: [{
                  type: "text" as const,
                  text: `중복 저장 생략: ${successfulBrainWriteResult}`,
                }],
              };
            }
            const result = await executeTool("brain_write", args, this.brainRoot || "");
            if (/^저장 완료/.test(result)) successfulBrainWriteResult = result;
            return {
              content: [{ type: "text" as const, text: result }],
            };
          },
        ),
        ] : []),
        tool(
          "schedule_reminder",
          "리마인더를 설정합니다. 지정된 시간에 텔레그램으로 알림을 보냅니다.",
          {
            chatId: z.number().describe("텔레그램 chat ID"),
            datetime: z.string().describe("알림 시간 (ISO 8601, 예: 2026-03-05T14:00:00+09:00)"),
            description: z.string().describe("리마인더 내용"),
            repeat: z.enum(["daily", "weekly"]).nullable().optional().describe("반복 설정 (daily/weekly/null)"),
          },
          async (args) => ({
            content: [
              {
                type: "text" as const,
                text: this.reminderStore
                  ? executeReminderTool("schedule_reminder", args, this.reminderStore)
                  : "리마인더 저장소가 초기화되지 않았습니다.",
              },
            ],
          }),
        ),
        tool(
          "list_reminders",
          "현재 설정된 리마인더 목록을 조회합니다.",
          {
            chatId: z.number().describe("텔레그램 chat ID"),
          },
          async (args) => ({
            content: [
              {
                type: "text" as const,
                text: this.reminderStore
                  ? executeReminderTool("list_reminders", args, this.reminderStore)
                  : "리마인더 저장소가 초기화되지 않았습니다.",
              },
            ],
          }),
        ),
        tool(
          "cancel_reminder",
          "설정된 리마인더를 취소합니다.",
          {
            reminderId: z.string().describe("취소할 리마인더 ID"),
          },
          async (args) => ({
            content: [
              {
                type: "text" as const,
                text: this.reminderStore
                  ? executeReminderTool("cancel_reminder", args, this.reminderStore)
                  : "리마인더 저장소가 초기화되지 않았습니다.",
              },
            ],
          }),
        ),
        tool(
          "generate_image",
          "이미지를 생성합니다. 프롬프트에 맞는 이미지를 AI로 생성하여 텔레그램으로 전송합니다. " +
            "이사님이 이미지 생성을 요청할 때 사용하세요. 프롬프트는 영어로 작성하면 품질이 좋습니다.",
          {
            prompt: z.string().describe("생성할 이미지에 대한 상세 설명 (영어로 작성 권장)"),
            chatId: z.number().describe("이미지를 전송할 텔레그램 chat ID (현재 세션의 chatId 사용)"),
            size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).optional()
              .describe("이미지 크기 (기본: 1536x1024 3:2 가로, 정사각: 1024x1024, 세로: 1024x1536 2:3). GPT-image-2."),
          },
          async (args) => ({
            content: [{
              type: "text" as const,
              text: await generateImage(args.prompt, {
                chatId: args.chatId,
                size: args.size as ImageSize | undefined,
              }),
            }],
          }),
        ),
        tool(
          "send_file",
          "텔레그램으로 파일을 전송합니다. 리포트, 문서, 이미지 등 생성한 파일을 이사님에게 직접 보낼 때 사용하세요. 파일 경로를 알려주는 대신 이 도구로 직접 전송하세요.",
          {
            filePath: z.string().describe("전송할 파일의 절대 경로"),
            chatId: z.number().describe("텔레그램 chat ID (현재 세션의 chatId 사용)"),
            caption: z.string().optional().describe("파일에 대한 설명 (선택)"),
          },
          async (args) => {
            try {
              if (!fs.existsSync(args.filePath)) {
                return { content: [{ type: "text" as const, text: `파일을 찾을 수 없습니다: ${args.filePath}` }] };
              }
              const fileBuffer = fs.readFileSync(args.filePath);
              const fileName = path.basename(args.filePath);

              const formData = new FormData();
              formData.append("chat_id", String(args.chatId));
              formData.append("document", new Blob([fileBuffer]), fileName);
              if (args.caption) formData.append("caption", args.caption);

              const res = await fetch(
                `https://api.telegram.org/bot${this.telegramBotToken}/sendDocument`,
                { method: "POST", body: formData, signal: AbortSignal.timeout(30000) },
              );

              if (!res.ok) {
                const errText = await res.text();
                return { content: [{ type: "text" as const, text: `파일 전송 실패: ${errText}` }] };
              }

              return { content: [{ type: "text" as const, text: `✅ "${fileName}" 파일을 텔레그램으로 전송했습니다.` }] };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              return { content: [{ type: "text" as const, text: `파일 전송 실패: ${msg}` }] };
            }
          },
        ),
        tool(
          "get_weather",
          "현재 날씨를 조회합니다. 도시명 또는 위치를 입력하면 wttr.in에서 날씨 정보를 가져옵니다.",
          {
            location: z.string().describe("도시명 또는 위치 (예: Seoul, 서울, Busan)"),
          },
          async (args) => {
            try {
              const encoded = encodeURIComponent(args.location);
              const url = `https://wttr.in/${encoded}?format=3&lang=ko`;
              const res = await fetch(url, {
                headers: { "User-Agent": "curl/7.68.0" },
                signal: AbortSignal.timeout(5000),
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const text = (await res.text()).trim();
              return { content: [{ type: "text" as const, text }] };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              return { content: [{ type: "text" as const, text: `날씨 조회 실패: ${msg}` }] };
            }
          },
        ),
      ],
    });
  }

  setReminderStore(store: ReminderStore): void {
    this.reminderStore = store;
  }

  setApprovalService(service: ApprovalService): void {
    this.approvalService = service;
  }

  async chat(
    history: ChatMessage[],
    systemPrompt: string,
    chatId?: number,
    sessionKey?: string,
    _onChunk?: (partialText: string) => void,
    onProgress?: (msg: string) => void,
    opts?: ProviderChatOptions,
  ): Promise<string> {
    const lastUserMsg = history.filter((m) => m.role === "user").pop();

    const sKey = sessionKey || (chatId ? `${chatId}` : undefined);
    const sessionEntry = sKey ? this.sessionMap.get(sKey) : undefined;
    let sessionId = sessionEntry?.sessionId;
    if (sKey && sessionEntry && Date.now() - sessionEntry.updatedAt > SESSION_MAX_AGE_MS) {
      this.sessionMap.delete(sKey);
      this.saveSessionMap();
      sessionId = undefined;
    }
    const startTime = Date.now();
    const approval = this.approvalService;
    // SDK resume 시 이중 히스토리 방지:
    // resume(sessionId 있음) → SDK가 이미 대화 기록 보유 → 현재 메시지만 전달
    // 신규(sessionId 없음) → formatHistoryPrompt로 히스토리 포함
    const prompt = lastUserMsg
      ? (sessionId
        ? sanitizeText(lastUserMsg.content)
        : await this.formatHistoryPrompt(history, sanitizeText(lastUserMsg.content)))
      : "위 시스템 프롬프트의 지시에 따라 자연스러운 메시지를 생성해주세요.";

    // 턴 단위 승인: 첫 도구만 승인 요청, 이후 같은 턴 내 자동 승인
    let turnApproved = false;

    const toolsDisabled = opts?.disableTools === true;
    const readOnlyTools = !toolsDisabled && opts?.readOnlyTools === true;
    const builtinTools = toolsDisabled
      ? []
      : readOnlyTools
        ? READ_ONLY_BUILTIN_TOOLS
        : FULL_BUILTIN_TOOLS;
    const allowAgentforgeTools = this.agentforgeEnabled && !toolsDisabled && !readOnlyTools;

    // MCP 서버 구성 — Brain(in-process) + AgentForge(HTTP MCP 프로토콜)
    const mcpServers: Record<string, ReturnType<typeof createSdkMcpServer> | { type: "http"; url: string; headers?: Record<string, string> }> = {};
    if (!toolsDisabled) mcpServers["brain-tools"] = this.createBrainMcp();
    if (allowAgentforgeTools) {
      // API 키가 있으면 그걸 우선 쓰고, 없으면 로컬 신뢰 프로세스용 내부 토큰으로 인증한다.
      // (Host 헤더 기반 로컬 폴백이 위조 가능해 제거됨 — 2026-07-08)
      const agentforgeAuthHeaders: Record<string, string> | undefined = this.agentforgeApiKey
        ? { Authorization: `Bearer ${this.agentforgeApiKey}` }
        : process.env.BANDINGAI_INTERNAL_TOKEN
          ? { "x-bandingai-internal": process.env.BANDINGAI_INTERNAL_TOKEN }
          : undefined;
      mcpServers["agentforge"] = {
        type: "http" as const,
        url: `${this.agentforgeUrl}/api/mcp`,
        ...(agentforgeAuthHeaders ? { headers: agentforgeAuthHeaders } : {}),
      };
    }
    // KOSIS 국가통계포털 MCP (국가데이터처 공개 서버, 인증 없음) — 공개 통계 조회 전용
    if (!toolsDisabled) {
      mcpServers["kosis"] = {
        type: "http" as const,
        url: "https://kosismcp2026.vercel.app/api/mcp",
      };
    }
    const mcpServersOrUndefined = !toolsDisabled && Object.keys(mcpServers).length > 0 ? mcpServers : undefined;

    const brainAllowedTools = toolsDisabled
      ? []
      : readOnlyTools
        ? [
            ...(this.brainEnabled ? [
              "mcp__brain-tools__brain_recall",
              "mcp__brain-tools__nexus_search",
            ] : []),
            "mcp__brain-tools__list_reminders",
            "mcp__brain-tools__get_weather",
          ]
        : [
            ...(this.brainEnabled ? [
              "mcp__brain-tools__brain_recall",
              "mcp__brain-tools__nexus_search",
              "mcp__brain-tools__brain_write",
            ] : []),
            "mcp__brain-tools__schedule_reminder",
            "mcp__brain-tools__list_reminders",
            "mcp__brain-tools__cancel_reminder",
            "mcp__brain-tools__generate_image",
            "mcp__brain-tools__send_file",
            "mcp__brain-tools__get_weather",
          ];
    const agentforgeAllowedTools = allowAgentforgeTools
      ? [
          "mcp__agentforge__agentforge_list",
          "mcp__agentforge__agentforge_invoke",
          "mcp__agentforge__agentforge_workflow",
          "mcp__agentforge__agentforge_status",
          "mcp__agentforge__bandingai_list",
          "mcp__agentforge__bandingai_invoke",
          "mcp__agentforge__bandingai_workflow",
          "mcp__agentforge__bandingai_status",
          "mcp__agentforge__bandingai_result",
          "mcp__agentforge__bandingai_chat",
          "mcp__agentforge__bandingai_log",
          "mcp__agentforge__bandingai_feedback",
        ]
      : [];
    // KOSIS 국가통계 조회 도구 (읽기 전용, 항상 허용)
    const kosisAllowedTools = toolsDisabled
      ? []
      : [
          "mcp__kosis__kosis_local_search",
          "mcp__kosis__kosis_search",
          "mcp__kosis__kosis_validate",
          "mcp__kosis__kosis_get_data",
          "mcp__kosis__kosis_list",
        ];

    // 같은 호스트 curl 반복 감지용 카운터 (세션 내 공유)
    const curlHostCount = new Map<string, number>();

    // 연속 이미지 Read 카운터 — 이미지 3개 이상 연속 Read 차단
    let consecutiveImageReads = 0;

    const response = query({
      prompt,
      options: {
        systemPrompt: sanitizeText(systemPrompt),
        ...(opts?.abortController ? { abortController: opts.abortController } : {}),
        model: this.model,
        tools: builtinTools,
        mcpServers: mcpServersOrUndefined,
        // Edit/Write/Bash를 allowedTools에 포함 → canUseTool 콜백 우회
        // canUseTool은 stream 연결이 필요한데 워커 세션에서 stream closed 오류 발생
        // Bash 삭제 명령 차단은 canUseTool에서 처리
        allowedTools: toolsDisabled
          ? []
          : [
              ...builtinTools,
              ...brainAllowedTools,
              ...agentforgeAllowedTools,
              ...kosisAllowedTools,
            ],
        canUseTool: async (toolName, input) => {
          // 이미지 파일 연속 Read 차단 — 3개 이상이면 컨텍스트 폭발로 봇 먹통
          if (toolName === "Read") {
            const fp = String((input as Record<string, unknown>).file_path || "");
            if (/\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(fp)) {
              consecutiveImageReads++;
              if (consecutiveImageReads > 2) {
                console.warn(`[Clo] 이미지 ${consecutiveImageReads}번째 연속 Read 차단:`, fp);
                return {
                  behavior: "deny" as const,
                  message: `이미지를 한 번에 ${consecutiveImageReads}개 읽으면 봇이 멈춰요. 2개씩 나눠서 읽고 응답해주세요.`,
                };
              }
            } else {
              consecutiveImageReads = 0;
            }
          } else {
            consecutiveImageReads = 0;
          }

          // Bash 파일 삭제 명령만 차단
          if (toolName === "Bash") {
            let command = String((input as Record<string, unknown>).command || "");

            // curl에 --max-time 없으면 자동 주입 (hang 방지)
            if (/\bcurl\s/.test(command) && !/--max-time|-m\s+\d/.test(command)) {
              command = command.replace(/\bcurl(\s)/, "curl --max-time 30$1");
              (input as Record<string, unknown>).command = command;
              console.log("[Clo] curl --max-time 30 주입됨:", command.slice(0, 100));
            }

            // ssh에 타임아웃/배치 옵션 없으면 자동 주입 (SSH hang 방지)
            // ConnectTimeout=15: 접속 대기 15초 제한
            // BatchMode=yes: interactive 입력 프롬프트 차단 (패스워드/shell 대기 방지)
            // ServerAliveInterval/CountMax: 연결 후 hang 방지
            if (/\bssh\s/.test(command) && !/ConnectTimeout/.test(command)) {
              command = command.replace(
                /\bssh(\s)/,
                "ssh -o ConnectTimeout=15 -o BatchMode=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=3$1"
              );
              (input as Record<string, unknown>).command = command;
              console.log("[Clo] ssh 타임아웃 옵션 주입됨:", command.slice(0, 120));
            }

            // sleep/ping 대기 명령 — 봇 blocking 방지를 위해 차단
            // sleep N (N > 10) 또는 ping -n N (N > 10) 모두 차단
            const sleepMatch = command.match(/\bsleep\s+(\d+)/);
            const pingWaitMatch = command.match(/\bping\s+(?:[^\n]*\s)?-n\s+(\d+)/i);
            const waitSecs = sleepMatch ? parseInt(sleepMatch[1], 10)
              : pingWaitMatch ? parseInt(pingWaitMatch[1], 10)
              : 0;
            if (waitSecs > 10) {
              console.warn(`[Clo] 대기 ${waitSecs}초 명령 차단:`, command.slice(0, 100));
              return {
                behavior: "deny" as const,
                message: `${waitSecs}초 대기 명령은 봇 응답을 차단해요. 프로세스를 백그라운드로 띄운 뒤 별도 명령어로 상태를 확인하는 방식으로 바꿔주세요. 예: nohup command > /tmp/out.log 2>&1 & echo $!`,
              };
            }

            // until/while 폴링 루프 차단 — 매칭 안 되면 무한 sleep으로 봇 stuck (실제 12분 챗바퀴 사고 사례)
            // 패턴: `until <cond>; do sleep N; done` 또는 `while <cond>; do sleep N; done`
            const pollLoopMatch = command.match(/\b(until|while)\b[\s\S]+?\bdo\b[\s\S]+?\bsleep\s+\d+[\s\S]+?\bdone\b/);
            if (pollLoopMatch) {
              console.warn(`[Clo] ${pollLoopMatch[1]}/sleep 폴링 루프 차단:`, command.slice(0, 120));
              return {
                behavior: "deny" as const,
                message: `${pollLoopMatch[1]}/sleep 폴링 루프는 결과 파일이 비어있을 때 무한 대기하면서 봇을 stuck시켜요. 백그라운드 task는 SDK가 system task_notification으로 완료를 알려주니, 그 알림을 받은 다음 턴에 단발 grep/cat으로 결과를 확인하세요. (예: 알림 받기 전엔 끝나기 전에 다음 턴 호출하지 마세요)`,
              };
            }

            // 같은 호스트에 3회 이상 curl → 차단 (무한 재시도 방지)
            const hostMatch = command.match(/https?:\/\/([^/\s'"]+)/);
            if (hostMatch && /\bcurl\b/.test(command)) {
              const host = hostMatch[1];
              const count = (curlHostCount.get(host) ?? 0) + 1;
              curlHostCount.set(host, count);
              if (count > 3) {
                console.warn(`[Clo] ${host} curl ${count}회 반복 — 차단`);
                return { behavior: "deny" as const, message: `${host}에 ${count}번 연속 실패했어요. 다른 방법을 시도해 주세요.` };
              }
            }

            if (shouldAutoApprove(toolName, input as Record<string, unknown>, {
              autoApprovePaths: this.autoApprovePaths,
              autoApproveBashPatterns: this.autoApproveBashPatterns,
            })) {
              return { behavior: "allow" as const, updatedInput: input as Record<string, unknown> };
            }
            // 삭제 명령 — 승인 서비스가 있으면 팝업, 없으면 거부
            if (approval && chatId) {
              console.log(`[Clo] 삭제 명령 승인 요청: ${command.slice(0, 80)}`);
              const approved = await approval.requestApproval(chatId, toolName, input as Record<string, unknown>, undefined);
              if (approved) {
                turnApproved = true;
                return { behavior: "allow" as const, updatedInput: input as Record<string, unknown> };
              }
            }
            return { behavior: "deny" as const, message: "파일 삭제 명령은 허용되지 않아요" };
          }
          return { behavior: "allow" as const, updatedInput: input as Record<string, unknown> };
        },
        permissionMode: "default",
        maxTurns: opts?.maxTurns ?? 80,
        cwd: opts?.cwd ?? "D:/Projects",
        additionalDirectories: [
          ...(this.brainRoot ? [this.brainRoot] : []),
          ...(this.obsidianRoot ? [this.obsidianRoot] : []),
          ...(opts?.cwd ? [opts.cwd] : []),
        ],
        thinking: { type: "disabled" },
        effort: "high",
        persistSession: opts?.persistSession ?? true,
        settingSources: [], // 설정 파일 로딩 건너뛰기 (속도 향상)
        strictMcpConfig: true, // .mcp.json 무시 — 명시적 mcpServers만 사용 (cmd 창 방지)
        pathToClaudeCodeExecutable: CLI_PATH,
        env: sdkEnv,
        ...(sessionId ? { resume: sessionId } : {}),
      },
    });

    // 진행 중인 generator 추적 — shutdown 또는 재시도 시 명시적 종료
    const responseGen = response as AsyncGenerator;
    this.activeQueries.add(responseGen);

    // 타임아웃 설정 — ECONNRESET/hang 시 자동 복구
    let timeoutFired = false;
    const makeTimeoutFn = (label: string, ms: number) => setTimeout(() => {
      timeoutFired = true;
      console.error(`[Clo] ${label} — generator 강제 종료`);
      this.activeQueries.delete(responseGen);
      responseGen.return?.(undefined);
    }, ms);
    const effectiveTimeoutMs = opts?.timeoutMs ?? CHAT_TIMEOUT_MS;
    let timeoutId = makeTimeoutFn(`chat() ${Math.round(effectiveTimeoutMs / 60000)}분 타임아웃`, effectiveTimeoutMs);

    // SDK idle hang 감지 (재설계, 2026-04-25):
    //  - inflightTools: tool_use_id → { name, startedAt }. tool_result 도착 시 삭제.
    //  - 활성 tool_use가 있으면 그 도구의 자기 상한(TOOL_LIMITS_MS)으로 판정.
    //  - 활성 tool_use가 없으면 "마지막 SDK msg 이후 무음" 기준으로 판정 (진짜 hang).
    //  - turn 종료(result 메시지) 시 inflight Map 강제 클리어 (error_max_turns 등 누락 대비).
    let lastActivityAt = Date.now();
    let idleHangFired = false;
    let idleHangReason = "";
    const inflightTools = new Map<string, { name: string; startedAt: number; input: Record<string, unknown> }>();
    const idleWatchdog = setInterval(() => {
      const now = Date.now();

      // 1) 활성 tool_use 중 자기 상한 초과한 것 검사
      let longestHang: { id: string; name: string; elapsedMs: number } | null = null;
      for (const [id, info] of inflightTools) {
        const limit = TOOL_LIMITS_MS[info.name] ?? DEFAULT_TOOL_LIMIT_MS;
        const elapsedMs = now - info.startedAt;
        if (elapsedMs >= limit && (!longestHang || elapsedMs > longestHang.elapsedMs)) {
          longestHang = { id, name: info.name, elapsedMs };
        }
      }
      if (longestHang) {
        idleHangFired = true;
        idleHangReason = `tool '${longestHang.name}' ${Math.round(longestHang.elapsedMs / 60000)}분 무응답`;
        console.error(`[Clo] tool hang: ${idleHangReason} (id=${longestHang.id}) — generator 강제 종료`);
        clearInterval(idleWatchdog);
        this.activeQueries.delete(responseGen);
        responseGen.return?.(undefined);
        return;
      }

      // 2) 활성 tool_use 없는 상태에서 SDK msg 무음 시간 검사 (진짜 idle)
      if (inflightTools.size === 0) {
        const idleMs = now - lastActivityAt;
        if (idleMs >= IDLE_HANG_TIMEOUT_MS) {
          idleHangFired = true;
          idleHangReason = `SDK ${Math.round(idleMs / 60000)}분 무응답 (활성 도구 없음)`;
          console.error(`[Clo] SDK idle hang: ${idleHangReason} — generator 강제 종료`);
          clearInterval(idleWatchdog);
          this.activeQueries.delete(responseGen);
          responseGen.return?.(undefined);
        }
      }
    }, IDLE_WATCHDOG_INTERVAL_MS);

    let finalResult = "";
    let partialText = ""; // error_max_turns 시 부분 응답 추출용
    const pendingBrainLogs: Array<{ toolName: string; filePath: string; content: string }> = [];
    const turnToolCalls: string[] = [];
    let turnIsError = false;
    let turnErrorType = "";
    try {
      for await (const message of response) {
        lastActivityAt = Date.now(); // SDK 활동 갱신 — idle watchdog 리셋
        // 모든 메시지 타입 로깅 (도구 실행 에러 디버깅용)
        const msgType = `${message.type}/${(message as Record<string, unknown>).subtype || ""}`;
        if (message.type !== "assistant" && message.type !== "result") {
          console.log(`[Clo] SDK msg: ${msgType}`, JSON.stringify(message).slice(0, 300));
        }

        // compacting 감지 — 타임아웃을 2분으로 리셋 (장시간 멈춤 방지)
        if (message.type === "system" && (message as Record<string, unknown>).subtype === "compacting") {
          onProgress?.("🔄 대화 내용 정리 중...");
          clearTimeout(timeoutId);
          timeoutId = makeTimeoutFn("compacting 스톨 2분 타임아웃", 2 * 60 * 1000);
          continue;
        }

        // assistant 메시지에서 텍스트 수집 + 도구 사용 로깅
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text") {
              partialText = block.text;
            } else if (block.type === "tool_use") {
              console.log(`[Clo] tool_use: ${block.name}`, JSON.stringify(block.input).slice(0, 200));
              turnToolCalls.push(block.name);
              // inflight 추적 — id별 시작 시각 기록 (watchdog이 도구별 상한 검사)
              inflightTools.set(block.id, {
                name: block.name,
                startedAt: Date.now(),
                input: block.input as Record<string, unknown>,
              });
              // 도구 사용 시 진행 상황 메시지 전송 ([STEP] 래핑 → 워커에서도 텔레그램 전송됨)
              if (onProgress) {
                const progressMsg = TOOL_PROGRESS_MESSAGES[block.name];
                if (progressMsg) onProgress(`[STEP] ${progressMsg}`);
              }
              if (block.name === "Edit" || block.name === "Write") {
                const inp = block.input as Record<string, unknown>;
                const filePath = ((inp.file_path ?? "") as string);
                const content = ((inp.content ?? inp.new_string ?? "") as string);
                if (filePath && content && !this.shouldSkipPath(filePath)) {
                  pendingBrainLogs.push({ toolName: block.name, filePath, content });
                }
              }
            } else {
              console.log(`[Clo] content block: ${block.type}`);
            }
          }
        }

        // user 메시지(tool_result 묶음) — inflight Map에서 해당 tool_use_id 제거
        if (message.type === "user") {
          const userContent = (message as { message?: { content?: unknown } }).message?.content;
          if (Array.isArray(userContent)) {
            for (const block of userContent) {
              if (block && typeof block === "object" && (block as { type?: string }).type === "tool_result") {
                const toolResult = block as { tool_use_id?: string; content?: unknown; is_error?: boolean };
                const toolUseId = toolResult.tool_use_id;
                const inflight = toolUseId ? inflightTools.get(toolUseId) : undefined;
                if (inflight) {
                  const result = toolResultToText(toolResult.content);
                  opts?.onToolResult?.({
                    toolName: inflight.name,
                    input: inflight.input,
                    result,
                    isError: isToolResultError(result, toolResult.is_error === true),
                  });
                }
                if (toolUseId) inflightTools.delete(toolUseId);
              }
            }
          }
        }

        if (message.type === "result") {
          // turn 종료 — error_max_turns/error_during_execution 등에서 tool_result가 누락돼도 안전하게 inflight 정리
          inflightTools.clear();
          if (message.subtype === "success") {
            finalResult = message.result;
          } else {
            // 에러 상세 로그
            const err = message as Record<string, unknown>;
            const errorDetail = JSON.stringify(err.errors || err.stop_reason || "");
            console.error(
              `[Clo] SDK 에러: ${message.subtype}`,
              errorDetail,
            );
            turnIsError = true;
            turnErrorType = message.subtype ?? "unknown";
            // error_max_turns 시 부분 응답 사용
            if (message.subtype === "error_max_turns" && partialText) {
              console.log("[Clo] max_turns 도달 — 부분 응답 사용");
              finalResult = partialText;
            }
            // error_max_turns + 부분 응답 없음 — 세션 리셋 후 재요청 안내
            else if (message.subtype === "error_max_turns") {
              console.log("[Clo] max_turns 도달 — 세션 초기화 후 재요청 안내");
              if (sKey) { this.sessionMap.delete(sKey); this.saveSessionMap(); }
              finalResult = formatSdkResultError(message.subtype, errorDetail);
            }
            // resume 실패 시 세션 초기화하고 재시도 (최대 1회)
            else if (sKey && sessionId && !opts?._isRetry) {
              console.log("[Clo] 세션 초기화 후 재시도...");
              this.sessionMap.delete(sKey);
              this.saveSessionMap();
              return this.chat(history, systemPrompt, chatId, sessionKey, _onChunk, onProgress, { ...opts, _isRetry: true });
            } else {
              if (sKey) {
                this.sessionMap.delete(sKey);
                this.saveSessionMap();
              }
              finalResult = formatSdkResultError(message.subtype, errorDetail);
            }
          }
          if (sKey && message.session_id && opts?.persistSession !== false) {
            this.sessionMap.set(sKey, { sessionId: message.session_id, updatedAt: Date.now() });
            this.saveSessionMap();
            opts?.onSessionId?.(message.session_id);
          }
        }
      }
      // Edit/Write 도구 호출 → 루프 완료 후 Brain work-log 저장 (비동기, 논블로킹)
      if (pendingBrainLogs.length > 0) {
        const logsSnapshot = [...pendingBrainLogs];
        setImmediate(() => {
          for (const entry of logsSnapshot) {
            this.logEditWriteToBrainSync(entry.toolName, entry.filePath, entry.content);
          }
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Clo] SDK 예외: ${msg}`);
      turnIsError = true;
      turnErrorType = "sdk_exception";

      // 입력 오염(서로게이트 페어 깨짐, invalid JSON)은 재시도해도 같은 결과 → 즉시 사용자 안내
      const isInvalidInput = /invalid_request_error|no low surrogate|no high surrogate|not valid JSON/i.test(msg);
      const isMaxTurns = isMaxTurnsErrorMessage(msg);
      // Claude Code 한도 초과 신호 (5시간 세션 한도 "hit your limit · resets 6:40pm" 포함)
      const isRateLimited = /rate[_ ]?limit|quota|429|실행할 수 있는 인스턴스가 없습니다|hit your limit|limit\s*[·•]?\s*resets?/i.test(msg);
      const isProviderOverloaded = /(?:^|\D)529(?:\D|$)|overloaded|server-side issue/i.test(msg);

      if (isInvalidInput) {
        turnErrorType = "invalid_input";
        finalResult = "⚠️ 메시지에 처리할 수 없는 문자(깨진 이모지/특수문자)가 포함돼 있어요. 다시 입력해 주세요.";
      } else if (isMaxTurns) {
        turnErrorType = "error_max_turns";
        if (sKey) { this.sessionMap.delete(sKey); this.saveSessionMap(); }
        finalResult = formatSdkResultError("error_max_turns", msg);
      } else if (isRateLimited) {
        turnErrorType = "rate_limited";
        // 에러 메시지에서 reset 시각 추출: "resets 6:40pm (Asia/Seoul)"
        const resetMatch = msg.match(/resets?\s+([\d:]+\s*[ap]m)/i);
        const resetHint = resetMatch ? ` (${resetMatch[1]} 이후 자동 복구)` : "";
        finalResult = `⚠️ Claude Code 사용 한도에 도달했어요${resetHint}. 잠시 후 다시 시도해 주세요.`;
      } else if (isProviderOverloaded && !opts?._isRetry) {
        turnErrorType = "provider_overloaded_retry";
        console.log("[Clo] Claude 서버 과부하 — 3초 후 1회 재시도...");
        this.activeQueries.delete(responseGen);
        await responseGen.return?.(undefined);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return this.chat(history, systemPrompt, chatId, sessionKey, _onChunk, onProgress, { ...opts, _isRetry: true });
      } else if (isProviderOverloaded) {
        turnErrorType = "provider_overloaded";
        finalResult = "⚠️ Claude Code 서버가 일시적으로 과부하 상태예요. 잠시 후 다시 시도해 주세요.";
      } else if (sKey && sessionId && !opts?._isRetry) {
        // resume 실패 시 세션 초기화하고 재시도 (최대 1회)
        console.log("[Clo] 세션 초기화 후 재시도...");
        this.sessionMap.delete(sKey);
        this.saveSessionMap();
        // 재시도 전 현재 generator 명시적 종료 (claude.exe subprocess 해제)
        this.activeQueries.delete(responseGen);
        await responseGen.return?.(undefined);
        return this.chat(history, systemPrompt, chatId, sessionKey, _onChunk, onProgress, { ...opts, _isRetry: true });
      } else {
        // 재시도 불가 또는 재시도 후 실패 — 원인을 사용자에게 전달
        finalResult = formatSdkResultError("sdk_exception", msg);
      }
    } finally {
      clearTimeout(timeoutId);
      clearInterval(idleWatchdog);
      this.activeQueries.delete(responseGen);
    }

    if (idleHangFired) {
      return formatSdkAutoTerminationNotice(idleHangReason);
    }

    if (timeoutFired) {
      return `⏱️ 응답 시간이 ${Math.round(effectiveTimeoutMs / 60000)}분을 초과했어요. 잠시 후 다시 시도해 주세요.`;
    }

    if (!finalResult && turnIsError) {
      finalResult = formatSdkResultError(turnErrorType, "");
    }

    const totalElapsedMs = Date.now() - startTime;
    const elapsed = (totalElapsedMs / 1000).toFixed(1);
    console.log(`[Clo] SDK 응답 완료 (${elapsed}초)`);

    // 턴 로그 저장 (비동기, 논블로킹)
    if (chatId && turnToolCalls.length > 0) {
      const userMsgPreview = lastUserMsg?.content?.slice(0, 120) ?? "";
      setImmediate(() => this.appendConversationTurn({
        chatId,
        userMessagePreview: userMsgPreview,
        toolCalls: turnToolCalls,
        totalElapsedMs,
        isError: turnIsError,
        errorType: turnIsError ? turnErrorType : undefined,
      }));
    }

    // 도구만 실행하고 텍스트 응답이 없는 경우 빈 문자열 반환
    // → sendLongMessage에서 빈 문자열은 전송 스킵됨
    return finalResult || "";
  }

  private appendConversationTurn(turn: {
    chatId: number;
    userMessagePreview: string;
    toolCalls: string[];
    totalElapsedMs: number;
    isError: boolean;
    errorType?: string;
  }): void {
    try {
      const logDir = path.join(process.cwd(), "data", "logs");
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, "conversation-turns.jsonl");
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        chatId: turn.chatId,
        userMessagePreview: turn.userMessagePreview,
        toolCalls: turn.toolCalls,
        totalTools: turn.toolCalls.length,
        totalElapsedMs: turn.totalElapsedMs,
        isError: turn.isError,
        ...(turn.errorType ? { errorType: turn.errorType } : {}),
      });
      fs.appendFileSync(logFile, line + "\n", "utf-8");
    } catch { /* 로그 실패는 무시 */ }
  }

  /** conversation-turns.jsonl 분석 — 느린 패턴·오류 패턴 요약 반환 */
  static analyzeConversationTurns(dataDir: string): string {
    const logFile = path.join(dataDir, "logs", "conversation-turns.jsonl");
    if (!fs.existsSync(logFile)) return "분석할 로그 없음";

    const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
    if (lines.length === 0) return "분석할 로그 없음";

    const turns = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const total = turns.length;
    const errors = turns.filter((t) => t.isError);
    const slow = turns.filter((t) => t.totalElapsedMs > 30_000); // 30초 이상
    const heavyTools = turns.filter((t) => t.totalTools >= 5);

    // 도구별 사용 빈도
    const toolFreq: Record<string, number> = {};
    for (const t of turns) {
      for (const tool of (t.toolCalls ?? [])) {
        toolFreq[tool] = (toolFreq[tool] ?? 0) + 1;
      }
    }
    const topTools = Object.entries(toolFreq).sort((a, b) => b[1] - a[1]).slice(0, 5);

    // 오류 유발 메시지 패턴 샘플
    const errorSamples = errors.slice(-3).map((t) => `"${t.userMessagePreview?.slice(0, 60)}"`).join(", ");

    const avgElapsed = Math.round(turns.reduce((s, t) => s + (t.totalElapsedMs ?? 0), 0) / total / 1000);

    return [
      `📊 대화 턴 분석 (최근 ${total}건)`,
      `- 평균 응답시간: ${avgElapsed}초`,
      `- 오류 발생: ${errors.length}건 (${Math.round(errors.length / total * 100)}%)`,
      `- 30초 이상 느린 턴: ${slow.length}건`,
      `- 도구 5개+ 과다 사용: ${heavyTools.length}건`,
      `- 자주 쓰는 도구: ${topTools.map(([t, c]) => `${t}(${c})`).join(", ")}`,
      errorSamples ? `- 오류 발생 메시지 샘플: ${errorSamples}` : "",
    ].filter(Boolean).join("\n");
  }

  resetSession(chatId: number, sessionKey?: string): void {
    const sKey = sessionKey || `${chatId}`;
    this.sessionMap.delete(sKey);
    this.saveSessionMap();
  }

  /** 진행 중인 모든 query() generator 종료 — shutdown 시 호출 */
  async cleanupAll(): Promise<void> {
    const queries = [...this.activeQueries];
    this.activeQueries.clear();
    await Promise.allSettled(queries.map((g) => g.return?.(undefined)));
    console.log(`[Clo] ${queries.length}개 진행 중인 쿼리 정리 완료`);
  }

  private shouldSkipPath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, "/");
    const SKIP = ["90_index/", "records.jsonl", "node_modules", ".tmp", ".git", "auto_brain_"];
    if (SKIP.some((p) => normalized.includes(p))) return true;
    const ALLOWED_EXT = [".ts", ".tsx", ".js", ".mjs", ".py", ".json", ".yaml", ".yml", ".md", ".sh", ".toml"];
    const dotIdx = normalized.lastIndexOf(".");
    if (dotIdx === -1) return true;
    return !ALLOWED_EXT.includes(normalized.slice(dotIdx).toLowerCase());
  }

  private logEditWriteToBrainSync(toolName: string, filePath: string, content: string): void {
    try {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      const preview = content.slice(0, 300).replace(/\n/g, "\\n");

      // Brain이 아닌 로컬 로그에 append (검색 대상 아님, 필요 시 참조용)
      const logDir = path.join(process.cwd(), "logs");
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, "work-log.jsonl");
      const entry = JSON.stringify({ ts, tool: toolName, file: filePath, preview });
      fs.appendFileSync(logFile, entry + "\n", "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Clo] work-log 로컬 저장 실패 (무시): ${msg}`);
    }
  }
}

// =============================================
// CLI 프로바이더 공통 유틸
// =============================================

const CLI_TIMEOUT_MS = 120_000; // 2분

/** 대화 히스토리를 단일 프롬프트 문자열로 변환 (CLI용) */
function formatCliPrompt(
  history: ChatMessage[],
  systemPrompt: string,
  botName: string,
): string {
  const maxLen = 2000;
  const recent = history.slice(-30); // 최근 15턴

  const lines = recent.map((m) => {
    const raw = sanitizeText(m.content);
    const text = raw.length > maxLen
      ? raw.slice(0, maxLen) + "…(생략)"
      : m.content;
    if (m.role === "assistant") return `[${botName}] ${text}`;
    // user 메시지: [발신자명] 접두사가 있으면 그대로
    if (m.content.startsWith("[")) return text;
    return `[사용자] ${text}`;
  });

  return `${systemPrompt}\n\n## 대화 기록\n\n${lines.join("\n\n")}\n\n---\n\n위 대화의 마지막 메시지에 대해 ${botName}으로서 자연스럽게 응답하세요. [QUIET] 규칙을 준수하세요.`;
}

/** CLI 프로세스 스폰 → stdout 반환 (stdin 파이프 방식) */
function spawnCli(
  command: string,
  args: string[],
  stdinInput?: string,
  timeoutMs: number = CLI_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Windows에서 npm 글로벌 CLI(.cmd)를 찾으려면 shell 필요
    // 사용자 입력은 stdin 파이프로 전달 — 인자 인젝션 없음
    const proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
      shell: process.platform === "win32",
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      if (code === 0 || stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`CLI 종료 코드 ${code}: ${stderr.slice(0, 500)}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`CLI 실행 실패: ${err.message}`));
    });

    if (stdinInput) {
      proc.stdin.write(stdinInput);
    }
    proc.stdin.end();
  });
}

interface CliProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function spawnCliProcess(
  command: string,
  args: string[],
  stdinInput?: string,
  timeoutMs: number = CLI_TIMEOUT_MS,
): Promise<CliProcessResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
      shell: process.platform === "win32",
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });

    proc.on("error", (err) => {
      reject(new Error(`CLI 실행 실패: ${err.message}`));
    });

    if (stdinInput) {
      proc.stdin.write(stdinInput);
    }
    proc.stdin.end();
  });
}


// =============================================
// Codex CLI Provider
// =============================================

class CodexCliProvider implements ChatProvider {
  private botName: string;

  constructor(config: Config) {
    this.botName = config.botNameKr;
  }

  async chat(
    history: ChatMessage[],
    systemPrompt: string,
  ): Promise<string> {
    // Codex는 코딩 에이전트 — 텍스트 응답만 하도록 지시 추가
    const chatPrompt = formatCliPrompt(history, systemPrompt, this.botName);
    const wrappedPrompt =
      "IMPORTANT: You are acting as a chat participant. Respond with ONLY plain text. " +
      "Do NOT edit files, do NOT run commands, do NOT use tools. " +
      "Just generate a conversational response.\n\n" +
      chatPrompt;
    const startTime = Date.now();

    // Codex exec는 stdout에 헤더/토큰 정보를 섞어 출력 → -o 파일로 응답 추출
    const tmpDir = process.env.TEMP || process.env.TMP || "/tmp";
    const outFile = path.join(tmpDir, `codex-out-${Date.now()}.txt`);

    try {
      await spawnCli(
        "codex",
        ["exec", "--ephemeral", "--skip-git-repo-check", "-o", outFile, "-"],
        wrappedPrompt,
      );
      const result = fs.readFileSync(outFile, "utf-8").trim();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[${this.botName}] Codex CLI 응답 완료 (${elapsed}초)`);
      return result || "(응답을 생성하지 못했어요)";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.botName}] Codex CLI 에러: ${msg}`);
      return "(Codex CLI 응답 실패)";
    } finally {
      try { fs.unlinkSync(outFile); } catch { /* 이미 없으면 무시 */ }
    }
  }
}

// =============================================
// Codex SDK Provider
// =============================================

class CodexSdkProvider implements ChatProvider {
  private botName: string;
  private model: string;
  private pythonCommand: string;
  private sandbox: "read_only" | "workspace_write" | "full_access";
  private cwd: string;
  private timeoutMs: number;

  constructor(config: Config) {
    this.botName = config.botNameKr;
    this.model = config.codexSdkModel;
    this.pythonCommand = config.codexSdkPython;
    this.sandbox = config.codexSdkSandbox;
    this.cwd = config.codexSdkCwd || process.cwd();
    this.timeoutMs = config.codexSdkTimeoutSec * 1000;
  }

  async chat(
    history: ChatMessage[],
    systemPrompt: string,
    _chatId?: number,
    _sessionKey?: string,
    _onChunk?: (partialText: string) => void,
    onProgress?: (msg: string) => void,
    opts?: ProviderChatOptions,
  ): Promise<string> {
    const prompt = formatCliPrompt(history, systemPrompt, this.botName);
    const wrappedPrompt =
      "IMPORTANT: You are acting as a Telegram chat participant. " +
      "Respond with ONLY plain Korean text. Do not edit files unless the user explicitly asks for implementation work.\n\n" +
      prompt;

    const tmpDir = os.tmpdir();
    const stamp = `${Date.now()}-${process.pid}`;
    const promptFile = path.join(tmpDir, `codex-sdk-prompt-${stamp}.txt`);
    const outFile = path.join(tmpDir, `codex-sdk-out-${stamp}.json`);
    const runner = process.env.CODEX_SDK_RUNNER ||
      path.join(process.cwd(), "tools", "codex-sdk-run.py");
    const cwd = opts?.cwd || this.cwd;
    const timeoutMs = opts?.timeoutMs || this.timeoutMs;

    const args = [
      runner,
      "--prompt-file", promptFile,
      "--out-file", outFile,
      "--sandbox", this.sandbox,
      "--cwd", cwd,
    ];
    if (this.model.trim()) {
      args.push("--model", this.model.trim());
    }

    try {
      fs.writeFileSync(promptFile, wrappedPrompt, "utf-8");
      onProgress?.("Codex SDK 호출 중...");
      const result = await spawnCliProcess(this.pythonCommand, args, undefined, timeoutMs);
      if (result.code !== 0 && !fs.existsSync(outFile)) {
        throw new Error(`CLI 종료 코드 ${result.code}: ${result.stderr.slice(0, 500)}`);
      }
      const payload = JSON.parse(fs.readFileSync(outFile, "utf-8")) as {
        ok?: boolean;
        status?: string;
        error?: string | null;
        final_response?: string;
      };
      if (!payload.ok) {
        const reason = payload.error || payload.status || "unknown";
        console.error(`[${this.botName}] Codex SDK 에러: ${reason}`);
        return `(Codex SDK 응답 실패: ${reason})`;
      }
      const response = (payload.final_response || "").trim();
      return response || "(Codex SDK가 응답을 생성하지 못했어요)";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.botName}] Codex SDK 실행 실패: ${msg}`);
      return `(Codex SDK 실행 실패: ${msg})`;
    } finally {
      try { fs.unlinkSync(promptFile); } catch { /* 이미 없으면 무시 */ }
      try { fs.unlinkSync(outFile); } catch { /* 이미 없으면 무시 */ }
    }
  }
}

// =============================================
// Factory
// =============================================

export function createProvider(config: Config): ChatProvider {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicProvider(config);
    case "openai":
      return new OpenAIProvider(config);
    case "claude-code":
      return new ClaudeCodeProvider(config);
    case "codex-cli":
      return new CodexCliProvider(config);
    case "codex-sdk":
      return new CodexSdkProvider(config);
    default:
      throw new Error(`지원하지 않는 프로바이더: ${config.provider}`);
  }
}
