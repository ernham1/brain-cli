import type { EvaluationRunResult } from "./evaluation-runner.js";
import type { OrchestratorTask, GateKind } from "./types.js";

export function shouldSendDecisionBrief(result: EvaluationRunResult): boolean {
  // PASS(자율 승인 포함)와 REWORK(자동 재작업)는 이사님에게 올리지 않음
  // ASK와 REVIEW_NEEDED만 이사님 판단 요청
  return result.decision === "ASK" || result.decision === "REVIEW_NEEDED";
}

export function formatDecisionBrief(task: OrchestratorTask, result: EvaluationRunResult): string {
  return [
    "판단: 이사님 결정 필요",
    `작업: ${humanizeText(task.objective, 56)}`,
    `현재 상태: ${statusSentence(task, result)}`,
    `완료 기준: ${formatCriteria(task)}`,
    `질문: ${decisionQuestion(task, result)}`,
    `추천: ${recommendation(task, result)}`,
    `선택지: ${decisionOptions(result)}`,
    `근거: ${formatBasis(task, result)}`,
  ].join("\n");
}

function statusSentence(task: OrchestratorTask, result: EvaluationRunResult): string {
  if (result.failedRequiredGates.some((gate) => gate.kind === "risk")) {
    return "위험도가 높아 이사님 승인 없이는 완료 처리할 수 없습니다.";
  }
  if (hasEnvironmentMissing(result)) {
    return "필요한 자동 검증 도구가 연결되지 않아 결과를 바로 확인하지 못했습니다.";
  }
  if (result.failedRequiredGates.length > 0 || result.failedLockedCriteria.length > 0) {
    return "완료 기준 중 아직 확인되지 않은 부분이 있습니다.";
  }
  if (result.decision === "REVIEW_NEEDED") {
    if (hasConcreteWorkerReport(task)) {
      return `작업자는 완료했다고 보고했습니다. ${latestWorkerReport(task)}`;
    }
    return "작업자는 완료했다고 했지만 근거가 충분하지 않습니다.";
  }
  return "자동으로 결론 내리기 어려운 상태입니다.";
}

function recommendation(task: OrchestratorTask, result: EvaluationRunResult): string {
  if (result.decision === "REVIEW_NEEDED") {
    if (hasConcreteWorkerReport(task)) {
      return "보고 내용이 기대한 결과와 맞으면 완료 인정, 빠진 산출물이 보이면 재작업이 맞습니다.";
    }
    return "완료 근거를 먼저 더 받는 쪽이 맞습니다.";
  }
  if (result.failedRequiredGates.some((gate) => gate.kind === "risk")) {
    return "안전 범위로 재작업시키는 쪽을 권합니다. 위험 감수는 명시 승인 때만 선택하세요.";
  }
  if (hasEnvironmentMissing(result)) {
    return "증거를 더 받거나 검증 환경을 연결한 뒤 다시 판단하는 쪽을 권합니다.";
  }
  if (result.failedRequiredGates.length > 0 || result.failedLockedCriteria.length > 0) {
    return "빠진 부분을 재작업시킨 뒤 다시 검수하는 쪽을 권합니다.";
  }
  return "판단 근거를 더 요청하는 쪽을 권합니다.";
}

function decisionQuestion(task: OrchestratorTask, result: EvaluationRunResult): string {
  if (result.decision === "REVIEW_NEEDED") {
    return hasConcreteWorkerReport(task)
      ? "이 보고를 완료로 인정할까요, 아니면 빠진 부분을 다시 시킬까요?"
      : "완료 근거를 더 받게 할까요?";
  }
  if (result.failedRequiredGates.some((gate) => gate.kind === "risk")) {
    return "위험을 감수하고 진행할지, 안전한 범위로 다시 시킬지 정해주세요.";
  }
  if (hasEnvironmentMissing(result)) {
    return "직접 보고 내용만 보고 인정할지, 증거를 더 받을지 정해주세요.";
  }
  return "빠진 부분을 재작업시킬지, 기준을 바꿔 승인할지 정해주세요.";
}

