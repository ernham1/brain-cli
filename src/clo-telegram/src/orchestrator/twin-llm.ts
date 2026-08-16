import type { TwinVerdict } from "./twin-decider.js";

/**
 * LLM 트윈 확장 (twin-v2-llm): 규칙 트윈(twin-v1)이 에스컬레이션하는 애매 케이스
 * (DP 미매칭/충돌/확신도 낮음/반복 실패)만 LLM에 문의한다.
 *
 * 안전 경계:
 * - 비가역/risk=red/인간 확인 명시는 LLM에 묻지 않는다 (인간 전결, twin-decider가 차단)
 * - LLM 응답은 JSON 계약을 통과해야만 채택. 실패/저확신/허용 외 판정은 전부 에스컬레이션 유지
 * - 반복 실패(EXHAUSTED) 케이스에서 approve는 허용하지 않는다 (게이트 실패 상태의 승인 금지)
 *
 * 구현 참고: 기본 구현은 봇 내장 ChatProvider(1턴, 도구 금지)를 사용한다.
 * BandingAI 전용 트윈 에이전트(P3 완성형)가 생기면 TwinLlmConsult 구현만 교체한다.
 */

export const TWIN_LLM_VERSION = "twin-v2-llm";

export interface TwinLlmCase {
  objective: string;
  instruction: string;
  rawInstruction: string;
  evaluationDecision: string;
  evaluationSummary: string;
  failedGates: string[];
  failedAttempts: number;
  escalationReason: string;
  allowedVerdicts: TwinVerdict[];
  /** 지식팩(DP 문서) 전문 · 에이전트는 input 밖 컨텍스트를 가져올 수 없다 */
  packContent: string;
  packDpIds: string[];
}

export interface TwinLlmOpinion {
  verdict: TwinVerdict;
  rationale: string;
  dpRefs: string[];
  confidence: number;
  /** verdict=reject일 때 재작업 요구사항 (재작업 지시문은 규칙 템플릿이 감싼다) */
  reworkDemands?: string[];
}

export interface TwinLlmConsult {
  /** null = 사용 불가/실패 · 호출자는 규칙 판정(에스컬레이션)을 유지한다 */
  consult(llmCase: TwinLlmCase): Promise<TwinLlmOpinion | null>;
}

/** providers.ts의 ChatProvider와 구조적으로 호환되는 최소 표면 (순환 의존 방지) */
export interface MinimalChatProvider {
  chat(
    history: Array<{ role: "user" | "assistant"; content: string }>,
    systemPrompt: string,
    chatId?: number,
    sessionKey?: string,
    onChunk?: (partialText: string) => void,
    onProgress?: (msg: string) => void,
    opts?: { maxTurns?: number; timeoutMs?: number; disableTools?: boolean; persistSession?: boolean },
  ): Promise<string>;
}

const SYSTEM_PROMPT = [
  "너는 운영자(이사님)의 결정 패턴(DP)을 이식한 결정 트윈이다.",
  "오케스트레이터가 자동으로 결론 내리지 못한 작업 검수 결정을 DP 문서에 근거해 대신 내린다.",
  "원칙: 근거 없는 완료는 인정하지 않는다. 판단이 서지 않으면 escalate를 고른다. 과감한 승인보다 정직한 에스컬레이션이 낫다.",
  "출력은 반드시 JSON 객체 하나만. 마크다운 코드펜스, 설명 문장, 앞뒤 텍스트 금지.",
].join("\n");

export class ProviderTwinLlmConsult implements TwinLlmConsult {
  constructor(
    private readonly provider: MinimalChatProvider,
    private readonly options: { timeoutMs?: number } = {},
  ) {}

  async consult(llmCase: TwinLlmCase): Promise<TwinLlmOpinion | null> {
    const timeoutMs = this.options.timeoutMs ?? 90_000;
    const prompt = buildPrompt(llmCase);
    let raw: string;
    try {
      raw = await withTimeout(
        this.provider.chat(
          [{ role: "user", content: prompt }],
          SYSTEM_PROMPT,
          undefined,
          "twin-llm",
          undefined,
          undefined,
          { maxTurns: 1, timeoutMs, disableTools: true, persistSession: false },
        ),
        timeoutMs + 5_000,
      );
    } catch (err) {
      console.error("[TwinLLM] 판정 호출 실패:", err instanceof Error ? err.message : err);
      return null;
    }
    return parseOpinion(raw, llmCase);
  }
}

function buildPrompt(llmCase: TwinLlmCase): string {
  return [
    "[목적] 아래 작업 검수 결정을 규칙 트윈이 자동으로 내리지 못했다. DP 문서에 근거해 판정을 내려라.",
    `[규칙 트윈이 넘긴 사유] ${llmCase.escalationReason}`,
    "",
    "<decision-pattern-document>",
    llmCase.packContent,
    "</decision-pattern-document>",
    "",
    "<case>",
    `작업 목표: ${llmCase.objective}`,
    `원 지시: ${llmCase.rawInstruction}`,
    `평가 결과: ${llmCase.evaluationDecision} · ${llmCase.evaluationSummary}`,
    `실패 게이트: ${llmCase.failedGates.join(", ") || "없음"}`,
    `실패 시도 횟수: ${llmCase.failedAttempts}`,
    "</case>",
    "",
    `[허용 판정] ${llmCase.allowedVerdicts.join(" | ")} (이 목록 밖 판정 금지)`,
    "[성공 기준] 판정은 반드시 DP 문서의 패턴을 인용해야 한다 (dpRefs). 인용할 DP가 없으면 escalate.",
    "확신이 0.7 미만이면 escalate를 골라라. 추측하지 말 것.",
    "",
    "[산출물] 아래 형식의 JSON 객체 1개만 출력:",
    `{"verdict":"approve|reject|escalate","rationale":"판정 근거 한두 문장(한국어)","dpRefs":["DP-###"],"confidence":0.0~1.0,"reworkDemands":["reject일 때 재작업 요구사항 1~4개(한국어)"]}`,
  ].join("\n");
}

export function parseOpinion(raw: string, llmCase: TwinLlmCase): TwinLlmOpinion | null {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    return null;
  }

  const verdict = parsed.verdict;
  if (verdict !== "approve" && verdict !== "reject" && verdict !== "escalate") return null;
  if (!llmCase.allowedVerdicts.includes(verdict)) return null;

  const confidence = typeof parsed.confidence === "number" ? parsed.confidence : NaN;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;

  const rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
  if (!rationale) return null;

  const packIds = new Set(llmCase.packDpIds);
  const dpRefs = Array.isArray(parsed.dpRefs)
    ? parsed.dpRefs.filter((ref): ref is string => typeof ref === "string" && packIds.has(ref))
    : [];

  const reworkDemands = Array.isArray(parsed.reworkDemands)
    ? parsed.reworkDemands
      .filter((demand): demand is string => typeof demand === "string" && demand.trim().length > 0)
      .map((demand) => demand.trim().slice(0, 200))
      .slice(0, 4)
    : [];

  return {
    verdict,
    rationale: rationale.slice(0, 400),
    dpRefs: Array.from(new Set(dpRefs)),
    confidence,
    ...(reworkDemands.length > 0 ? { reworkDemands } : {}),
  };
}

/** 응답에서 첫 JSON 객체를 추출 (코드펜스/앞뒤 잡음 허용) */
function extractJsonObject(raw: string): string | null {
  const text = raw.trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`twin-llm timeout ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
