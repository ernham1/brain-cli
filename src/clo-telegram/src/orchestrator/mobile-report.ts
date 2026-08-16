import type { EvaluationRunResult } from "./evaluation-runner.js";
import type { OrchestratorTask } from "./types.js";

const MAX_REPORT_LINES = 7;

export function formatMobileReport(task: OrchestratorTask, result: EvaluationRunResult): string {
  const failedGates = result.failedRequiredGates.map((gate) => gate.kind).join(", ");
  const failedCriteria = result.failedLockedCriteria.join(", ");
  const passedCount = result.gateResults.filter((gate) => gate.status === "passed").length;
  const totalCount = result.gateResults.length;
  const lines = [
    `판정: ${result.decision}`,
    `작업: ${truncate(task.objective, 42)}`,
    failedGates ? `실패 gate: ${failedGates}` : `gate: ${passedCount}/${totalCount} 통과`,
    failedCriteria ? `미충족 기준: ${truncate(failedCriteria, 48)}` : `잠금 기준: ${task.evaluationPlan.lockedCriteria.length}개 유지`,
    `주장 등급: ${task.claimLevel}`,
    `다음: ${nextAction(result.decision)}`,
  ];

  return lines.slice(0, MAX_REPORT_LINES).join("\n");
}

function nextAction(decision: EvaluationRunResult["decision"]): string {
  switch (decision) {
    case "PASS": return "완료 보고 가능";
    case "REWORK": return "실패 항목 재작업";
    case "ASK": return "이사님 확인 필요";
    case "DRAFT": return "초안으로만 참고";
    case "REVIEW_NEEDED": return "검토 후 확정";
  }
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}
