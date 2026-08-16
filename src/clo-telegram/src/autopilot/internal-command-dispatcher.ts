import type { DelegatedTask, DelegatedTaskStore } from "../delegated-task-store.js";
import type { AutopilotStateStore, PendingAutopilotAction } from "./autopilot-state-store.js";
import { isExplicitDevHandoffRequest, isExplicitMemoryWriteRequest, isExplicitTaskStatusRequest } from "./intent-router.js";
import type { ActionDecision, AutopilotContext, IntentDecision } from "./types.js";

export interface InternalCommandDispatcherOptions {
  delegatedTaskStore: DelegatedTaskStore;
  startMeeting?: (chatId: number, argsText: string) => Promise<string>;
  endMeeting?: (chatId: number, summaryMode: "fast" | "precise" | "none") => Promise<string>;
  recall?: (goal: string, topK?: number) => string | Promise<string>;
  stateStore?: AutopilotStateStore;
  cancelTasks?: (chatId: number) => Promise<string> | string;
  writeMemoryCandidate?: (pendingAction: PendingAutopilotAction, userId?: number) => Promise<string> | string;
  devHandoff?: (pendingAction: PendingAutopilotAction, userId?: number) => Promise<string> | string;
}

export interface DispatchInput {
  text: string;
  intent: IntentDecision;
  action: ActionDecision;
  context: AutopilotContext;
}

export interface DispatchResult {
  handled: boolean;
  response?: string;
  replyMarkup?: {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
}

export class InternalCommandDispatcher {
  constructor(private readonly options: InternalCommandDispatcherOptions) {}

  async execute(input: DispatchInput): Promise<DispatchResult> {
    if (input.action.mode === "ASK") {

      if (input.intent.intent === "dev_handoff" && !isExplicitDevHandoffRequest(input.text)) {
        return { handled: false };
      }
      if (!this.options.stateStore) return { handled: false };
      const pendingAction = this.options.stateStore.createPendingAction({
        chatId: input.context.chatId,
        ...(input.context.messageId !== undefined ? { sourceMessageId: input.context.messageId } : {}),
        ...(input.context.userId !== undefined ? { userId: input.context.userId } : {}),
        intent: input.intent.intent,
        text: input.text,
        entities: input.intent.entities,
      });
      return {
        handled: true,
        response: formatAskResponse(input.intent, pendingAction.pendingActionId),
        replyMarkup: {
          inline_keyboard: [[
            { text: "✅ 승인", callback_data: `autopilot_approve_${pendingAction.pendingActionId}` },
            { text: "❌ 거절", callback_data: `autopilot_reject_${pendingAction.pendingActionId}` },
          ]],
        },
      };
    }

    if (input.action.mode !== "AUTO") return { handled: false };

    if (input.intent.intent === "task_status") {
      if (!isExplicitTaskStatusRequest(input.text)) return { handled: false };
      const tasks = this.options.delegatedTaskStore.listByChat(input.context.chatId, 5);
      return { handled: true, response: formatDelegatedTaskList(tasks) };
    }

    if (input.intent.intent === "meeting_start" && this.options.startMeeting) {
      const argsText = extractMeetingStartArgs(input.text);
      return {
        handled: true,
        response: await this.options.startMeeting(input.context.chatId, argsText),
      };
    }

    if (input.intent.intent === "meeting_end" && this.options.endMeeting) {
      const summaryMode = input.intent.entities.summaryMode === "precise"
        ? "precise"
        : input.intent.entities.summaryMode === "none"
          ? "none"
          : "fast";
      return {
        handled: true,
        response: await this.options.endMeeting(input.context.chatId, summaryMode),
      };
    }

    if (input.intent.intent === "meeting_summary" && this.options.recall) {
      const recall = await this.options.recall(`최근 회의 회의록 결정사항 액션아이템 ${input.text}`, 5);
      return {
        handled: true,
        response: formatRecallResponse("최근 회의 관련 기억", recall),
      };
    }

    if (input.intent.intent === "memory_recall" && this.options.recall) {
      const goal = input.intent.entities.goal || input.text;
      const recall = await this.options.recall(goal, 5);
      return {
        handled: true,
        response: formatRecallResponse("Brain에서 확인한 기억", recall),
      };
    }

    if (input.intent.intent === "memory_write_candidate" && this.options.writeMemoryCandidate) {
      if (!isExplicitMemoryWriteRequest(input.text)) return { handled: false };
      const pendingAction = buildImmediateMemoryAction(input);
      const response = await this.options.writeMemoryCandidate(pendingAction, input.context.userId);
      return { handled: true, response };
    }

    return { handled: false };
  }

