import type { ActionDecision, IntentDecision } from "./types.js";

const AUTO_INTENTS = new Set<IntentDecision["intent"]>([
  "task_status",
  "meeting_start",
  "meeting_end",
  "meeting_summary",
  "memory_recall",
  "memory_write_candidate",
  "media_reference",
  "health_check",
  "async_research",
]);

const ASK_INTENTS = new Set<IntentDecision["intent"]>([
  "task_cancel",
  "dev_handoff",
  "privacy_policy_change",
]);

export class ActionPolicy {
  decide(decision: IntentDecision): ActionDecision {
    if (decision.intent === "general_chat" || decision.safety === "pass_to_llm") {
      return {
        mode: "PASS",
        intent: decision.intent,
        reason: decision.reason,
        requiresConfirmation: false,
      };
    }

    if (decision.confidence < 0.7) {
      return {
        mode: "PASS",
        intent: decision.intent,
        reason: `확신도 부족: ${decision.confidence}`,
        requiresConfirmation: false,
      };
    }

    if (ASK_INTENTS.has(decision.intent) || decision.safety === "needs_confirmation") {
      return {
        mode: "ASK",
        intent: decision.intent,
        reason: decision.reason,
        requiresConfirmation: true,
      };
    }

    if (AUTO_INTENTS.has(decision.intent)) {
      return {
        mode: "AUTO",
        intent: decision.intent,
        reason: decision.reason,
        requiresConfirmation: false,
      };
    }

    return {
      mode: "PASS",
      intent: decision.intent,
      reason: "정책에 없는 intent",
      requiresConfirmation: false,
    };
  }
}


