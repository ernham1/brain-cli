import type { OrchestratorStatus, OrchestratorTask } from "./types.js";
import { GateCore, type GateResult, type GateRunContext } from "./gates.js";

export type EvaluationDecision = "PASS" | "REWORK" | "ASK" | "DRAFT" | "REVIEW_NEEDED";

export interface EvaluationRunnerOptions {
  gateResults?: GateResult[];
  gateContext?: Omit<GateRunContext, "task">;
  lockedCriteriaSatisfied?: (criterion: string, task: OrchestratorTask) => boolean;
}

export interface EvaluationRunResult {
  decision: EvaluationDecision;
  nextStatus: OrchestratorStatus;
  gateResults: GateResult[];
  failedRequiredGates: GateResult[];
  failedLockedCriteria: string[];
  summary: string;
}

export class EvaluationRunner {
  constructor(private readonly gateCore = new GateCore()) {}

  run(task: OrchestratorTask, options: EvaluationRunnerOptions = {}): EvaluationRunResult {
    const gateResults = options.gateResults ?? task.evaluationPlan.gates
      .map((gate) => this.gateCore.runGate(gate, { ...options.gateContext, task }));
    const failedRequiredGates = gateResults
      .filter((result) => result.required && result.status !== "passed");
    const failedLockedCriteria = task.evaluationPlan.lockedCriteria
      .filter((criterion) => !(options.lockedCriteriaSatisfied?.(criterion, task) ?? true));

    const decision = decide(task, failedRequiredGates, failedLockedCriteria);
    return {
      decision,
      nextStatus: nextStatusForDecision(decision),
      gateResults,
      failedRequiredGates,
      failedLockedCriteria,
      summary: buildSummary(decision, failedRequiredGates, failedLockedCriteria),
    };
  }
}

function decide(
  task: OrchestratorTask,
  failedRequiredGates: GateResult[],
  failedLockedCriteria: string[],
): EvaluationDecision {
  if (failedRequiredGates.some((result) => result.kind === "risk")) return "ASK";
  if (failedRequiredGates.some((result) => result.errors.some((error) => error.includes("environment_missing")))) {
    return "ASK";
  }

  if (failedRequiredGates.length > 0 || failedLockedCriteria.length > 0) {
    return shouldAskAfterFailure(task) ? "ASK" : "REWORK";
  }

  // LIGHT 프로파일은 자율 승인 대상이 아님 — 항상 DRAFT 또는 REVIEW_NEEDED
  if (task.evaluationProfile === "light") {
    return task.claimLevel === "draft" ? "DRAFT" : "REVIEW_NEEDED";
  }

  // 자율 승인: 모든 필수 게이트 통과 + RED risk 없음 + 워커 보고 있음
  // → claimLevel이 review_needed여도 PASS로 자동 승인
  if (canAutoApprove(task)) return "PASS";

  if (task.claimLevel !== "pass_eligible") return "REVIEW_NEEDED";
  return "PASS";
}

/**
 * 자율 승인 판정: 이사님 확인 없이 클로가 완료 처리할 수 있는 조건.
 * - 모든 필수 게이트 통과 (이 시점에서 이미 확인됨 — strict의 build/test/lint/rubric 포함)
 * - riskLevel이 RED가 아님
 * - 워커가 실제 산출물/보고를 남김 (빈 보고 아님)
 * - successCriteria에 이사님 확인을 명시적으로 요구하는 항목이 없음
 *
 * B안 적용 (2026-06-26): strict 프로필도 모든 필수 게이트를 통과했으면 자율 승인.
 * decide() 흐름상 canAutoApprove() 호출 전에 failedRequiredGates를 이미 체크하므로,
 * 이 시점에 도달했다는 것 자체가 build/test/lint/rubric 전부 통과한 상태.
 */
function canAutoApprove(task: OrchestratorTask): boolean {
  if (task.riskLevel === "red") return false;
  const hasWorkerReport = task.artifacts.some(
    (a) => a.description.trim().length > 0,
  );
  if (!hasWorkerReport) return false;
  // 이사님이 명시적으로 확인을 요구한 경우 자율 승인하지 않음
  if (requiresOwnerReview(task)) return false;
  return true;
}

const OWNER_REVIEW_PATTERNS = [
  /이사님\s*확인/,
  /사람\s*확인/,
  /수동\s*검토/,
  /승인\s*필요/,
];

function requiresOwnerReview(task: OrchestratorTask): boolean {
  const criteria = [
    ...task.ownerDirectives.successCriteria,
    ...task.evaluationPlan.lockedCriteria,
  ];
  return criteria.some((c) =>
    OWNER_REVIEW_PATTERNS.some((pattern) => pattern.test(c)),
  );
}

function shouldAskAfterFailure(task: OrchestratorTask): boolean {
  const failedAttempts = task.attempts.filter((attempt) => attempt.status === "failed").length;
  const maxAttempts = task.evaluationPlan.reworkPolicy.maxAttempts;
  return maxAttempts <= 0 || failedAttempts >= maxAttempts;
}

function nextStatusForDecision(decision: EvaluationDecision): OrchestratorStatus {
  switch (decision) {
    case "PASS": return "passed";
    case "REWORK": return "rework";
    case "ASK":
    case "DRAFT":
    case "REVIEW_NEEDED":
      return "ask";
  }
}

function buildSummary(
  decision: EvaluationDecision,
  failedRequiredGates: GateResult[],
  failedLockedCriteria: string[],
): string {
  if (decision === "PASS") return "all required gates and locked criteria passed";
  if (decision === "DRAFT") return "light profile result is draft only";
  if (decision === "REVIEW_NEEDED") return "manual review is required before claiming pass";

  const failedGates = failedRequiredGates.map((result) => result.kind).join(", ") || "none";
  const failedCriteria = failedLockedCriteria.join(", ") || "none";
  return `${decision}: failed gates=${failedGates}; failed locked criteria=${failedCriteria}`;
}