  async resolvePendingAction(pendingActionId: string, approved: boolean, userId?: number): Promise<string> {
    if (!this.options.stateStore) return "Autopilot 상태 저장소가 준비되지 않았어요.";

    const pendingAction = this.options.stateStore.getPendingAction(pendingActionId);
    if (!pendingAction) return "이미 처리됐거나 만료된 요청이에요.";
    if (pendingAction.status !== "pending") return "이미 처리된 요청이에요.";
    if (new Date(pendingAction.expiresAt).getTime() <= Date.now()) {
      this.options.stateStore.markPendingAction(pendingActionId, "expired");
      return "시간이 지나 자동 만료된 요청이에요.";
    }

    if (!approved) {
      this.options.stateStore.markPendingAction(pendingActionId, "cancelled");
      return "거절했습니다.";
    }

    if (pendingAction.intent === "privacy_policy_change") {
      const action = pendingAction.entities.action === "disable" ? "disable" : "enable";
      const scope = pendingAction.entities.scope === "once" ? "once" : "chat";
      if (scope === "once") {
        this.options.stateStore.markPendingAction(pendingActionId, "applied");
        return "이번 답변에 한해 개인 기억 사용을 허용했습니다. 다음 응답부터는 다시 기본 정책을 따릅니다.";
      }

      const allowPersonalMemory = action === "enable";
      this.options.stateStore.setChatMemoryPolicy({
        chatId: pendingAction.chatId,
        allowPersonalMemory,
        updatedBy: userId,
      });
      this.options.stateStore.markPendingAction(pendingActionId, "applied");
      return allowPersonalMemory
        ? "이 채팅방에서 개인 기억 사용을 허용했습니다."
        : "이 채팅방에서 개인 기억 사용을 해제했습니다.";
    }

    if (pendingAction.intent === "task_cancel" && this.options.cancelTasks) {
      const response = await this.options.cancelTasks(pendingAction.chatId);
      this.options.stateStore.markPendingAction(pendingActionId, "applied");
      return response;
    }

    if (pendingAction.intent === "memory_write_candidate" && this.options.writeMemoryCandidate) {
      if (!isExplicitMemoryWriteRequest(pendingAction.text)) {
        this.options.stateStore.markPendingAction(pendingActionId, "cancelled");
        return "[SKIP]";
      }
      const response = await this.options.writeMemoryCandidate(pendingAction, userId);
      this.options.stateStore.markPendingAction(pendingActionId, "applied");
      return response;
    }

    if (pendingAction.intent === "dev_handoff" && this.options.devHandoff) {
      const response = await this.options.devHandoff(pendingAction, userId);
      this.options.stateStore.markPendingAction(pendingActionId, "applied");
      return response;
    }

    return "승인했습니다. 하지만 이 요청을 실제 실행할 연결이 아직 준비되지 않았어요.";
  }
}


function buildImmediateMemoryAction(input: DispatchInput): PendingAutopilotAction {
  const now = Date.now();
  return {
    pendingActionId: `auto_direct_${now}_${Math.random().toString(36).slice(2, 8)}`,
    chatId: input.context.chatId,
    ...(input.context.messageId !== undefined ? { sourceMessageId: input.context.messageId } : {}),
    ...(input.context.userId !== undefined ? { userId: input.context.userId } : {}),
    intent: input.intent.intent,
    text: input.text,
    entities: input.intent.entities,
    status: "applied",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now).toISOString(),
  };
}

