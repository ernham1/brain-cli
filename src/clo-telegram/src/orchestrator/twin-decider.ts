import crypto from "node:crypto";
import fs from "node:fs";
import type { EvaluationRunResult } from "./evaluation-runner.js";
import { TWIN_LLM_VERSION, type TwinLlmConsult } from "./twin-llm.js";
import type { OrchestratorTask } from "./types.js";

/**
 * 트윈 결정자 (twin-v1): 이사님 전역 Decision Pattern(DP)을 규칙으로 이식한
 * 결정적(deterministic) 판정기. ASK/REVIEW_NEEDED가 텔레그램으로 푸시되기 전에
 * 1차 결정을 내리고, 에스컬레이션 조건이면 기존 결정 요청서 푸시로 폴백한다.
 *
 * 판정 근거의 정본은 지식팩 파일(전역 decisions.md)이며, 모든 판정은
 * twinVersion + knowledgePackHash를 남겨 역추적 가능해야 한다 (결정 저널 계약).
 */

export type TwinVerdict = "approve" | "reject" | "escalate";

export type IrreversibleClass =
  | "deploy"
  | "delete"
  | "external-send"
  | "financial"
  | "personnel"
  | "external-commitment";

export interface TwinDecision {
  twinVersion: string;
  knowledgePackHash: string;
  verdict: TwinVerdict;
  rationale: string;
  dpRefs: string[];
  confidence: number;
  irreversible: boolean;
  irreversibleClass: IrreversibleClass | null;
  /** verdict=reject일 때 재작업 지시문 */
  reworkInstruction?: string;
  /** verdict=escalate일 때 사유 */
  escalationReason?: string;
  latencyMs: number;
}

export interface IrreversibleScan {
  irreversibleClass: IrreversibleClass;
  matchedText: string;
}

export const TWIN_VERSION = "twin-v1";
export const DEFAULT_KNOWLEDGE_PACK_PATH = "D:/Projects/.clo-global/decisions.md";
const DEFAULT_MIN_CONFIDENCE = 0.6;

interface KnowledgePack {
  hash: string;
  dpIds: Set<string>;
  mtimeMs: number;
  content: string;
}

/** LLM 트윈에 문의 가능한 에스컬레이션 사유 (하드 가드 3종은 절대 포함 금지) */
const LLM_CONSULTABLE_REASONS = new Set(["no-dp-match", "dp-conflict", "dp-not-in-pack", "low-confidence"]);

interface RuleCandidate {
  rule: string;
  verdict: TwinVerdict;
  dpRefs: string[];
  confidence: number;
  rationale: string;
  reworkInstruction?: string;
}

// 비가역 6종 감지 (결정 저널 스키마 enum과 동일 어휘).
// 지시/목표 텍스트 기준. 과탐(over-escalation)은 허용, 미탐이 더 위험하다.
const IRREVERSIBLE_PATTERNS: Array<{ cls: IrreversibleClass; pattern: RegExp }> = [
  { cls: "delete", pattern: /삭제|지우고|드랍|rm\s+-rf|drop\s+table|truncate|폐기 처리/i },
  { cls: "deploy", pattern: /배포|디플로이|deploy|release\b|프로덕션 반영|publish/i },
  { cls: "external-send", pattern: /발송|메일 전송|메일 보내|공지 전송|보도자료|대외 공개|외부 전송/i },
  { cls: "financial", pattern: /결제|과금|송금|환불|구매 진행|비용 지출/i },
  { cls: "personnel", pattern: /채용 확정|해고|인사 발령/i },
  { cls: "external-commitment", pattern: /계약 체결|견적 발송|제안서 제출|납기 약속/i },
];

const OWNER_REVIEW_PATTERNS = [/이사님\s*확인/, /사람\s*확인/, /수동\s*검토/, /승인\s*필요/];

/** 비가역 신호 스캔: 지시문/목표만 본다 (워커 보고 텍스트는 오탐이 많아 v1에서 제외). */
export function scanIrreversible(task: OrchestratorTask): IrreversibleScan | null {
  const text = [task.instruction, task.objective, task.ownerDirectives.rawInstruction].join("\n");
  for (const { cls, pattern } of IRREVERSIBLE_PATTERNS) {
    const match = text.match(pattern);
    if (match) return { irreversibleClass: cls, matchedText: match[0] };
  }
  return null;
}

export class TwinDecider {
  private cachedPack: KnowledgePack | null = null;

