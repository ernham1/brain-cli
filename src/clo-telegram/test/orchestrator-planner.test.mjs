import assert from "node:assert/strict";
import test from "node:test";

import { EvaluationPlanner } from "../dist/orchestrator/evaluation-planner.js";

const planner = new EvaluationPlanner();

function plan(rawInstruction) {
  return planner.plan({
    rawInstruction,
    targetCwd: "C:/Projects/Brain",
    projectHint: "clo-telegram",
  });
}

function gate(result, kind) {
  return result.evaluationPlan.gates.find((item) => item.kind === kind);
}

test("EvaluationPlanner locks direct success criteria into lockedCriteria and required gates", () => {
  const result = plan("빠르게 하되 빌드 통과까지 구현해줘. 기존 브릿지 계약은 깨지 말 것.");

  assert.equal(result.taskType, "code");
  assert.equal(result.ownerDirectives.rawInstruction, "빠르게 하되 빌드 통과까지 구현해줘. 기존 브릿지 계약은 깨지 말 것.");
  assert.match(result.ownerDirectives.hardConstraints.join("\n"), /기존 동작 호환 유지/);
  assert.deepEqual(result.evaluationPlan.lockedCriteria, ["빌드 통과"]);
  assert.equal(gate(result, "build")?.required, true);
  assert.equal(gate(result, "contract")?.required, true);
  assert.equal(gate(result, "evidence")?.required, true);
  assert.equal(result.claimLevel, "pass_eligible");
});

test("EvaluationPlanner keeps LIGHT profile from becoming pass eligible", () => {
  const result = plan("방향만 초안으로 정리해줘");

  assert.equal(result.evaluationProfile, "light");
  assert.equal(result.claimLevel, "draft");
  assert.notEqual(result.claimLevel, "pass_eligible");
  assert.equal(gate(result, "risk")?.required, true);
  assert.equal(gate(result, "contract")?.required, true);
  assert.equal(gate(result, "evidence")?.required, true);
  assert.match(
    result.evaluationPlan.flexibility.skippedGates.map((item) => item.kind).join(","),
    /rubric/,
  );
});

test("EvaluationPlanner raises profile for verification wording", () => {
  const result = plan("시장 리서치 자료를 조사하고 진짜 되는지 검증까지 해줘");

  assert.equal(result.taskType, "research");
  assert.equal(result.evaluationProfile, "strict");
  assert.equal(result.claimLevel, "pass_eligible");
  assert.equal(gate(result, "rubric")?.required, true);
  assert.deepEqual(result.evaluationPlan.lockedCriteria, ["검증 증거 확보"]);
});

test("EvaluationPlanner routes task types to expected evaluator gates", () => {
  const ui = plan("UI 화면 버튼 수정하고 테스트까지 해줘");
  assert.equal(ui.taskType, "ui");
  assert.equal(ui.evaluationProfile, "strict");
  assert.equal(gate(ui, "uatkit")?.required, true);
  assert.equal(gate(ui, "playwright")?.required, true);

  const document = plan("설계서 업데이트 해줘");
  assert.equal(document.taskType, "document");
  assert.equal(document.evaluationProfile, "standard");
  assert.equal(gate(document, "rubric")?.required, true);

  const orchestration = plan("오케스트레이터 평가 레이어 시스템을 엄격하게 검증해줘");
  assert.equal(orchestration.taskType, "orchestration");
  assert.equal(orchestration.evaluationProfile, "strict");
  assert.equal(gate(orchestration, "gunsa")?.required, true);
});

test("EvaluationPlanner records exclusions without dropping never-skip gates", () => {
  const result = plan("A2A는 도입하지 말고 오케스트레이터 루프를 구현해줘");

  assert.match(result.ownerDirectives.exclusions.join("\n"), /A2A 프로토콜 도입 제외/);
  assert.equal(gate(result, "risk")?.required, true);
  assert.equal(gate(result, "contract")?.required, true);
  assert.equal(gate(result, "evidence")?.required, true);
  assert.deepEqual(result.evaluationPlan.qualityFloor.neverSkip, ["risk", "contract", "evidence"]);
});
