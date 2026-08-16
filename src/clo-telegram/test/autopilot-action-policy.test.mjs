import assert from "node:assert/strict";
import test from "node:test";

import { ActionPolicy } from "../dist/autopilot/action-policy.js";
import { IntentRouter } from "../dist/autopilot/intent-router.js";

const router = new IntentRouter();
const policy = new ActionPolicy();

test("ActionPolicy auto-runs safe read and status intents", () => {
  const cases = [
    "그 작업 어떻게 됐어?",
    "아까 회의 내용 정리해줘",
    "전에 HTML 산출물 가능하다고 했던 거 기억나?",
    "왜 답이 이상해?",
  ];

  for (const input of cases) {
    const action = policy.decide(router.classify(input));
    assert.equal(action.mode, "AUTO", input);
    assert.equal(action.requiresConfirmation, false, input);
  }
});

test("ActionPolicy asks before sensitive or state-changing intents", () => {
  const cases = [
    "이 방에서는 내 개인 기억 써도 돼",
    "작업 취소해",
    "VS Code에서 처리해줘",
    "비교 분석 문서를 개발 작성해서 저장해줘 코덱스에게 전달해서 반영할 수 있는 건 하고 싶어",
  ];

  for (const input of cases) {
    const action = policy.decide(router.classify(input));
    assert.equal(action.mode, "ASK", input);
    assert.equal(action.requiresConfirmation, true, input);
  }
});

test("ActionPolicy auto-runs Brain memory writes", () => {
  const action = policy.decide(router.classify("이거 기억해둬"));
  assert.equal(action.mode, "AUTO");
  assert.equal(action.requiresConfirmation, false);
});

test("ActionPolicy passes general chat to existing LLM path", () => {
  const action = policy.decide(router.classify("안녕"));
  assert.equal(action.mode, "PASS");
  assert.equal(action.requiresConfirmation, false);
});

test("ActionPolicy passes document saves and local project paths to the LLM", () => {
  const documentSaveAction = policy.decide(router.classify("계획서 옵시디언에 저장해줘"));
  assert.equal(documentSaveAction.mode, "PASS");
  assert.equal(documentSaveAction.requiresConfirmation, false);

  const projectPathAction = policy.decide(router.classify("다음 폴더내 설계서 저장 D:\\Projects\\Sentinel"));
  assert.equal(projectPathAction.mode, "PASS");
  assert.equal(projectPathAction.requiresConfirmation, false);
});



