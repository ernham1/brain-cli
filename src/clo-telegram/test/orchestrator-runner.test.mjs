import assert from "node:assert/strict";
import test from "node:test";

import { EvaluationPlanner } from "../dist/orchestrator/evaluation-planner.js";
import { EvaluationRunner } from "../dist/orchestrator/evaluation-runner.js";

const planner = new EvaluationPlanner();
const runner = new EvaluationRunner();

function makeTask(rawInstruction = "빌드 통과까지 구현하고 테스트까지 해줘", overrides = {}) {
  const planned = planner.plan({
    rawInstruction,
    targetCwd: "C:/Projects/Brain",
    projectHint: "clo-telegram",
  });
  return {
    orchestratorTaskId: "orch_runner",
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
    errors: status === "passed" ? [] : [`${kind} failed`],
    at: "2026-06-12T00:00:00.000Z",
  };
}

const allPassed = [
  gateResult("risk"),
  gateResult("contract"),
  gateResult("evidence"),
];

test("EvaluationRunner returns PASS only when required gates and locked criteria pass", () => {
  const result = runner.run(makeTask(), { gateResults: allPassed });

  assert.equal(result.decision, "PASS");
  assert.equal(result.nextStatus, "passed");
  assert.equal(result.failedRequiredGates.length, 0);
  assert.equal(result.failedLockedCriteria.length, 0);
});

test("EvaluationRunner returns REWORK for required gate failure before retry limit", () => {
  const result = runner.run(makeTask(), {
    gateResults: [
      gateResult("risk"),
      gateResult("contract"),
      gateResult("evidence", "failed"),
    ],
  });

  assert.equal(result.decision, "REWORK");
  assert.equal(result.nextStatus, "rework");
  assert.deepEqual(result.failedRequiredGates.map((item) => item.kind), ["evidence"]);
});

test("EvaluationRunner returns ASK for RED risk or repeated failure", () => {
  const red = runner.run(makeTask(undefined, { riskLevel: "red" }), {
    gateResults: [
      gateResult("risk", "failed"),
      gateResult("contract"),
      gateResult("evidence"),
    ],
  });
  assert.equal(red.decision, "ASK");
  assert.equal(red.nextStatus, "ask");

  const repeated = runner.run(makeTask(undefined, {
    attempts: [{
      attemptId: "attempt_1",
      attemptNumber: 1,
      status: "failed",
      startedAt: "2026-06-12T00:00:00.000Z",
    }],
  }), {
    gateResults: [
      gateResult("risk"),
      gateResult("contract"),
      gateResult("evidence", "failed"),
    ],
  });
  assert.equal(repeated.decision, "ASK");
});

test("EvaluationRunner asks when required evaluator environment is missing", () => {
  const result = runner.run(makeTask(), {
    gateResults: [
      gateResult("risk"),
      gateResult("contract"),
      {
        ...gateResult("build", "failed"),
        errors: ["environment_missing: command evaluator is not available"],
      },
    ],
  });

  assert.equal(result.decision, "ASK");
  assert.equal(result.nextStatus, "ask");
});

test("EvaluationRunner blocks PASS when locked criteria are unsatisfied", () => {
  const result = runner.run(makeTask(), {
    gateResults: allPassed,
    lockedCriteriaSatisfied: (criterion) => criterion !== "빌드 통과",
  });

  assert.equal(result.decision, "REWORK");
  assert.deepEqual(result.failedLockedCriteria, ["빌드 통과"]);
});

test("EvaluationRunner never turns LIGHT profile into PASS", () => {
  const lightTask = makeTask("방향만 초안으로 정리해줘", {
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

  const result = runner.run(lightTask, { gateResults: allPassed });

  assert.equal(lightTask.evaluationProfile, "light");
  assert.equal(result.decision, "DRAFT");
  assert.notEqual(result.decision, "PASS");
  assert.equal(result.nextStatus, "ask");
});
