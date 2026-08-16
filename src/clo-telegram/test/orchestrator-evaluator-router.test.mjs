import assert from "node:assert/strict";
import test from "node:test";

import { EvaluationPlanner } from "../dist/orchestrator/evaluation-planner.js";
import { EvaluatorRouter } from "../dist/orchestrator/evaluator-router.js";

const planner = new EvaluationPlanner();
const router = new EvaluatorRouter();

function makeTask(rawInstruction) {
  const planned = planner.plan({
    rawInstruction,
    targetCwd: "C:/Projects/Brain",
    projectHint: "clo-telegram",
  });
  return {
    orchestratorTaskId: "orch_router",
    sourceChatId: 123,
    sourceMessageId: 456,
    targetCwd: "C:/Projects/Brain",
    targetAgent: "codex",
    taskType: planned.taskType,
    ownerDirectives: planned.ownerDirectives,
    objective: planned.objective,
    scope: planned.scope,
    instruction: planned.ownerDirectives.rawInstruction,
    status: "planned",
    riskLevel: planned.riskLevel,
    evaluationProfile: planned.evaluationProfile,
    claimLevel: planned.claimLevel,
    evaluationPlan: planned.evaluationPlan,
    artifacts: [],
    attempts: [],
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
  };
}

function routeByKind(routes, kind) {
  return routes.find((route) => route.kind === kind);
}

test("EvaluatorRouter routes UI gates to UATKit and Playwright when environment exists", () => {
  const task = makeTask("UI 화면 버튼 수정하고 엄격하게 검증해줘");
  const routes = router.routeTask(task, {
    baseUrl: "http://localhost:3000",
    availableEvaluators: { uatkit: true, playwright: true, rubric: true },
  });

  assert.equal(routeByKind(routes, "uatkit")?.status, "routed");
  assert.equal(routeByKind(routes, "uatkit")?.evaluator, "uatkit");
  assert.equal(routeByKind(routes, "playwright")?.status, "routed");
});

test("EvaluatorRouter marks required UI evaluator as environment_missing without baseUrl", () => {
  const task = makeTask("UI 화면 버튼 수정하고 엄격하게 검증해줘");
  const routes = router.routeTask(task, {
    availableEvaluators: { uatkit: true, playwright: true, rubric: true },
  });

  assert.equal(routeByKind(routes, "uatkit")?.required, true);
  assert.equal(routeByKind(routes, "uatkit")?.status, "environment_missing");
  assert.match(routeByKind(routes, "uatkit")?.reason ?? "", /baseUrl/);
});

test("EvaluatorRouter routes PRISM only when sourceContext exists", () => {
  const missing = router.routeGate(
    { kind: "prism", required: true, params: {} },
    { availableEvaluators: { prism: true } },
  );
  assert.equal(missing.status, "environment_missing");
  assert.match(missing.reason, /sourceContext/);

  const routed = router.routeGate(
    { kind: "prism", required: true, params: {} },
    { sourceContext: "src/orchestrator", availableEvaluators: { prism: true } },
  );
  assert.equal(routed.status, "routed");
  assert.equal(routed.evaluator, "prism");
});

test("EvaluatorRouter exposes missing gunsa and rubric evaluators instead of passing silently", () => {
  const gunsa = router.routeGate(
    { kind: "gunsa", required: true, params: {} },
    { availableEvaluators: { gunsa: false } },
  );
  assert.equal(gunsa.status, "environment_missing");
  assert.equal(gunsa.required, true);

  const rubric = router.routeGate(
    { kind: "rubric", required: false, params: {} },
    { availableEvaluators: { rubric: false } },
  );
  assert.equal(rubric.status, "environment_missing");
  assert.equal(rubric.required, false);
});
