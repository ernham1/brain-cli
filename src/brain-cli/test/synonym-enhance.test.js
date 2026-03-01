"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { classify } = require("../src/classifier");
const { _expandTokens } = require("../src/search");
const { stemKorean } = require("../src/utils");

// === SB02: SynonymEnhancement 테스트 ===

// 헬퍼: 간단한 전략 생성
function makeStrategy(name, triggers, steps) {
  return {
    record: { recordId: `test_${name}` },
    content: {
      name,
      trigger_pattern: triggers,
      recall_sequence: steps || [{ step: 1, query_template: "{task_keywords}", type_filter: null }]
    }
  };
}

describe("REQ-207: classifier 양방향 동의어 조회", () => {
  it("token 측 동의어가 pattern과 매칭되면 +0.7", () => {
    const strategies = [makeStrategy("test", ["ui"])];
    // synonymMap: frontend → ui
    const synonymMap = new Map([["frontend", ["ui"]]]);
    // 단일 토큰으로 score = 0.7/1 = 0.7 >= 0.4
    const result = classify("frontend", strategies, synonymMap);
    assert.ok(result.primary !== null, "primary가 매칭되어야 함");
    assert.ok(Math.abs(result.primary.score - 0.7) < 0.01, "score ≈ 0.7");
  });

  it("pattern 측 동의어도 token과 매칭되면 +0.7", () => {
    const strategies = [makeStrategy("test", ["frontend"])];
    // synonymMap: frontend → ui
    const synonymMap = new Map([["frontend", ["ui"]]]);
    // "ui" → synonymMap.get(stemKorean("frontend")) → ["ui"] 포함
    // 단일 토큰으로 score = 0.7/1 = 0.7 >= 0.4
    const result = classify("ui", strategies, synonymMap);
    assert.ok(result.matched === true);
    assert.ok(result.primary !== null, "primary가 매칭되어야 함");
  });
});

describe("REQ-208: trigger_pattern에 stemKorean 적용", () => {
  it("stem된 trigger와 stem된 token이 매칭되면 +1.0 (exact)", () => {
    // trigger "선택할까" stem → "선택", message "선택" → exact match
    const strategies = [makeStrategy("test", ["선택할까"])];
    const synonymMap = new Map();
    const result = classify("선택 고민", strategies, synonymMap);
    assert.ok(result.primary !== null, "stem된 trigger가 매칭되어야 함");
  });
});

describe("REQ-209, REQ-212: _expandTokens stem 적용", () => {
  it("stem된 토큰이 원본과 다르면 weight 0.9로 추가된다", () => {
    const tokens = ["선택을"];  // stem → "선택"
    const synonymMap = new Map();
    const expanded = _expandTokens(tokens, synonymMap);
    const stemmed = expanded.find(e => e.source === "stemmed");
    assert.ok(stemmed, "stemmed 소스가 있어야 함");
    assert.equal(stemmed.text, "선택");
    assert.equal(stemmed.weight, 0.9);
  });

  it("이미 원형인 토큰은 stemmed가 추가되지 않는다", () => {
    const tokens = ["버그"];
    const synonymMap = new Map();
    const expanded = _expandTokens(tokens, synonymMap);
    const stemmed = expanded.filter(e => e.source === "stemmed");
    assert.equal(stemmed.length, 0);
  });

  it("영문 토큰은 stemmed가 추가되지 않는다", () => {
    const tokens = ["css"];
    const synonymMap = new Map();
    const expanded = _expandTokens(tokens, synonymMap);
    const stemmed = expanded.filter(e => e.source === "stemmed");
    assert.equal(stemmed.length, 0);
  });
});

describe("REQ-211: 동의어 조회 시 stem된 형태로 비교", () => {
  it("stem된 토큰으로 동의어를 찾을 수 있다", () => {
    const tokens = ["프론트엔드를"];  // stem → "프론트엔드"
    const synonymMap = new Map([["프론트엔드", ["ui", "frontend"]]]);
    const expanded = _expandTokens(tokens, synonymMap);
    const synonyms = expanded.filter(e => e.source === "synonym");
    assert.ok(synonyms.length > 0, "동의어가 확장되어야 함");
    assert.ok(synonyms.some(s => s.text === "ui"));
  });
});