function decisionOptions(result: EvaluationRunResult): string {
  if (result.decision === "REVIEW_NEEDED") {
    return "A 완료 인정 / B 빠진 부분 재작업 / C 근거 더 요청";
  }
  if (result.failedRequiredGates.some((gate) => gate.kind === "risk")) {
    return "A 위험 감수 승인 / B 안전 범위 재작업 / C 중단";
  }
  if (hasEnvironmentMissing(result)) {
    return "A 보고 내용으로 승인 / B 검증 후 다시 판단 / C 증거 요청";
  }
  return "A 기준 조정 후 승인 / B 빠진 부분 재작업 / C 중단";
}

function formatBasis(task: OrchestratorTask, result: EvaluationRunResult): string {
  const failedAreaNames = result.failedRequiredGates.map((gate) => readableGateName(gate.kind));
  const failedCriteria = result.failedLockedCriteria.map((criterion) => humanizeText(criterion, 44));

  if (failedAreaNames.length === 0 && failedCriteria.length === 0) {
    return "큰 실패 신호는 없지만, 이 작업은 사람 확인을 거친 뒤 완료 처리하도록 되어 있습니다.";
  }

  const parts: string[] = [];
  if (hasEnvironmentMissing(result)) {
    parts.push("필요한 자동 검증을 실행할 수 없었습니다");
  } else if (failedAreaNames.length > 0) {
    parts.push(`확인이 필요한 부분: ${failedAreaNames.join(", ")}`);
  }
  if (failedCriteria.length > 0) {
    parts.push(`아직 확인 안 된 완료 기준: ${failedCriteria.join(" / ")}`);
  }
  return parts.join("; ");
}

function formatCriteria(task: OrchestratorTask): string {
  const criteria = task.evaluationPlan.lockedCriteria.length > 0
    ? task.evaluationPlan.lockedCriteria
    : task.ownerDirectives.successCriteria;
  if (criteria.length === 0) return "원래 지시가 제대로 끝났는지 확인하면 됩니다.";
  return humanizeText(criteria.slice(0, 3).join(" / "), 86);
}

function latestWorkerReport(task: OrchestratorTask): string {
  const artifact = [...task.artifacts]
    .reverse()
    .find((item) => item.description.trim().length > 0);
  return artifact ? humanizeText(artifact.description.trim(), 96) : "작업자 보고 없음";
}

function hasConcreteWorkerReport(task: OrchestratorTask): boolean {
  return latestWorkerReport(task) !== "작업자 보고 없음";
}

function hasEnvironmentMissing(result: EvaluationRunResult): boolean {
  return result.failedRequiredGates.some((gate) => (
    gate.errors.some((error) => error.includes("environment_missing"))
    || gate.summary.includes("environment_missing")
  ));
}

function readableGateName(kind: GateKind): string {
  switch (kind) {
    case "risk": return "위험 승인";
    case "contract": return "지시사항 충족";
    case "evidence": return "완료 근거";
    case "build": return "실행 가능 여부";
    case "test": return "테스트 결과";
    case "lint": return "기본 품질 점검";
    case "uatkit": return "사용자 흐름 검증";
    case "playwright": return "화면 동작 검증";
    case "prism": return "설계 정합성 검증";
    case "security": return "보안 점검";
    case "gunsa": return "정밀 검수";
    case "rubric": return "평가 기준 점검";
    case "brain_write": return "기록 저장 확인";
  }
}

function humanizeText(text: string, maxLength: number): string {
  const normalized = text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/rec_[A-Za-z0-9_-]+/g, "기록 번호")
    .replace(/task_[A-Za-z0-9_-]+/g, "작업 번호")
    .replace(/\bclaimLevel\s*=\s*[A-Za-z0-9_-]+/g, "사람 확인 단계")
    .replace(/\bgate\s*=\s*[A-Za-z0-9_, -]+/g, "검증 상태")
    .replace(/\blockedCriteria\b/g, "완료 기준")
    .replace(/\breview_needed\b/g, "사람 확인 필요")
    .replace(/\bpass_eligible\b/g, "완료 처리 가능")
    .replace(/\benvironment_missing\b/g, "검증 환경 없음")
    .replace(/\bcron\b/gi, "자동 점검 일정")
    .replace(/[A-Za-z]:[\\/][^\s),，]+/g, "관련 파일")
    .replace(/(?:^|\s)(?:\.?\.?[\\/])?[-A-Za-z0-9_]+(?:[\\/][-A-Za-z0-9_.가-힣]+)+(?:\.[A-Za-z0-9]+)?/g, " 관련 파일")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(normalized, maxLength);
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}
