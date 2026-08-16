import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { OrchestratorStore } from "../dist/orchestrator/store.js";

function createStoreFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-orchestrator-store-"));
  return {
    dir,
    store: new OrchestratorStore(path.join(dir, "orchestrator")),
  };
}

function makeInput(overrides = {}) {
  return {
    orchestratorTaskId: "orch_test",
    sourceChatId: 123,
    sourceMessageId: 456,
    targetCwd: "C:/Projects/Brain",
    targetAgent: "codex",
    taskType: "code",
    ownerDirectives: {
      rawInstruction: "빌드 통과까지 구현해줘",
      hardConstraints: ["기존 브릿지 계약을 깨지 말 것"],
      successCriteria: ["npm run build 통과", "관련 테스트 통과"],
      exclusions: ["A2A 도입 제외"],
      priorityHints: ["verify"],
    },
    objective: "오케스트레이터 저장소 구현",
    scope: { include: ["src/orchestrator"], exclude: ["AgentForge GUI"] },
    instruction: "빌드 통과까지 구현해줘",
    riskLevel: "yellow",
    evaluationProfile: "strict",
    claimLevel: "pass_eligible",
    evaluationPlan: makeEvaluationPlan(),
    ...overrides,
  };
}

function makeEvaluationPlan(overrides = {}) {
  return {
    acceptanceCriteria: [
      { id: "ac_1", text: "npm run build 통과", locked: true },
      { id: "ac_2", text: "관련 테스트 통과", locked: true },
    ],
    requiredEvidence: [
      { kind: "command", description: "build output", required: true },
    ],
    lockedCriteria: ["npm run build 통과", "관련 테스트 통과"],
    gates: [
      { kind: "contract", required: true, params: {} },
      { kind: "evidence", required: true, params: {} },
    ],
    flexibility: {
      skippedGates: [],
      advisoryOnly: [],
    },
    qualityFloor: {
      explicitDirectivesLocked: true,
      passRequiresProfile: "standard",
      neverSkip: ["risk", "contract", "evidence"],
    },
    reworkPolicy: {
      maxAttempts: 1,
      askAfterFailure: true,
    },
    reportFormat: "mobile_summary",
    ...overrides,
  };
}

test("OrchestratorStore creates task file and created event", () => {
  const fixture = createStoreFixture();
  try {
    const task = fixture.store.create(makeInput());
    const taskFile = path.join(fixture.dir, "orchestrator", "tasks", "orch_test.json");

    assert.equal(task.status, "created");
    assert.equal(task.ownerDirectives.rawInstruction, "빌드 통과까지 구현해줘");
    assert.deepEqual(task.evaluationPlan.lockedCriteria, ["npm run build 통과", "관련 테스트 통과"]);
    assert.equal(existsSync(taskFile), true);

    const saved = JSON.parse(readFileSync(taskFile, "utf-8"));
    assert.equal(saved.orchestratorTaskId, "orch_test");

    const events = fixture.store.listEvents("orch_test");
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "created");
    assert.equal(events[0].status, "created");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("OrchestratorStore refuses tasks without locked owner and evaluation contract", () => {
  const fixture = createStoreFixture();
  try {
    assert.throws(
      () => fixture.store.create(makeInput({ ownerDirectives: undefined })),
      /ownerDirectives/,
    );
    assert.throws(
      () => fixture.store.create(makeInput({ evaluationPlan: undefined })),
      /evaluationPlan/,
    );
    assert.throws(
      () => fixture.store.create(makeInput({ claimLevel: undefined })),
      /claimLevel/,
    );
    assert.throws(
      () => fixture.store.create(makeInput({
        evaluationPlan: makeEvaluationPlan({ qualityFloor: { explicitDirectivesLocked: false } }),
      })),
      /explicitDirectivesLocked/,
    );
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("OrchestratorStore enforces status transitions and records events", () => {
  const fixture = createStoreFixture();
  try {
    fixture.store.create(makeInput());
    fixture.store.transition("orch_test", "planned", { reason: "plan ready" });
    const dispatched = fixture.store.transition("orch_test", "dispatched", { bridgeTaskId: "task_1" });

    assert.equal(dispatched.status, "dispatched");
    assert.throws(
      () => fixture.store.transition("orch_test", "passed"),
      /Invalid orchestrator status transition/,
    );

    const events = fixture.store.listEvents("orch_test");
    assert.deepEqual(events.map((event) => event.type), ["created", "status_changed", "status_changed"]);
    assert.deepEqual(events.map((event) => event.status), ["created", "planned", "dispatched"]);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("OrchestratorStore records worker, artifact, and attempt references", () => {
  const fixture = createStoreFixture();
  try {
    fixture.store.create(makeInput());
    fixture.store.linkWorker("orch_test", { type: "bridge", taskId: "task_1" });
    fixture.store.addArtifact("orch_test", {
      artifactId: "artifact_1",
      kind: "log",
      path: "C:/tmp/build.log",
      description: "build output",
      createdAt: "2026-06-12T00:00:00.000Z",
    });
    const updated = fixture.store.addAttempt("orch_test", {
      attemptId: "attempt_1",
      attemptNumber: 1,
      status: "dispatched",
      workerTaskId: "task_1",
      startedAt: "2026-06-12T00:00:00.000Z",
    });

    assert.equal(updated.bridgeTaskId, "task_1");
    assert.equal(updated.workerRef?.taskId, "task_1");
    assert.equal(updated.artifacts.length, 1);
    assert.equal(updated.attempts.length, 1);

    const events = fixture.store.listEvents("orch_test");
    assert.deepEqual(events.map((event) => event.type), [
      "created",
      "worker_linked",
      "artifact_added",
      "attempt_added",
    ]);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
