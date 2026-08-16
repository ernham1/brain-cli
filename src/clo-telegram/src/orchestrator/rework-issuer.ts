import type { EvaluationRunResult } from "./evaluation-runner.js";
import type { OrchestratorTask } from "./types.js";

export interface ReworkIssue {
  mode: "rework" | "ask" | "none";
  instruction: string;
  failedGates: string[];
  failedLockedCriteria: string[];
}

export class ReworkIssuer {
  create(task: OrchestratorTask, result: EvaluationRunResult): ReworkIssue {
    const failedGates = result.failedRequiredGates.map((gate) => gate.kind);
    const failedLockedCriteria = result.failedLockedCriteria;

    if (result.decision === "ASK") {
      return {
        mode: "ask",
        instruction: buildAskInstruction(task, result),
        failedGates,
        failedLockedCriteria,
      };
    }

    if (result.decision !== "REWORK") {
      return {
        mode: "none",
        instruction: "",
        failedGates,
        failedLockedCriteria,
      };
    }

    return {
      mode: "rework",
      instruction: buildReworkInstruction(task, result),
      failedGates,
      failedLockedCriteria,
    };
  }
}

function buildReworkInstruction(task: OrchestratorTask, result: EvaluationRunResult): string {
  const gateLines = result.failedRequiredGates.map((gate) => {
    const errors = gate.errors.length > 0 ? ` — ${gate.errors.join("; ")}` : "";
    return `- ${gate.kind}${errors}`;
  });
  const lockedLines = result.failedLockedCriteria.map((criterion) => `- ${criterion}`);

  return [
    "[ORCHESTRATOR_REWORK]",
    `원 지시: ${task.ownerDirectives.rawInstruction}`,
    `재작업 목표: ${task.objective}`,
    "직접 성공 조건(잠금):",
    ...task.evaluationPlan.lockedCriteria.map((criterion) => `- ${criterion}`),
    "실패 gate:",
    ...(gateLines.length > 0 ? gateLines : ["- 없음"]),
    "미충족 lockedCriteria:",
    ...(lockedLines.length > 0 ? lockedLines : ["- 없음"]),
    "주의: 직접 성공 조건을 낮추지 말고, 완료 보고 전 필요한 증거를 남길 것.",
    "[/ORCHESTRATOR_REWORK]",
  ].join("\n");
}

function buildAskInstruction(task: OrchestratorTask, result: EvaluationRunResult): string {
  const failedGates = result.failedRequiredGates.map((gate) => gate.kind).join(", ") || "없음";
  const failedCriteria = result.failedLockedCriteria.join(", ") || "없음";
  return [
    "[ORCHESTRATOR_ASK]",
    `원 지시: ${task.ownerDirectives.rawInstruction}`,
    `ASK 사유: ${result.summary}`,
    `실패 gate: ${failedGates}`,
    `미충족 lockedCriteria: ${failedCriteria}`,
    "이사님 확인 없이는 PASS로 보고하지 말 것.",
    "[/ORCHESTRATOR_ASK]",
  ].join("\n");
}