  constructor(
    private readonly options: {
      knowledgePackPath?: string;
      minConfidence?: number;
      /** 애매 케이스 LLM 문의 (없으면 규칙 판정만) */
      llmConsult?: TwinLlmConsult;
      llmMinConfidence?: number;
    } = {},
  ) {}

  get knowledgePackPath(): string {
    return this.options.knowledgePackPath ?? DEFAULT_KNOWLEDGE_PACK_PATH;
  }

  /**
   * 지식팩 로드 (mtime 캐시). 로드 불가면 null · 호출자는 twin:null로 저널에 남기고
   * 에스컬레이션한다 (부재도 명시적으로 기록, DP-012).
   */
  loadKnowledgePack(): KnowledgePack | null {
    try {
      const stat = fs.statSync(this.knowledgePackPath);
      if (this.cachedPack && this.cachedPack.mtimeMs === stat.mtimeMs) return this.cachedPack;
      const content = fs.readFileSync(this.knowledgePackPath, "utf-8");
      const dpIds = new Set<string>();
      for (const match of content.matchAll(/\[(DP-[0-9]{3})\]/g)) dpIds.add(match[1]!);
      if (dpIds.size === 0) return null;
      this.cachedPack = {
        hash: crypto.createHash("sha256").update(content).digest("hex"),
        dpIds,
        mtimeMs: stat.mtimeMs,
        content,
      };
      return this.cachedPack;
    } catch {
      return null;
    }
  }

  /**
   * ASK/REVIEW_NEEDED 평가 결과에 대한 트윈 판정.
   * null 반환 = 트윈 실행 불가(지식팩 부재) · 호출자가 에스컬레이션 폴백.
   */
  decide(task: OrchestratorTask, evaluation: EvaluationRunResult): TwinDecision | null {
    const startedAt = Date.now();
    const pack = this.loadKnowledgePack();
    if (!pack) return null;

    const finish = (partial: Omit<TwinDecision, "twinVersion" | "knowledgePackHash" | "latencyMs">): TwinDecision => ({
      twinVersion: TWIN_VERSION,
      knowledgePackHash: pack.hash,
      latencyMs: Date.now() - startedAt,
      ...partial,
    });

    // --- 에스컬레이션 선행 조건 (트윈이 결정하지 않는 예외) ---

    const irreversible = scanIrreversible(task);
    if (irreversible) {
      return finish({
        verdict: "escalate",
        rationale: `비가역 신호 감지("${irreversible.matchedText}" → ${irreversible.irreversibleClass}). 비가역 결정은 인간 전결.`,
        dpRefs: filterDpRefs(["DP-013", "DP-020"], pack),
        confidence: 1,
        irreversible: true,
        irreversibleClass: irreversible.irreversibleClass,
        escalationReason: "irreversible",
      });
    }

    if (task.riskLevel === "red" || evaluation.failedRequiredGates.some((gate) => gate.kind === "risk")) {
      return finish({
        verdict: "escalate",
        rationale: "risk=red 또는 risk 게이트 실패. 위험 감수는 명시 승인 대상.",
        dpRefs: [],
        confidence: 1,
        irreversible: false,
        irreversibleClass: null,
        escalationReason: "risk-red",
      });
    }

    if (requiresOwnerReview(task)) {
      return finish({
        verdict: "escalate",
        rationale: "성공 기준에 이사님(인간) 확인이 명시되어 있어 트윈이 대신 결정하지 않음.",
        dpRefs: [],
        confidence: 1,
        irreversible: false,
        irreversibleClass: null,
        escalationReason: "owner-review-required",
      });
    }

    // --- 규칙 매칭 (twin-v1 결정 규칙) ---

    const candidates = this.matchRules(task, evaluation, pack);

    if (candidates.length === 0) {
      return finish({
        verdict: "escalate",
        rationale: "적용 가능한 DP 규칙이 없음. 판단을 인간에게 넘김.",
        dpRefs: [],
        confidence: 0,
        irreversible: false,
        irreversibleClass: null,
        escalationReason: "no-dp-match",
      });
    }

    // 규칙이 명시적으로 에스컬레이션을 요구하면 충돌 판정보다 우선한다
    const escalateCandidates = candidates.filter((candidate) => candidate.verdict === "escalate");
    if (escalateCandidates.length > 0) {
      const mergedEscalate = mergeCandidates(escalateCandidates);
      return finish({
        verdict: "escalate",
        rationale: mergedEscalate.rationale,
        dpRefs: filterDpRefs(mergedEscalate.dpRefs, pack),
        confidence: mergedEscalate.confidence,
        irreversible: false,
        irreversibleClass: null,
        escalationReason: mergedEscalate.rule,
      });
    }

    const verdicts = new Set(candidates.map((candidate) => candidate.verdict));
    if (verdicts.size > 1) {
      return finish({
        verdict: "escalate",
        rationale: `DP 충돌: ${candidates.map((c) => `${c.rule}(${c.verdict})`).join(" vs ")}. 상충 시 인간 전결.`,
        dpRefs: filterDpRefs(candidates.flatMap((c) => c.dpRefs), pack),
        confidence: 0,
        irreversible: false,
        irreversibleClass: null,
        escalationReason: "dp-conflict",
      });
    }

    const merged = mergeCandidates(candidates);
    const dpRefs = filterDpRefs(merged.dpRefs, pack);
    const minConfidence = this.options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

    if (dpRefs.length === 0 || merged.confidence < minConfidence) {
      return finish({
        verdict: "escalate",
        rationale: dpRefs.length === 0
          ? `근거 DP(${merged.dpRefs.join(", ")})가 현재 지식팩에 없음. 판단을 인간에게 넘김.`
          : `확신도 ${merged.confidence} < 기준 ${minConfidence}. 판단을 인간에게 넘김.`,
        dpRefs,
        confidence: merged.confidence,
        irreversible: false,
        irreversibleClass: null,
        escalationReason: dpRefs.length === 0 ? "dp-not-in-pack" : "low-confidence",
      });
    }

    return finish({
      verdict: merged.verdict,
      rationale: merged.rationale,
      dpRefs,
      confidence: merged.confidence,
      irreversible: false,
      irreversibleClass: null,
      ...(merged.reworkInstruction ? { reworkInstruction: merged.reworkInstruction } : {}),
    });
  }

