import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EvaluationPlanner } from "../dist/orchestrator/evaluation-planner.js";
import { EvaluationRunner } from "../dist/orchestrator/evaluation-runner.js";
import { formatMobileReport } from "../dist/orchestrator/mobile-report.js";
import { OrchestratorStore } from "../dist/orchestrator/store.js";
import { runCoreGates } from "../dist/orchestrator/gates.js";

function createTaskInput(planned, rawInstruction) {
  return {
    sourceChatId: 123,
    sourceMessageId: 456,
    targetCwd: "C:/Projects/Brain",
    targetAgent: "codex",
    taskType: planned.taskType,
    ownerDirectives: planned.ownerDirectives,
    objective: planned.objective,
    scope: planned.scope,
    instruction: rawInstruction,
    riskLevel: planned.riskLevel,
    evaluationProfile: planned.evaluationProfile,
    claimLevel: planned.claimLevel,
    evaluationPlan: {
      ...planned.evaluationPlan,
      requiredEvidence: [
        { kind: "file", description: "fake worker result", required: true },
      ],
    },
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

test("orchestrator smoke completes fake task through planner store gates runner and report", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-orchestrator-smoke-"));
  try {
    const planner = new EvaluationPlanner();
    const store = new OrchestratorStore(path.join(dir, "orchestrator"));
    const runner = new EvaluationRunner();
    const rawInstruction = "검증까지 완료 보고 가능한 일반 작업";
    const planned = planner.plan({ rawInstruction, targetCwd: "C:/Projects/Brain" });
    const created = store.create(createTaskInput(planned, rawInstruction));

    store.transition(created.orchestratorTaskId, "planned");
    store.linkWorker(created.orchestratorTaskId, { type: "bridge", taskId: "task_fake" });
    store.transition(created.orchestratorTaskId, "dispatched");
    store.addAttempt(created.orchestratorTaskId, {
      attemptId: "attempt_1",
      attemptNumber: 1,
      status: "completed",
      workerTaskId: "task_fake",
      startedAt: "2026-06-12T00:00:00.000Z",
      completedAt: "2026-06-12T00:01:00.000Z",
    });
    store.transition(created.orchestratorTaskId, "running");
    store.transition(created.orchestratorTaskId, "result_received");
    store.addArtifact(created.orchestratorTaskId, {
      artifactId: "artifact_result",
      kind: "file",
      path: "C:/tmp/fake-result.md",
      description: "fake worker result",
      createdAt: "2026-06-12T00:01:00.000Z",
    });
    const verifying = store.transition(created.orchestratorTaskId, "verifying");

    const coreResults = runCoreGates(verifying, {
      fileExists: (filePath) => filePath === "C:/tmp/fake-result.md",
    });
    const externalResults = verifying.evaluationPlan.gates
      .filter((gate) => !["risk", "contract", "evidence"].includes(gate.kind))
      .map((gate) => gateResult(gate.kind, "passed", gate.required));
    const result = runner.run(verifying, { gateResults: [...coreResults, ...externalResults] });
    const report = formatMobileReport(verifying, result);

    assert.equal(result.decision, "PASS");
    assert.match(report, /판정: PASS/);
    store.transition(created.orchestratorTaskId, result.nextStatus);
    store.transition(created.orchestratorTaskId, "reported");

    const events = store.listEvents(created.orchestratorTaskId);
    assert.deepEqual(
      events.filter((event) => event.type === "status_changed").map((event) => event.status),
      ["planned", "dispatched", "running", "result_received", "verifying", "passed", "reported"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("orchestrator smoke keeps LIGHT fake task as draft, not pass", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-orchestrator-smoke-"));
  try {
    const planner = new EvaluationPlanner();
    const store = new OrchestratorStore(path.join(dir, "orchestrator"));
    const runner = new EvaluationRunner();
    const rawInstruction = "방향만 초안으로 정리해줘";
    const planned = planner.plan({ rawInstruction, targetCwd: "C:/Projects/Brain" });
    const created = store.create(createTaskInput(planned, rawInstruction));
    store.transition(created.orchestratorTaskId, "planned");
    store.transition(created.orchestratorTaskId, "dispatched");
    store.transition(created.orchestratorTaskId, "running");
    store.transition(created.orchestratorTaskId, "result_received");
    store.addArtifact(created.orchestratorTaskId, {
      artifactId: "artifact_note",
      kind: "file",
      path: "C:/tmp/draft.md",
      description: "draft note",
      createdAt: "2026-06-12T00:01:00.000Z",
    });
    const verifying = store.transition(created.orchestratorTaskId, "verifying");

    const coreResults = runCoreGates(verifying, {
      fileExists: (filePath) => filePath === "C:/tmp/draft.md",
    });
    const advisoryResults = verifying.evaluationPlan.gates
      .filter((gate) => !["risk", "contract", "evidence"].includes(gate.kind))
      .map((gate) => gateResult(gate.kind, gate.params.skipped ? "skipped" : "passed", gate.required));
    const result = runner.run(verifying, { gateResults: [...coreResults, ...advisoryResults] });
    const report = formatMobileReport(verifying, result);

    assert.equal(result.decision, "DRAFT");
    assert.doesNotMatch(report, /판정: PASS/);
    assert.match(report, /판정: DRAFT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
