import assert from "node:assert/strict";
import test from "node:test";

import { EvaluationPlanner } from "../dist/orchestrator/evaluation-planner.js";
import { GateCore, runCoreGates } from "../dist/orchestrator/gates.js";

const planner = new EvaluationPlanner();

function makeTask(overrides = {}) {
  const planned = planner.plan({
    rawInstruction: "빌드 통과까지 구현하고 테스트까지 해줘",
    targetCwd: "C:/Projects/Brain",
    projectHint: "clo-telegram",
  });
  return {
    orchestratorTaskId: "orch_gate",
    sourceChatId: 123,
    sourceMessageId: 456,
    targetCwd: "C:/Projects/Brain",
    targetAgent: "codex",
    taskType: planned.taskType,
    ownerDirectives: planned.ownerDirectives,
    objective: planned.objective,
    scope: planned.scope,
    instruction: planned.ownerDirectives.rawInstruction,
    status: "result_received",
    riskLevel: planned.riskLevel,
    evaluationProfile: planned.evaluationProfile,
    claimLevel: planned.claimLevel,
    evaluationPlan: {
      ...planned.evaluationPlan,
      requiredEvidence: [
        { kind: "file", description: "구현 파일", required: true },
      ],
    },
    artifacts: [],
    attempts: [],
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
    ...overrides,
  };
}

function resultByKind(results, kind) {
  return results.find((result) => result.kind === kind);
}

test("GateCore passes core gates when contract and required evidence are present", () => {
  const task = makeTask({
    artifacts: [{
      artifactId: "artifact_file",
      kind: "file",
      path: "C:/tmp/output.ts",
      description: "구현 파일",
      createdAt: "2026-06-12T00:00:00.000Z",
    }],
  });

  const results = runCoreGates(task, { fileExists: (filePath) => filePath === "C:/tmp/output.ts" });

  assert.equal(resultByKind(results, "risk")?.status, "passed");
  assert.equal(resultByKind(results, "contract")?.status, "passed");
  assert.equal(resultByKind(results, "evidence")?.status, "passed");
});

test("GateCore fails contract when locked criteria or quality floor are missing", () => {
  const task = makeTask({
    evaluationPlan: {
      ...makeTask().evaluationPlan,
      lockedCriteria: [],
      qualityFloor: {
        explicitDirectivesLocked: false,
        passRequiresProfile: "standard",
        neverSkip: ["risk", "contract", "evidence"],
      },
    },
  });

  const result = new GateCore().runGate(
    { kind: "contract", required: true, params: {} },
    { task },
  );

  assert.equal(result.status, "failed");
  assert.match(result.errors.join("\n"), /lockedCriteria/);
  assert.match(result.errors.join("\n"), /explicitDirectivesLocked/);
});

test("GateCore fails evidence gate when required artifact is missing", () => {
  const task = makeTask();

  const result = new GateCore().runGate(
    { kind: "evidence", required: true, params: {} },
    { task, fileExists: () => false },
  );

  assert.equal(result.status, "failed");
  assert.match(result.errors.join("\n"), /required evidence missing/);
});

test("GateCore fails RED risk instead of passing automatically", () => {
  const task = makeTask({ riskLevel: "red" });

  const result = new GateCore().runGate(
    { kind: "risk", required: true, params: {} },
    { task },
  );

  assert.equal(result.status, "failed");
  assert.match(result.errors.join("\n"), /approval required/);
});

test("GateCore reports skipped advisory gate and captures thrown errors", () => {
  const task = makeTask({
    artifacts: [{
      artifactId: "artifact_file",
      kind: "file",
      path: "C:/tmp/output.ts",
      description: "구현 파일",
      createdAt: "2026-06-12T00:00:00.000Z",
    }],
  });
  const runner = new GateCore();

  const skipped = runner.runGate(
    { kind: "rubric", required: false, params: { skipped: true, reason: "light profile" } },
    { task },
  );
  assert.equal(skipped.status, "skipped");

  const thrown = runner.runGate(
    { kind: "evidence", required: true, params: {} },
    { task, fileExists: () => { throw new Error("filesystem unavailable"); } },
  );
  assert.equal(thrown.status, "failed");
  assert.match(thrown.errors.join("\n"), /filesystem unavailable/);
});