function formatAskResponse(intent: IntentDecision, pendingActionId: string): string {
  if (intent.intent === "privacy_policy_change") {
    const action = intent.entities.action === "disable" ? "해제" : "허용";
    const scope = intent.entities.scope === "once" ? "이번 답변에만" : "이 채팅방에";
    return [
      `개인 기억 사용 정책 변경은 확인이 필요해요.`,
      `${scope} 개인 기억 사용을 ${action}할까요?`,
      `확인 대기 ID: ${pendingActionId}`,
    ].join("\n");
  }

  if (intent.intent === "task_cancel") {
    return `작업 취소는 확인이 필요해요.\n확인 대기 ID: ${pendingActionId}`;
  }

  if (intent.intent === "memory_write_candidate") {
    return `Brain 장기기억 저장은 확인이 필요해요.\n확인 대기 ID: ${pendingActionId}`;
  }

  if (intent.intent === "dev_handoff") {
    return `개발 세션 위임은 확인이 필요해요.\n확인 대기 ID: ${pendingActionId}`;
  }

  return `확인이 필요한 요청이에요.\n확인 대기 ID: ${pendingActionId}`;
}

export function formatDelegatedTaskList(tasks: DelegatedTask[], now = Date.now()): string {
  if (tasks.length === 0) return "현재 기록된 위임 작업이 없어요.";

  const lines = ["최근 위임 작업"];
  for (const task of tasks) {
    const elapsed = fmtElapsed(now - new Date(task.startedAt).getTime());
    const step = task.currentStep ? ` / ${task.currentStep}` : "";
    lines.push(`- ${formatDelegatedTaskStatus(task.status)} ${task.title} (${elapsed}${step})`);
  }
  return lines.join("\n");
}

export function buildAsyncResearchAutopilotPrompt(userText: string): string {
  return buildAsyncResearchWorkerSignal(userText);
}

export function buildAsyncResearchWorkerSignal(userText: string): string {
  return [
    "접수했습니다. 이 요청은 시간이 걸릴 수 있어 백그라운드 워커로 분리해서 진행하겠습니다.",
    "끝나면 제가 결과를 검수해서 필요한 내용만 보고드리겠습니다.",
    "",
    "[SPAWN_WORKER]",
    "why: 장시간 조사/분석으로 대화 통로를 막지 않기 위함",
    `what: ${makeWorkerTitle(userText)}`,
    "task: 사용자의 요청을 단계적으로 조사/분석하세요. 먼저 brain_recall로 관련 기억을 확인하고, 필요한 Obsidian 문서와 nexus_search로 내부 자료를 조회하세요. 그 결과를 내부 근거로 분리하세요. 부족한 최신성/외부 근거만 WebSearch/WebFetch로 보강한 뒤, Brain/Obsidian/Nexus 근거와 외부 출처를 구분해 최종 결과를 작성하세요.",
    `context: 원문 요청: ${userText}`,
    "[/SPAWN_WORKER]",
  ].join("\n");
}

function fmtElapsed(ms: number): string {
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const s = Math.round(safeMs / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}분` : `${m}분 ${rem}초`;
}

function formatDelegatedTaskStatus(status: DelegatedTask["status"]): string {
  switch (status) {
    case "running": return "진행중";
    case "completed": return "완료";
    case "reviewed": return "검수완료";
    case "failed": return "실패";
    case "cancelled": return "취소";
    case "stale": return "끊김";
  }
}

function makeWorkerTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 60 ? `${normalized.slice(0, 60)}...` : normalized;
}

function extractMeetingStartArgs(text: string): string {
  return text
    .replace(/회의\s*(시작|하자|열어|기록\s*시작)/g, "")
    .replace(/^(시작|하자|열어)\s*/g, "")
    .replace(/\s*(시작|하자|열어)$/g, "")
    .replace(/(지금부터|이제)\s*/g, "")
    .replace(/(미팅|회의)\s*/g, "")
    .trim();
}

function formatRecallResponse(title: string, recall: string): string {
  const trimmed = recall.trim();
  if (!trimmed || trimmed === "관련 기억 없음") {
    return `${title}: 관련 기록을 찾지 못했어요.`;
  }
  return `${title}\n${trimmed}`;
}