  /**
   * 규칙 판정 + 애매 케이스 LLM 문의 (twin-v2-llm).
   * LLM은 규칙 트윈이 no-dp-match/dp-conflict/low-confidence/반복실패로
   * 에스컬레이션한 경우에만 개입한다. 하드 가드(비가역/risk/인간확인)는 절대 문의하지 않는다.
   * LLM 실패/저확신/계약 위반 시 규칙 판정(에스컬레이션)을 그대로 유지한다.
   */
  async decideWithLlm(task: OrchestratorTask, evaluation: EvaluationRunResult): Promise<TwinDecision | null> {
    const ruleDecision = this.decide(task, evaluation);
    const llm = this.options.llmConsult;
    if (!ruleDecision || ruleDecision.verdict !== "escalate" || !llm) return ruleDecision;

    const reason = ruleDecision.escalationReason ?? "";
    const isExhausted = reason.includes("EXHAUSTED");
    if (!LLM_CONSULTABLE_REASONS.has(reason) && !isExhausted) return ruleDecision;

    const pack = this.loadKnowledgePack();
    if (!pack) return ruleDecision;

    const startedAt = Date.now();
    // 반복 실패 상태에서 승인은 허용하지 않는다 (게이트 실패 중 승인 금지)
    const allowedVerdicts: TwinVerdict[] = isExhausted ? ["reject", "escalate"] : ["approve", "reject", "escalate"];
    let opinion;
    try {
      opinion = await llm.consult({
        objective: task.objective,
        instruction: task.instruction,
        rawInstruction: task.ownerDirectives.rawInstruction,
        evaluationDecision: evaluation.decision,
        evaluationSummary: evaluation.summary,
        failedGates: evaluation.failedRequiredGates.map((gate) => gate.kind),
        failedAttempts: task.attempts.filter((attempt) => attempt.status === "failed").length,
        escalationReason: reason,
        allowedVerdicts,
        packContent: pack.content,
        packDpIds: [...pack.dpIds],
      });
    } catch (err) {
      console.error("[TwinLLM] consult 오류 · 규칙 에스컬레이션 유지:", err instanceof Error ? err.message : err);
      return ruleDecision;
    }

    if (!opinion) return ruleDecision;
    // consult 구현을 신뢰하지 않는다: 허용 판정 밖이면 규칙 에스컬레이션 유지 (방어선 중복)
    if (!allowedVerdicts.includes(opinion.verdict)) return ruleDecision;
    if (opinion.verdict === "escalate") {
      return {
        ...ruleDecision,
        rationale: `${ruleDecision.rationale} / LLM 판정도 에스컬레이션: ${opinion.rationale}`,
      };
    }

    const llmMinConfidence = this.options.llmMinConfidence ?? 0.7;
    const dpRefs = filterDpRefs(opinion.dpRefs, pack);
    if (opinion.confidence < llmMinConfidence || dpRefs.length === 0) return ruleDecision;
    if (opinion.verdict === "reject" && (!opinion.reworkDemands || opinion.reworkDemands.length === 0)) {
      return ruleDecision;
    }

    return {
      twinVersion: TWIN_LLM_VERSION,
      knowledgePackHash: pack.hash,
      verdict: opinion.verdict,
      rationale: `[LLM 판정] ${opinion.rationale} (규칙 트윈 이관 사유: ${reason})`,
      dpRefs,
      confidence: opinion.confidence,
      irreversible: false,
      irreversibleClass: null,
      ...(opinion.verdict === "reject"
        ? { reworkInstruction: buildTwinReworkInstruction(task, evaluation, opinion.reworkDemands!) }
        : {}),
      latencyMs: ruleDecision.latencyMs + (Date.now() - startedAt),
    };
  }

