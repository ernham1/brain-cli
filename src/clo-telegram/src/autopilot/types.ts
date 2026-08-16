export type AutopilotIntent =
  | "task_status"
  | "task_cancel"
  | "meeting_start"
  | "meeting_end"
  | "meeting_summary"
  | "memory_recall"
  | "memory_write_candidate"
  | "async_research"
  | "dev_handoff"
  | "media_reference"
  | "privacy_policy_change"
  | "health_check"
  | "general_chat";

export type AutopilotSafety = "safe_read" | "safe_write" | "needs_confirmation" | "pass_to_llm";
export type AutopilotMode = "AUTO" | "ASK" | "PASS";

export interface IntentDecision {
  intent: AutopilotIntent;
  confidence: number;
  safety: AutopilotSafety;
  reason: string;
  entities: Record<string, string>;
}

export interface ActionDecision {
  mode: AutopilotMode;
  intent: AutopilotIntent;
  reason: string;
  requiresConfirmation: boolean;
}

export interface AutopilotContext {
  chatId: number;
  messageId?: number;
  userId?: number;
  isGroup: boolean;
  isMentioned: boolean;
}
