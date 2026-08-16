import assert from "node:assert/strict";
import test from "node:test";

import {
  IntentRouter,
  isExplicitDevHandoffRequest,
  isExplicitMemoryWriteRequest,
  isExplicitProjectWorkRequest,
  isExplicitTaskStatusRequest,
} from "../dist/autopilot/intent-router.js";

const router = new IntentRouter();

test("IntentRouter classifies core natural language requests", () => {
  const cases = [
    ["그 작업 어떻게 됐어?", "task_status"],
    ["워커 돌고 있는 거 있어?", "task_status"],
    ["작업 취소해", "task_cancel"],
    ["회의 시작하자", "meeting_start"],
    ["회의 마무리하고 저장해", "meeting_end"],
    ["아까 회의 내용 정리해줘", "meeting_summary"],
    ["전에 HTML 산출물 가능하다고 했던 거 기억나?", "memory_recall"],
    ["이 방에서는 내 개인 기억 써도 돼", "privacy_policy_change"],
    ["코덱스에게 전달해서 반영해줘", "dev_handoff"],
    ["이건 길게 조사해줘", "async_research"],
    ["안녕", "general_chat"],
  ];

  for (const [input, expected] of cases) {
    assert.equal(router.classify(input).intent, expected, input);
  }
});

test("IntentRouter leaves slash commands to existing handlers", () => {
  const decision = router.classify("/작업");
  assert.equal(decision.intent, "general_chat");
  assert.equal(decision.safety, "pass_to_llm");
});

test("IntentRouter does not treat planning text as task status", () => {
  const cases = [
    "다음 내용 진행 정리하면 IR 피칭 대응, 에이전트 산출물 평가, 원스텝별 벤치 프레임워크 순서로 진행하면 됩니다. 작업 구조를 조정할까요?",
    "이 방향으로 바로 진행할까요, 아니면 조정하실 부분 있으시면 말씀해주세요.",
    "작업 구조는 3번 고도화부터 1번 실전 체크리스트 순서가 효율적입니다.",
    "오케스트레이터가 가능하려면 현재 내 PC의 활성 세션에서 수행하고 있는 작업을 알고 있어야 하고, 각 작업의 완료 기준을 파악하고, 작업이 완료되면 신호를 받아야 함",
  ];

  for (const input of cases) {
    const decision = router.classify(input);
    assert.equal(decision.intent, "general_chat", input);
    assert.equal(decision.safety, "pass_to_llm", input);
  }
});

test("isExplicitTaskStatusRequest requires direct status inquiry wording", () => {
  const explicitCases = [
    "그 작업 어떻게 됐어?",
    "워커 돌고 있는 거 있어?",
    "작업 상태 확인",
    "최근 위임 작업 목록 보여줘",
    "아까 작업 끝났어?",
  ];

  for (const input of explicitCases) {
    assert.equal(isExplicitTaskStatusRequest(input), true, input);
  }

  const planningCases = [
    "각 작업의 완료 기준을 정확히 파악하고 있어야 함",
    "작업이 완료되면 신호를 보내야 함",
    "현재 수행하고 있는 작업을 알고 있어야 함",
  ];

  for (const input of planningCases) {
    assert.equal(isExplicitTaskStatusRequest(input), false, input);
  }
});

test("isExplicitDevHandoffRequest separates Codex mentions from handoff commands", () => {
  const explicitCases = [
    "코덱스에게 전달해서 반영해줘",
    "VS Code 세션에 넘겨서 처리해줘",
    "데탑클로한테 이 코드 수정 맡겨",
  ];

  for (const input of explicitCases) {
    assert.equal(isExplicitDevHandoffRequest(input), true, input);
  }

  const mentionOnlyCases = [
    "현재 내 PC의 활성 세션(데탑클로, 코덱스)에서 수행하고 있는 작업을 알고 있어야 함",
    "코덱스가 작업 완료 신호를 보내면 비교해야 함",
    "코덱스가 수정하고 있어",
    "Codex가 이 작업을 수정할 거야",
  ];

  for (const input of mentionOnlyCases) {
    assert.equal(isExplicitDevHandoffRequest(input), false, input);
    assert.equal(router.classify(input).intent, "general_chat", input);
  }
});