  private matchRules(
    task: OrchestratorTask,
    evaluation: EvaluationRunResult,
    _pack: KnowledgePack,
  ): RuleCandidate[] {
    const candidates: RuleCandidate[] = [];
    const failedGates = evaluation.failedRequiredGates;
    const envMissing = (gate: (typeof failedGates)[number]): boolean =>
      gate.errors.some((error) => error.includes("environment_missing"))
      || gate.summary.includes("environment_missing");
    const hasEnvMissing = failedGates.some(envMissing);
    const nonEnvFailedGates = failedGates.filter((gate) => !envMissing(gate));
    const hasConcreteReport = task.artifacts.some((artifact) => artifact.description.trim().length > 0);
    // 트윈 재작업 무한 루프 방지: 실패 이력이 이미 있으면 반복 재작업 대신 에스컬레이션.
    // (environment_missing처럼 재작업으로 해소될 수 없는 실패가 존재하기 때문)
    const failedAttempts = task.attempts.filter((attempt) => attempt.status === "failed").length;
    const maxAttempts = task.evaluationPlan.reworkPolicy.maxAttempts;

    // R-EVIDENCE: 완료 주장에 구체 근거 없음 → 근거 없이 인정 금지 (DP-004 동작 우선, DP-009 전수 검증)
    if (evaluation.decision === "REVIEW_NEEDED" && !hasConcreteReport) {
      if (failedAttempts > 0) {
        candidates.push({
          rule: "R-EVIDENCE-EXHAUSTED",
          verdict: "escalate",
          dpRefs: ["DP-004"],
          confidence: 1,
          rationale: `재작업 후에도 완료 근거가 없음 (실패 ${failedAttempts}회). 반복 재작업 대신 인간 판단으로 넘김.`,
        });
      } else {
        candidates.push({
          rule: "R-EVIDENCE",
          verdict: "reject",
          dpRefs: ["DP-004", "DP-009"],
          confidence: 0.85,
          rationale: "완료 보고에 구체 근거가 없음. 근거 없는 완료는 인정하지 않고 증거를 요구한다.",
          reworkInstruction: buildTwinReworkInstruction(task, evaluation, [
            "완료 주장 대신 실행 근거를 제출할 것: 변경 파일 목록, 실행한 검증 명령과 출력, 남은 이슈.",
            "검증 없이 완료 보고 금지 (빌드 통과만으로는 불충분).",
          ]),
        });
      }
    }

    // R-ENV: 자동 검증 환경 부재 → 보고만 믿고 승인하지 않고 직접 실행 증거 요구 (DP-004, DP-018 풀 재실행)
    // 환경 부재는 재작업으로 해소되지 않으므로 트윈 재작업은 1회만 허용한다.
    if (evaluation.decision === "ASK" && hasEnvMissing) {
      if (failedAttempts > 0) {
        candidates.push({
          rule: "R-ENV-EXHAUSTED",
          verdict: "escalate",
          dpRefs: ["DP-004"],
          confidence: 1,
          rationale: `검증 환경 부재 상태에서 재작업 이력이 이미 있음 (실패 ${failedAttempts}회). 인간 판단으로 넘김.`,
        });
      } else {
        candidates.push({
          rule: "R-ENV",
          verdict: "reject",
          dpRefs: ["DP-004", "DP-018"],
          confidence: 0.75,
          rationale: "자동 검증 환경이 연결되지 않음. 문서/보고보다 실행 결과가 우선이므로 직접 실행 증거를 요구한다.",
          reworkInstruction: buildTwinReworkInstruction(task, evaluation, [
            "자동 검증 도구가 없으므로 핵심 경로를 직접 실행하고 명령어+출력 로그를 결과에 첨부할 것.",
            "수정 후에는 부분 확인이 아니라 전체 파이프라인 재실행으로 확인할 것.",
          ]),
        });
      }
    }

    // R-RETRY: 재작업 한도 소진 후에도 게이트 실패 → 같은 접근 반복 금지, 접근 전환 1회 (DP-010, DP-002)
    if (evaluation.decision === "ASK" && nonEnvFailedGates.length > 0) {
      if (failedAttempts > maxAttempts) {
        candidates.push({
          rule: "R-RETRY-EXHAUSTED",
          verdict: "escalate",
          dpRefs: ["DP-010"],
          confidence: 1,
          rationale: `트윈 재작업 포함 ${failedAttempts}회 실패 (자동 한도 ${maxAttempts}회). 반복 실패는 인간 판단 대상.`,
        });
      } else {
        candidates.push({
          rule: "R-RETRY",
          verdict: "reject",
          dpRefs: ["DP-010", "DP-002"],
          confidence: 0.7,
          rationale: "필수 게이트 실패가 반복됨. 같은 접근을 고집하지 말고 다른 접근으로 전환해 1회 더 시도시킨다.",
          reworkInstruction: buildTwinReworkInstruction(task, evaluation, [
            "직전 시도와 같은 접근을 반복하지 말 것. 막힌 지점을 명시하고 다른 접근으로 전환할 것.",
            "실패 원인을 삼키지 말고 오류 전문을 결과에 포함할 것.",
          ]),
        });
      }
    }

    // R-APPROVE: 게이트 전수 통과 + 구체 보고 존재(light 프로필 등으로 자율승인 제외된 경우)
    //            → 되묻지 않고 완료 인정 (DP-003 체감 우선, DP-008 되묻기보다 실행)
    if (
      evaluation.decision === "REVIEW_NEEDED"
      && hasConcreteReport
      && failedGates.length === 0
      && evaluation.failedLockedCriteria.length === 0
    ) {
      candidates.push({
        rule: "R-APPROVE",
        verdict: "approve",
        dpRefs: ["DP-003", "DP-008"],
        confidence: 0.8,
        rationale: "필수 게이트 전수 통과 + 구체적 작업 보고 존재. 방향이 불확실하지 않으므로 되묻지 않고 완료 인정.",
      });
    }

    return candidates;
  }
}

