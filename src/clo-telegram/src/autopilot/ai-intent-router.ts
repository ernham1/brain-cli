import type { AutopilotIntent, AutopilotSafety, IntentDecision } from "./types.js";

const VALID_INTENTS: AutopilotIntent[] = [
  "task_status",
  "task_cancel",
  "meeting_start",
  "meeting_end",
  "meeting_summary",
  "memory_recall",
  "memory_write_candidate",
  "async_research",
  "dev_handoff",
  "media_reference",
  "privacy_policy_change",
  "health_check",
  "general_chat",
];

const SAFETY_BY_INTENT: Record<AutopilotIntent, AutopilotSafety> = {
  task_status: "safe_read",
  task_cancel: "needs_confirmation",
  meeting_start: "safe_write",
  meeting_end: "safe_write",
  meeting_summary: "safe_read",
  memory_recall: "safe_read",
  memory_write_candidate: "safe_write",
  async_research: "safe_read",
  dev_handoff: "needs_confirmation",
  media_reference: "safe_read",
  privacy_policy_change: "needs_confirmation",
  health_check: "safe_read",
  general_chat: "pass_to_llm",
};

export interface AiIntentRouterInput {
  text: string;
  heuristicDecision: IntentDecision;
  isGroup: boolean;
  isMentioned: boolean;
}

export const AI_INTENT_ROUTER_SYSTEM_PROMPT = [
  "당신은 텔레그램 봇의 라우팅 판정기입니다.",
  "사용자에게 답하지 말고 내부 의도 JSON만 출력하세요.",
  "정규식 결과는 힌트일 뿐이며, 최종 판단은 사용자의 실제 의도와 문맥으로 내립니다.",
  "확실하지 않거나 일반 대화/문서 작성/분석 요청이면 general_chat으로 보냅니다.",
  "memory_write_candidate는 사용자가 기억, 장기기억, Brain, 브레인에 저장하라고 명시할 때만 선택합니다.",
  "문서나 파일을 저장해달라는 요청은 memory_write_candidate가 아닙니다.",
  "코덱스, Codex, VS Code, 개발 세션에 전달/반영/위임/처리하라는 요청은 dev_handoff입니다.",
  "코덱스, 데탑클로, VS Code를 단순히 언급하거나 그들이 수행 중인 작업을 설명하는 문장은 dev_handoff가 아닙니다.",
  "task_status는 현재/최근 위임 작업의 상태, 목록, 진행 여부를 사용자가 명시적으로 물을 때만 선택합니다.",
  "작업 기준, 오케스트레이션 설계, 작업이 완료되면 해야 할 일처럼 절차를 설명하는 문장은 task_status가 아니라 general_chat입니다.",
  "자동 실행보다 오분류 방지가 우선입니다.",
  "출력은 반드시 JSON 객체 하나만 허용됩니다.",
].join("\n");

export function buildAiIntentRouterPrompt(input: AiIntentRouterInput): string {
  return JSON.stringify({
    task: "classify_autopilot_intent",
    validIntents: VALID_INTENTS,
    userText: input.text,
    context: {
      isGroup: input.isGroup,
      isMentioned: input.isMentioned,
    },
    heuristicDecision: input.heuristicDecision,
    requiredOutput: {
      intent: "one of validIntents",
      confidence: "number from 0 to 1",
      reason: "short Korean reason",
      entities: "object of string values",
    },
  }, null, 2);
}

export function parseAiIntentRouterResponse(text: string): IntentDecision | null {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const intent = record.intent;
  if (!isValidIntent(intent)) return null;

  const confidenceValue = typeof record.confidence === "number"
    ? record.confidence
    : typeof record.confidence === "string"
      ? Number(record.confidence)
      : NaN;
  const confidence = Number.isFinite(confidenceValue)
    ? Math.max(0, Math.min(1, confidenceValue))
    : 0.5;

  const entities = normalizeEntities(record.entities);
  return {
    intent,
    confidence,
    safety: SAFETY_BY_INTENT[intent],
    reason: typeof record.reason === "string" && record.reason.trim()
      ? record.reason.trim().slice(0, 200)
      : "AI 라우터 판정",
    entities,
  };
}

export function generalChatDecision(reason: string): IntentDecision {
  return {
    intent: "general_chat",
    confidence: 0.2,
    safety: "pass_to_llm",
    reason,
    entities: {},
  };
}

function isValidIntent(value: unknown): value is AutopilotIntent {
  return typeof value === "string" && VALID_INTENTS.includes(value as AutopilotIntent);
}

function normalizeEntities(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entities: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawValue === "string") entities[key] = rawValue;
    else if (typeof rawValue === "number" || typeof rawValue === "boolean") entities[key] = String(rawValue);
  }
  return entities;
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return extractJsonObject(fenced[1]);

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return null;
}
