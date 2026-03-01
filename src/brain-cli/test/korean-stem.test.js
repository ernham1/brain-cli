"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { stemKorean, normalizeTokens } = require("../src/utils");

// === SB01: KoreanStemmer 테스트 ===

describe("REQ-200: stemKorean 함수 구조", () => {
  it("stemKorean 함수가 export 된다", () => {
    assert.equal(typeof stemKorean, "function");
  });

  it("문자열을 받아 문자열을 반환한다", () => {
    const result = stemKorean("테스트");
    assert.equal(typeof result, "string");
  });
});

describe("REQ-201: 조사 제거", () => {
  it("'선택을' → '선택' (을 제거)", () => {
    assert.equal(stemKorean("선택을"), "선택");
  });

  it("'디자인은' → '디자인' (은 제거)", () => {
    assert.equal(stemKorean("디자인은"), "디자인");
  });

  it("'프로젝트의' → '프로젝트' (의 제거)", () => {
    assert.equal(stemKorean("프로젝트의"), "프로젝트");
  });

  it("'설정에서' → '설정' (에서 제거)", () => {
    assert.equal(stemKorean("설정에서"), "설정");
  });

  it("'사용자에게' → '사용자' (에게 제거)", () => {
    assert.equal(stemKorean("사용자에게"), "사용자");
  });

  it("'버그를' → '버그' (를 제거)", () => {
    assert.equal(stemKorean("버그를"), "버그");
  });
});

describe("REQ-202: 어미 제거", () => {
  it("'선택할까' → '선택' (할까 제거)", () => {
    assert.equal(stemKorean("선택할까"), "선택");
  });

  it("'검토해줘' → '검토' (해줘 제거)", () => {
    assert.equal(stemKorean("검토해줘"), "검토");
  });

  it("'수정하면' → '수정' (하면 제거)", () => {
    assert.equal(stemKorean("수정하면"), "수정");
  });

  it("'확인해야' → '확인' (해야 제거)", () => {
    assert.equal(stemKorean("확인해야"), "확인");
  });

  it("'실행합니다' → '실행' (합니다 제거)", () => {
    assert.equal(stemKorean("실행합니다"), "실행");
  });
});

describe("REQ-203: longest-match-first 전략", () => {
  it("'디자인에서' → '디자인' ('에서' 우선, '에'가 아님)", () => {
    assert.equal(stemKorean("디자인에서"), "디자인");
  });

  it("'코드으로' → '코드' ('으로' 우선, '로'가 아님)", () => {
    assert.equal(stemKorean("코드으로"), "코드");
  });
});

describe("REQ-204: 과도한 스테밍 방지", () => {
  it("'해' → '해' (1자이므로 원본 유지)", () => {
    assert.equal(stemKorean("해"), "해");
  });

  it("'가' → '가' (조사와 동형이지만 1자이므로 원본 유지)", () => {
    assert.equal(stemKorean("가"), "가");
  });

  it("이미 원형인 토큰은 그대로 반환 — '버그' → '버그'", () => {
    assert.equal(stemKorean("버그"), "버그");
  });
});

describe("REQ-205: 영문/숫자 바이패스", () => {
  it("'CSS' → 'CSS' (영문 그대로)", () => {
    assert.equal(stemKorean("CSS"), "CSS");
  });

  it("'UI' → 'UI' (영문 그대로)", () => {
    assert.equal(stemKorean("UI"), "UI");
  });

  it("'123' → '123' (숫자 그대로)", () => {
    assert.equal(stemKorean("123"), "123");
  });
});

describe("REQ-206: normalizeTokens 파이프라인", () => {
  it("normalizeTokens 함수가 export 된다", () => {
    assert.equal(typeof normalizeTokens, "function");
  });

  it("공백 기준 분리 + 1자 필터 + stem + lowercase", () => {
    const result = normalizeTokens("버그를 고쳐줘");
    assert.ok(Array.isArray(result));
    assert.ok(result.includes("버그"));
  });

  it("빈 문자열은 빈 배열 반환", () => {
    const result = normalizeTokens("");
    assert.deepEqual(result, []);
  });

  it("영문 토큰은 소문자 변환", () => {
    const result = normalizeTokens("CSS 레이아웃");
    assert.ok(result.includes("css"));
    assert.ok(result.includes("레이아웃"));
  });

  it("한글 조사가 제거된 토큰을 반환한다", () => {
    const result = normalizeTokens("선택을 검토해줘");
    assert.ok(result.includes("선택"));
    assert.ok(result.includes("검토"));
  });
});

// === REQ-225: 불규칙 활용 어간 매핑 ===

describe("REQ-225: 불규칙 활용 어간 매핑", () => {
  // ㅎ불규칙
  it("'고쳐줘' → stem '고쳐' → map '고치'", () => {
    assert.equal(stemKorean("고쳐줘"), "고치");
  });

  // 르불규칙
  it("'골라줘' → stem '골라' → map '고르'", () => {
    assert.equal(stemKorean("골라줘"), "고르");
  });

  // ㅅ불규칙
  it("'지어줘' → stem '지어' → map '짓'", () => {
    assert.equal(stemKorean("지어줘"), "짓");
  });

  // ㅂ불규칙
  it("'도와줘' → stem '도와' → map '돕'", () => {
    assert.equal(stemKorean("도와줘"), "돕");
  });

  // ㄷ불규칙
  it("'들어줘' → stem '들어' → map '듣'", () => {
    assert.equal(stemKorean("들어줘"), "듣");
  });

  it("'물어줘' → stem '물어' → map '묻'", () => {
    assert.equal(stemKorean("물어줘"), "묻");
  });

  it("'걸어줘' → stem '걸어' → map '걷'", () => {
    assert.equal(stemKorean("걸어줘"), "걷");
  });

  // 르불규칙
  it("'불러줘' → stem '불러' → map '부르'", () => {
    assert.equal(stemKorean("불러줘"), "부르");
  });

  it("'몰라' → map '모르'", () => {
    assert.equal(stemKorean("몰라"), "모르");
  });

  // ㅂ불규칙
  it("'쉬워' → map '쉽'", () => {
    assert.equal(stemKorean("쉬워"), "쉽");
  });

  it("'어려워' → map '어렵'", () => {
    assert.equal(stemKorean("어려워"), "어렵");
  });

  // 불규칙 매핑에 해당하지 않는 경우
  it("이미 원형인 토큰은 매핑하지 않음 — '고치' → '고치'", () => {
    assert.equal(stemKorean("고치"), "고치");
  });

  // normalizeTokens에서의 통합 동작
  it("normalizeTokens — '고쳐줘' → ['고치']", () => {
    const result = normalizeTokens("버그를 고쳐줘");
    assert.ok(result.includes("버그"), "버그 포함");
    assert.ok(result.includes("고치"), "고치 포함 (불규칙 매핑)");
  });
});
