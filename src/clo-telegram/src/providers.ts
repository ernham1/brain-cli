import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI, type FunctionCall } from "@google/generative-ai";
import {
  query,
  tool,
  createSdkMcpServer,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { brainTools, executeTool } from "./tools.js";
import { executeReminderTool } from "./reminder-tools.js";
import type { ReminderStore } from "./scheduler.js";
import type { Config } from "./config.js";

const MAX_TOOL_ITERATIONS = 5;

// --- 공통 인터페이스 ---

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatProvider {
  chat(history: ChatMessage[], systemPrompt: string, chatId?: number, sessionKey?: string): Promise<string>;
  resetSession?(chatId: number, sessionKey?: string): void;
  setApprovalService?(service: ApprovalService): void;
  setReminderStore?(store: ReminderStore): void;
}

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
  private brainRoot: string;

  constructor(config: Config) {
    this.client = new Anthropic({ apiKey: config.anthropicApiKey });
    this.model = config.model;
    this.brainRoot = config.brainRoot;
  }

  async chat(history: ChatMessage[], systemPrompt: string): Promise<string> {
    const messages: Anthropic.Messages.MessageParam[] = history.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    let response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: systemPrompt,
      tools: brainTools,
      messages,
    });

    let iterations = 0;
    while (response.stop_reason === "tool_use" && iterations < MAX_TOOL_ITERATIONS) {
      iterations++;
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: executeTool(
              block.name,
              block.input as Record<string, unknown>,
              this.brainRoot,
            ),
          });
        }
      }
      messages.push({ role: "user", content: toolResults });

      response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt,
        tools: brainTools,
        messages,
      });
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
  private brainRoot: string;

  constructor(config: Config) {
    this.client = new OpenAI({ apiKey: config.openaiApiKey });
    this.model = config.model;
    this.brainRoot = config.brainRoot;
  }

  async chat(history: ChatMessage[], systemPrompt: string): Promise<string> {
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] =
      toolSchemas.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters as Record<string, unknown>,
        },
      }));

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...history.map(
        (m) =>
          ({
            role: m.role,
            content: m.content,
          }) as OpenAI.Chat.Completions.ChatCompletionMessageParam,
      ),
    ];

    let response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      messages,
      tools,
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
        const input = JSON.parse(toolCall.function.arguments);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: executeTool(toolCall.function.name, input, this.brainRoot),
        });
      }

      response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 4096,
        messages,
        tools,
      });
      message = response.choices[0].message;
    }

    return message.content || "(응답을 생성하지 못했어요)";
  }
}

// =============================================
// Gemini
// =============================================

class GeminiProvider implements ChatProvider {
  private genAI: GoogleGenerativeAI;
  private model: string;
  private brainRoot: string;

  constructor(config: Config) {
    this.genAI = new GoogleGenerativeAI(config.geminiApiKey!);
    this.model = config.model;
    this.brainRoot = config.brainRoot;
  }

  async chat(history: ChatMessage[], systemPrompt: string): Promise<string> {
    const model = this.genAI.getGenerativeModel({
      model: this.model,
      systemInstruction: systemPrompt,
      tools: [
        {
          functionDeclarations: toolSchemas as never[],
        },
      ],
    });

    // 마지막 메시지를 제외한 히스토리를 Gemini 형식으로 변환
    const geminiHistory = history.slice(0, -1).map((m) => ({
      role: m.role === "assistant" ? ("model" as const) : ("user" as const),
      parts: [{ text: m.content }],
    }));

    const chat = model.startChat({ history: geminiHistory });
    const lastMessage = history[history.length - 1].content;

    let result = await chat.sendMessage(lastMessage);
    let response = result.response;
    let functionCalls: FunctionCall[] | undefined = response.functionCalls();
    let iterations = 0;

    while (functionCalls && functionCalls.length > 0 && iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      const functionResponses = functionCalls.map((fc) => ({
        functionResponse: {
          name: fc.name,
          response: {
            result: executeTool(
              fc.name,
              fc.args as Record<string, unknown>,
              this.brainRoot,
            ),
          },
        },
      }));

      result = await chat.sendMessage(functionResponses);
      response = result.response;
      functionCalls = response.functionCalls();
    }

    return response.text() || "(응답을 생성하지 못했어요)";
  }
}

// =============================================
// Claude Code (SDK — Max 구독, 추가 비용 0원)
// =============================================

// 중첩 세션 방지: CLAUDECODE 환경변수 제거
const sdkEnv: Record<string, string | undefined> = { ...process.env };
delete sdkEnv.CLAUDECODE;