test("IntentRouter does not hijack Obsidian save requests as Brain memory writes", () => {
  const cases = [
    "계획서 옵시디언에 저장해줘",
    "맘바 관련해서 심층 리서치 후에 옵시디언 저장해줘",
    "AI학습에 문서로 추가해줘",
    "비교 분석 문서를 작성해서 저장해줘",
    "다음 폴더내 설계서 저장 D:\\Projects\\Sentinel",
    "D:\\Projects\\Sentinel에 설계서 저장",
  ];

  for (const input of cases) {
    const decision = router.classify(input);
    assert.notEqual(decision.intent, "memory_write_candidate", input);
    assert.notEqual(decision.safety, "needs_confirmation", input);
  }
});

test("isExplicitMemoryWriteRequest requires memory target and rejects file save requests", () => {
  assert.equal(isExplicitMemoryWriteRequest("이거 기억해둬"), true);
  assert.equal(isExplicitMemoryWriteRequest("브레인에 저장해줘"), true);

  for (const input of [
    "다음 폴더내 설계서 저장 D:\\Projects\\Sentinel",
    "D:\\Projects\\Sentinel에 설계서 저장",
    "비교 분석 문서를 작성해서 저장해줘",
  ]) {
    assert.equal(isExplicitMemoryWriteRequest(input), false, input);
    assert.notEqual(router.classify(input).intent, "memory_write_candidate", input);
  }
});


test("IntentRouter does not treat local path work as dev handoff", () => {
  const input = "D:\\Projects\\harnessOpt 여기다가도 좀 하고";
  const decision = router.classify(input);
  assert.equal(isExplicitProjectWorkRequest(input), true);
  assert.equal(isExplicitProjectWorkRequest("D:\\Projects\\Brain 수정해줘"), true);
  assert.equal(decision.intent, "general_chat");
  assert.equal(decision.safety, "pass_to_llm");
});

test("isExplicitProjectWorkRequest does not treat web URLs as local project paths", () => {
  for (const input of [
    "https://code.claude.com/docs/en/desktop-ios-simulator",
    "이 링크 분석해줘 https://code.claude.com/docs/en/desktop-ios-simulator",
  ]) {
    assert.equal(isExplicitProjectWorkRequest(input), false, input);
  }

  assert.equal(isExplicitProjectWorkRequest("D:\\Projects\\Brain 수정해줘"), true);
  assert.equal(isExplicitProjectWorkRequest("\\\\server\\share\\Brain 수정해줘"), true);
});

test("IntentRouter does not treat path inquiries as project work", () => {
  for (const input of [
    "D:\\Projects\\Sentinel 경로 맞아?",
    "D:\\Projects\\Sentinel 상태 확인만",
  ]) {
    assert.equal(isExplicitProjectWorkRequest(input), false, input);
    assert.notEqual(router.classify(input).intent, "dev_handoff", input);
  }
});
test("IntentRouter routes document save plus Codex handoff wording to dev handoff", () => {
  const decision = router.classify(
    "비교 분석 문서를 개발 작성해서 저장해줘 코덱스에게 전달해서 반영할 수 있는 건 하고 싶어",
  );

  assert.equal(decision.intent, "dev_handoff");
  assert.equal(decision.safety, "needs_confirmation");
});

test("IntentRouter extracts privacy and meeting entities", () => {
  assert.equal(router.classify("이 방에서 내 개인 기억 쓰지 마").entities.action, "disable");
  assert.equal(router.classify("이번 답변만 내 개인 기억 참고해").entities.scope, "once");
  assert.equal(router.classify("회의 종료 정밀").entities.summaryMode, "precise");
});




