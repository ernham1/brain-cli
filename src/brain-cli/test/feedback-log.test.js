"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  logFeedback, readFeedbackLog, analyzeFeedback,
  applyTriggerSuggestions, clearFeedbackLog
} = require("../src/feedback-log");

// 픽스처 헬퍼
function createFeedbackBrain() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-fb-"));
  const indexDir = path.join(tmpDir, "90_index");
  const strategiesDir = path.join(tmpDir, "30_topics", "meta_strategies");
  fs.mkdirSync(indexDir, { recursive: true });
  fs.mkdirSync(strategiesDir, { recursive: true });

  // 빈 피드백 로그
  fs.writeFileSync(path.join(indexDir, ".meta_feedback_log.jsonl"), "", "utf-8");

  // 테스트용 전략 파일
  fs.writeFileSync(path.join(strategiesDir, "bugfix.json"), JSON.stringify({
    name: "bugfix",
    trigger_pattern: ["버그", "오류", "에러", "error", "fix"],
    recall_sequence: [{ step: 1, query_template: "{task_keywords}", type_filter: null }],
    effectiveness_score: 0.0
  }, null, 2));

  fs.writeFileSync(path.join(strategiesDir, "design.json"), JSON.stringify({
    name: "design",
    trigger_pattern: ["디자인", "UI", "CSS"],
    recall_sequence: [{ step: 1, query_template: "{task_keywords}", type_filter: null }],
    effectiveness_score: 0.0
  }, null, 2));

  return tmpDir;
}

// --- logFeedback ---

describe("feedback-log: logFeedback", () => {
  let brainRoot;

  before(() => { brainRoot = createFeedbackBrain(); });
  after(() => { fs.rmSync(brainRoot, { recursive: true, force: true }); });

  it("피드백 이벤트를 로그에 기록한다", () => {
    logFeedback(brainRoot, {
      strategyName: "bugfix",
      feedbackType: "negative",
      message: "서버가 느려졌어",
      score: 0.5
    });

    const logs = readFeedbackLog(brainRoot);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].strategyName, "bugfix");
    assert.equal(logs[0].feedbackType, "negative");
    assert.ok(logs[0].tokens.length > 0);
  });

  it("여러 이벤트가 누적된다", () => {
    logFeedback(brainRoot, {
      strategyName: "bugfix",
      feedbackType: "negative",
      message: "서버가 느려졌어",
      score: 0.3
    });

    const logs = readFeedbackLog(brainRoot);
    assert.equal(logs.length, 2);
  });
});

// --- analyzeFeedback ---

describe("feedback-log: analyzeFeedback", () => {
  let brainRoot;

  before(() => {
    brainRoot = createFeedbackBrain();

    // negative 3건 — 공통 토큰 "서버", "느려"
    logFeedback(brainRoot, { strategyName: "bugfix", feedbackType: "negative", message: "서버가 느려졌어" });
    logFeedback(brainRoot, { strategyName: "bugfix", feedbackType: "negative", message: "서버 응답이 느려" });
    logFeedback(brainRoot, { strategyName: "bugfix", feedbackType: "negative", message: "서버 타임아웃 발생" });
    // positive 1건
    logFeedback(brainRoot, { strategyName: "bugfix", feedbackType: "positive", message: "버그 수정 완료" });
  });
  after(() => { fs.rmSync(brainRoot, { recursive: true, force: true }); });

  it("negative 피드백의 공통 토큰을 제안 트리거로 추출한다", () => {
    const strategies = [{
      content: {
        name: "bugfix",
        trigger_pattern: ["버그", "오류", "에러", "error", "fix"]
      }
    }];

    const suggestions = analyzeFeedback(brainRoot, strategies);
    assert.ok(suggestions.length > 0);

    const bugfixSuggestion = suggestions.find(s => s.strategyName === "bugfix");
    assert.ok(bugfixSuggestion);
    assert.ok(bugfixSuggestion.suggestedTriggers.includes("서버"));
    assert.equal(bugfixSuggestion.negativeCount, 3);
    assert.equal(bugfixSuggestion.positiveCount, 1);
  });

  it("positive 토큰은 제안에서 제외한다", () => {
    const strategies = [{
      content: {
        name: "bugfix",
        trigger_pattern: ["버그", "오류", "에러", "error", "fix"]
      }
    }];

    const suggestions = analyzeFeedback(brainRoot, strategies);
    const bugfixSuggestion = suggestions.find(s => s.strategyName === "bugfix");
    // "수정"은 positive에도 있으므로 제외되어야 함
    assert.ok(!bugfixSuggestion.suggestedTriggers.includes("수정"));
  });

  it("기존 trigger에 있는 토큰은 제안하지 않는다", () => {
    const strategies = [{
      content: {
        name: "bugfix",
        trigger_pattern: ["버그", "오류", "에러", "error", "fix", "서버"]
      }
    }];

    const suggestions = analyzeFeedback(brainRoot, strategies);
    const bugfixSuggestion = suggestions.find(s => s.strategyName === "bugfix");
    assert.ok(!bugfixSuggestion.suggestedTriggers.includes("서버"));
  });
});

// --- applyTriggerSuggestions ---

describe("feedback-log: applyTriggerSuggestions", () => {
  let brainRoot;

  before(() => { brainRoot = createFeedbackBrain(); });
  after(() => { fs.rmSync(brainRoot, { recursive: true, force: true }); });

  it("새 트리거를 전략 파일에 추가한다", () => {
    const result = applyTriggerSuggestions(brainRoot, "bugfix", ["서버", "느려"]);
    assert.equal(result.applied, true);
    assert.equal(result.addedCount, 2);

    // 파일에 실제로 반영됐는지 확인
    const raw = fs.readFileSync(
      path.join(brainRoot, "30_topics", "meta_strategies", "bugfix.json"), "utf8"
    );
    const content = JSON.parse(raw);
    assert.ok(content.trigger_pattern.includes("서버"));
    assert.ok(content.trigger_pattern.includes("느려"));
  });

  it("이미 있는 트리거는 중복 추가하지 않는다", () => {
    const result = applyTriggerSuggestions(brainRoot, "bugfix", ["버그", "서버"]);
    assert.equal(result.addedCount, 0);
  });

  it("존재하지 않는 전략은 applied=false", () => {
    const result = applyTriggerSuggestions(brainRoot, "nonexist", ["test"]);
    assert.equal(result.applied, false);
  });
});

// --- clearFeedbackLog ---

describe("feedback-log: clearFeedbackLog", () => {
  let brainRoot;

  before(() => {
    brainRoot = createFeedbackBrain();
    logFeedback(brainRoot, { strategyName: "test", feedbackType: "negative", message: "test" });
  });
  after(() => { fs.rmSync(brainRoot, { recursive: true, force: true }); });

  it("피드백 로그를 비운다", () => {
    assert.ok(readFeedbackLog(brainRoot).length > 0);
    clearFeedbackLog(brainRoot);
    assert.equal(readFeedbackLog(brainRoot).length, 0);
  });
});