function requiresOwnerReview(task: OrchestratorTask): boolean {
  const criteria = [...task.ownerDirectives.successCriteria, ...task.evaluationPlan.lockedCriteria];
  return criteria.some((criterion) => OWNER_REVIEW_PATTERNS.some((pattern) => pattern.test(criterion)));
}

function filterDpRefs(dpRefs: string[], pack: KnowledgePack): string[] {
  return Array.from(new Set(dpRefs)).filter((ref) => pack.dpIds.has(ref));
}

function mergeCandidates(candidates: RuleCandidate[]): RuleCandidate {
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const top = sorted[0]!;
  return {
    rule: sorted.map((candidate) => candidate.rule).join("+"),
    verdict: top.verdict,
    dpRefs: sorted.flatMap((candidate) => candidate.dpRefs),
    confidence: top.confidence,
    rationale: sorted.map((candidate) => candidate.rationale).join(" / "),
    ...(top.reworkInstruction ? { reworkInstruction: top.reworkInstruction } : {}),
  };
}

function buildTwinReworkInstruction(
  task: OrchestratorTask,
  evaluation: EvaluationRunResult,
  demands: string[],
): string {
  const gateLines = evaluation.failedRequiredGates.map((gate) => {
    const errors = gate.errors.length > 0 ? ` · ${gate.errors.join("; ")}` : "";
    return `- ${gate.kind}${errors}`;
  });
  return [
    "[ORCHESTRATOR_REWORK]",
    "(트윈 결정: 이사님 개입 없이 재작업 발행됨. 결정 근거는 결정 저널에 기록.)",
    `원 지시: ${task.ownerDirectives.rawInstruction}`,
    `재작업 목표: ${task.objective}`,
    "직접 성공 조건(잠금):",
    ...task.evaluationPlan.lockedCriteria.map((criterion) => `- ${criterion}`),
    "실패 gate:",
    ...(gateLines.length > 0 ? gateLines : ["- 없음"]),
    "트윈 요구사항:",
    ...demands.map((demand) => `- ${demand}`),
    "주의: 직접 성공 조건을 낮추지 말고, 완료 보고 전 필요한 증거를 남길 것.",
    "[/ORCHESTRATOR_REWORK]",
  ].join("\n");
}