// CLI 경로 (글로벌 설치 위치)
const CLI_PATH =
  process.env.CLAUDE_CODE_PATH ||
  "C:/Users/ernham/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli.js";

// 도구 분류
const SAFE_TOOLS = new Set([
  "Read", "Glob", "Grep",
  "mcp__brain-tools__brain_recall",
  "mcp__brain-tools__brain_write",
  "mcp__brain-tools__schedule_reminder",
  "mcp__brain-tools__list_reminders",
  "mcp__brain-tools__cancel_reminder",
]);
const APPROVAL_TOOLS = new Set(["Edit", "Write", "Bash"]);

class ClaudeCodeProvider implements ChatProvider {
  private model: string;
  private brainRoot: string;
  private sessionMap: Map<string, string>; // sessionKey → SDK sessionId
  private sessionMapPath: string;
  private approvalService?: ApprovalService;
  private reminderStore?: ReminderStore;

  constructor(config: Config) {
    this.model = config.model;
    this.brainRoot = config.brainRoot;
    this.sessionMapPath = path.join(config.sessionDir, "sdk-sessions.json");
    this.sessionMap = this.loadSessionMap();
  }

  /** 디스크에서 sessionMap 복원 (봇 재시작 후에도 SDK 세션 유지) */
  private loadSessionMap(): Map<string, string> {
    try {
      const data = JSON.parse(fs.readFileSync(this.sessionMapPath, "utf-8"));
      return new Map(
        Object.entries(data).map(([k, v]) => [k, v as string]),
      );
    } catch {
      return new Map();
    }
  }

  /** sessionMap을 디스크에 저장 */
  private saveSessionMap(): void {
    const obj = Object.fromEntries(this.sessionMap);
    fs.writeFileSync(this.sessionMapPath, JSON.stringify(obj, null, 2), "utf-8");
  }

  /** 대화 히스토리를 prompt 문자열로 포맷 (최근 20개 메시지, 개별 500자 제한) */
  private formatHistoryPrompt(history: ChatMessage[], lastUserMsg: string): string {
    const previous = history.slice(0, -1); // 마지막 메시지(=현재 사용자 메시지) 제외
    if (previous.length === 0) return lastUserMsg;

    const recent = previous.slice(-20); // 최근 10턴
    const lines = recent.map((m) => {
      const speaker = m.role === "user" ? "이사님" : "클로";
      const text = m.content.length > 500
        ? m.content.slice(0, 500) + "…(생략)"
        : m.content;
      return `[${speaker}] ${text}`;
    });

    return `## 이전 대화 기록\n\n${lines.join("\n\n")}\n\n---\n\n## 이사님의 현재 메시지\n\n${lastUserMsg}`;
  }

