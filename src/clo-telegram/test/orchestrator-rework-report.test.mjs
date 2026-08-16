import assert from "node:assert/strict";
import test from "node:test";

import { EvaluationPlanner } from "../dist/orchestrator/evaluation-planner.js";
import { EvaluationRunner } from "../dist/orchestrator/evaluation-runner.js";
import { formatMobileReport } from "../dist/orchestrator/mobile-report.js";
import { ReworkIssuer } from "../dist/orchestrator/rework-issuer.js";

const planner = new EvaluationPlanner();
const runner = new EvaluationRunner();
const reworkIssuer = new ReworkIssuer();

function makeTask(rawInstruction = "빌드 통과까지 구현하고 테스트까지 해줘", overrides = {}) {
  const planned = planner.plan({
    rawInstruction,
    targetCwd: "C:/Projects/Brain",
    projectHint: "clo-telegram",
  });
  return {
    orchestratorTaskId: "orch_report",
    sourceChatId: 123,
    sourceMessageId: 456,
    targetCwd: "C:/Projects/Brain",
    targetAgent: "codex",
    taskType: planned.taskType,
    ownerDirectives: planned.ownerDirectives,
    objective: planned.objective,
    scope: planned.scope,
    instruction: planned.ownerDirectives.rawInstruction,
    status: "verifying",
    riskLevel: planned.riskLevel,
    evaluationProfile: planned.evaluationProfile,
    claimLevel: planned.claimLevel,
    evaluationPlan: {
      ...planned.evaluationPlan,
      gates: [
        { kind: "risk", required: true, params: {} },
        { kind: "contract", required: true, params: {} },
        { kind: "evidence", required: true, params: {} },
      ],
      requiredEvidence: [],
      reworkPolicy: { maxAttempts: 1, askAfterFailure: true },
    },
    artifacts: [],
    attempts: [],
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
    ...overrides,
  };
}

function gateResult(kind, status = "passed", required = true) {
  return {
    kind,
    required,
    status,
    summary: `${kind} ${status}`,
    evidence: [],
    errors: status === "passed" ? [] : [`${kind} evidence missing`],
    at: "2026-06-12T00:00:00.000Z",
  };
}

test("ReworkIssuer creates worker instruction from failed gates and locked criteria", () => {
  const task = makeTask();
  const result = runner.run(task, {
    gateResults: [
      gateResult("risk"),
      gateResult("contract"),
      gateResult("evidence", "failed"),
    ],
    lockedCriteriaSatisfied: (criterion) => criterion !== "빌드 통과",
  });

  const issue = reworkIssuer.create(task, result);

  assert.equal(issue.mode, "rework");
  assert.match(issue.instruction, /\[ORCHESTRATOR_REWORK\]/);
  assert.match(issue.instruction, /빌드 통과/);
  assert.match(issue.instruction, /evidence evidence missing/);
  assert.match(issue.instruction, /직접 성공 조건을 낮추지 말고/);
});

test("ReworkIssuer asks instead of reworking when runner decision is ASK", () => {
  const task = makeTask(undefined, {
    attempts: [{
      attemptId: "attempt_1",
      attemptNumber: 1,
      status: "failed",
      startedAt: "2026-06-12T00:00:00.000Z",
    }],
  });
  const result = runner.run(task, {
    gateResults: [
      gateResult("risk"),
      gateResult("contract"),
      gateResult("evidence", "failed"),
    ],
  });

  const issue = reworkIssuer.create(task, result);

  assert.equal(issue.mode, "ask");
  assert.match(issue.instruction, /\[ORCHESTRATOR_ASK\]/);
  assert.match(issue.instruction, /PASS로 보고하지 말 것/);
});

test("formatMobileReport keeps Telegram report within seven lines", () => {
  const task = makeTask();
  const result = runner.run(task, {
    gateResults: [
      gateResult("risk"),
      gateResult("contract"),
      gateResult("evidence", "failed"),
    ],
  });

  const report = formatMobileReport(task, result);
  const lines = report.split("\n");

  assert.equal(lines.length <= 7, true);
  assert.match(report, /판정: REWORK/);
  assert.match(report, /실패 gate: evidence/);
  assert.match(report, /다음: 실패 항목 재작업/);
});

test("formatMobileReport reports LIGHT output as draft, not pass", () => {
  const task = makeTask("방향만 초안으로 정리해줘", {
    evaluationPlan: {
      ...makeTask("방향만 초안으로 정리해줘").evaluationPlan,
      gates: [
        { kind: "risk", required: true, params: {} },
        { kind: "contract", required: true, params: {} },
        { kind: "evidence", required: true, params: {} },
      ],
      requiredEvidence: [],
      reworkPolicy: { maxAttempts: 0, askAfterFailure: true },
    },
  });
  const result = runner.run(task, {
    gateResults: [
      gateResult("risk"),
      gateResult("contract"),
      gateResult("evidence"),
    ],
  });

  const report = formatMobileReport(task, result);

  assert.match(report, /판정: DRAFT/);
  assert.doesNotMatch(report, /판정: PASS/);
  assert.equal(report.split("\n").length <= 7, true);
});