  /** query()마다 새 MCP 서버 인스턴스 생성 (재사용 시 "Already connected" 에러 발생) */
  private createBrainMcp(): ReturnType<typeof createSdkMcpServer> {
    return createSdkMcpServer({
      name: "brain-tools",
      tools: [
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
                text: executeTool("brain_recall", args, this.brainRoot),
              },
            ],
          }),
        ),
        tool(
          "brain_write",
          "Brain 장기기억에 새로운 기억을 저장합니다.",
          {
            intent: z.string().describe("Intent JSON 문자열"),
          },
          async (args) => ({
            content: [
              {
                type: "text" as const,
                text: executeTool("brain_write", args, this.brainRoot),
              },
            ],
          }),
        ),
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
  ): Promise<string> {
    const lastUserMsg = history.filter((m) => m.role === "user").pop();
    if (!lastUserMsg) return "(메시지가 없어요)";

    const sKey = sessionKey || (chatId ? `${chatId}` : undefined);
    const sessionId = sKey ? this.sessionMap.get(sKey) : undefined;
    const startTime = Date.now();
    const approval = this.approvalService;
    // sessionKey에서 userId 추출 (그룹: "userId_chatId" → userId)
    const requesterId = sessionKey?.includes("_")
      ? Number(sessionKey.split("_")[0])
      : undefined;

    // 대화 히스토리를 prompt에 포함 (SDK는 messages 배열 미지원)
    const prompt = this.formatHistoryPrompt(history, lastUserMsg.content);

    const response = query({
      prompt,
      options: {
        systemPrompt,
        model: this.model,
        tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebSearch", "WebFetch"],
        mcpServers: { "brain-tools": this.createBrainMcp() },
        allowedTools: [
          "Read", "Glob", "Grep", "WebSearch", "WebFetch",
          "mcp__brain-tools__brain_recall",
          "mcp__brain-tools__brain_write",
          "mcp__brain-tools__schedule_reminder",
          "mcp__brain-tools__list_reminders",
          "mcp__brain-tools__cancel_reminder",
          "mcp__brain-tools__get_weather",
        ],
        canUseTool: async (toolName, input) => {
          // 안전한 도구는 allowedTools로 자동 허용됨 → 여기까지 안 옴
          // 승인 필요 도구만 이 콜백에 도달
          if (APPROVAL_TOOLS.has(toolName) && approval && chatId) {
            console.log(`[Clo] 승인 요청: ${toolName}`);
            const approved = await approval.requestApproval(
              chatId,
              toolName,
              input as Record<string, unknown>,
              requesterId,
            );
            // updatedInput 필수 — SDK Zod 스키마가 .optional() 없이 정의됨
            // (TypeScript 타입은 optional이지만 런타임 Zod 검증은 required)
            return approved
              ? { behavior: "allow" as const, updatedInput: input as Record<string, unknown> }
              : { behavior: "deny" as const, message: "이사님이 거부했어요" };
          }
          return { behavior: "deny" as const, message: "허용되지 않은 도구" };
        },
        permissionMode: "default",
        maxTurns: 25,
        cwd: "C:/Projects",
        additionalDirectories: [this.brainRoot],
        thinking: { type: "disabled" },
        effort: "medium",
        persistSession: true,
        settingSources: [], // 설정 파일 로딩 건너뛰기 (속도 향상)
        pathToClaudeCodeExecutable: CLI_PATH,
        env: sdkEnv,
        ...(sessionId ? { resume: sessionId } : {}),
      },
    });

    let finalResult = "";
    let partialText = ""; // error_max_turns 시 부분 응답 추출용
    try {
      for await (const message of response) {
        // 모든 메시지 타입 로깅 (도구 실행 에러 디버깅용)
        const msgType = `${message.type}/${(message as Record<string, unknown>).subtype || ""}`;
        if (message.type !== "assistant" && message.type !== "result") {
          console.log(`[Clo] SDK msg: ${msgType}`, JSON.stringify(message).slice(0, 300));
        }

        // assistant 메시지에서 텍스트 수집 + 도구 사용 로깅
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text") {
              partialText = block.text;
            } else if (block.type === "tool_use") {
              console.log(`[Clo] tool_use: ${block.name}`, JSON.stringify(block.input).slice(0, 200));
            } else {
              console.log(`[Clo] content block: ${block.type}`);
            }
          }
        }

        if (message.type === "result") {
          if (message.subtype === "success") {
            finalResult = message.result;
          } else {
            // 에러 상세 로그
            const err = message as Record<string, unknown>;
            console.error(
              `[Clo] SDK 에러: ${message.subtype}`,
              JSON.stringify(err.errors || err.stop_reason || ""),
            );
            // error_max_turns 시 부분 응답 사용
            if (message.subtype === "error_max_turns" && partialText) {
              console.log("[Clo] max_turns 도달 — 부분 응답 사용");
              finalResult = partialText;
            }
            // resume 실패 시 세션 초기화하고 재시도
            else if (sKey && sessionId) {
              console.log("[Clo] 세션 초기화 후 재시도...");
              this.sessionMap.delete(sKey);
              this.saveSessionMap();
              return this.chat(history, systemPrompt, chatId, sessionKey);
            }
          }
          if (sKey && message.session_id) {
            this.sessionMap.set(sKey, message.session_id);
            this.saveSessionMap();
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Clo] SDK 예외: ${msg}`);
      // resume 실패 시 세션 초기화하고 재시도
      if (sKey && sessionId) {
        console.log("[Clo] 세션 초기화 후 재시도...");
        this.sessionMap.delete(sKey);
        this.saveSessionMap();
        return this.chat(history, systemPrompt, chatId, sessionKey);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Clo] SDK 응답 완료 (${elapsed}초)`);

    return finalResult || "(응답을 생성하지 못했어요)";
  }

  resetSession(chatId: number, sessionKey?: string): void {
    const sKey = sessionKey || `${chatId}`;
    this.sessionMap.delete(sKey);
    this.saveSessionMap();
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
    case "gemini":
      return new GeminiProvider(config);
    case "claude-code":
      return new ClaudeCodeProvider(config);
    default:
      throw new Error(`지원하지 않는 프로바이더: ${config.provider}`);
  }
}
