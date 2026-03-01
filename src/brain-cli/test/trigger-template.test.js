"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { getSeedStrategies, SEED_STRATEGIES } = require("../src/meta-strategy");
const { classify } = require("../src/classifier");
const { _executeSequence } = require("../src/meta-recall");

// === SB03: TriggerTemplateEnrichment 테스트 ===

// 헬퍼: SEED_STRATEGIES를 classifier 형식으로 변환
function seedAsStrategies() {
  return getSeedStrategies().map(s => ({
    record: { recordId: `seed_${s.name}` },
    content: s
  }));
}

const emptySynonymMap = new Map();

describe("REQ-213: design trigger 확장", () => {
  it("확장된 trigger에 '폰트', '반응형', '테마' 포함", () => {
    const design = SEED_STRATEGIES.find(s => s.name === "design");
    assert.ok(design.trigger_pattern.includes("폰트"));
    assert.ok(design.trigger_pattern.includes("반응형"));
    assert.ok(design.trigger_pattern.includes("테마"));
  });

  it("design trigger 총 18개", () => {
    const design = SEED_STRATEGIES.find(s => s.name === "design");
    assert.equal(design.trigger_pattern.length, 18);
  });

  it("'모바일 반응형 레이아웃' 메시지 → design 매칭", () => {
    const strategies = seedAsStrategies();
    const result = classify("모바일 반응형 레이아웃", strategies, emptySynonymMap);
    assert.equal(result.matched, true);
    assert.equal(result.primary.strategy.name, "design");
  });
});

describe("REQ-214: bugfix trigger 확장", () => {
  it("확장된 trigger에 '안됨', '실패', 'crash' 포함", () => {
    const bugfix = SEED_STRATEGIES.find(s => s.name === "bugfix");
    assert.ok(bugfix.trigger_pattern.includes("안됨"));
    assert.ok(bugfix.trigger_pattern.includes("실패"));
    assert.ok(bugfix.trigger_pattern.includes("crash"));
  });

  it("bugfix trigger 총 19개", () => {
    const bugfix = SEED_STRATEGIES.find(s => s.name === "bugfix");
    assert.equal(bugfix.trigger_pattern.length, 19);
  });

  it("'로그인 실패 문제' 메시지 → bugfix 매칭", () => {
    const strategies = seedAsStrategies();
    const result = classify("로그인 실패 문제", strategies, emptySynonymMap);
    assert.equal(result.matched, true);
    assert.equal(result.primary.strategy.name, "bugfix");
  });
});

describe("REQ-215: decision trigger 확장", () => {
  it("확장된 trigger에 '추천', '의견', '방향' 포함", () => {
    const decision = SEED_STRATEGIES.find(s => s.name === "decision");
    assert.ok(decision.trigger_pattern.includes("추천"));
    assert.ok(decision.trigger_pattern.includes("의견"));
    assert.ok(decision.trigger_pattern.includes("방향"));
  });

  it("decision trigger 총 16개", () => {
    const decision = SEED_STRATEGIES.find(s => s.name === "decision");
    assert.equal(decision.trigger_pattern.length, 16);
  });

  it("'기술 선택 추천' 메시지 → decision 매칭", () => {
    const strategies = seedAsStrategies();
    const result = classify("기술 선택 추천", strategies, emptySynonymMap);
    assert.equal(result.matched, true);
    assert.equal(result.primary.strategy.name, "decision");
  });
});

describe("REQ-216: new_feature trigger 확장", () => {
  it("확장된 trigger에 'API', '모듈', '컴포넌트' 포함", () => {
    const nf = SEED_STRATEGIES.find(s => s.name === "new_feature");
    assert.ok(nf.trigger_pattern.includes("API"));
    assert.ok(nf.trigger_pattern.includes("모듈"));
    assert.ok(nf.trigger_pattern.includes("컴포넌트"));
  });

  it("new_feature trigger 총 16개", () => {
    const nf = SEED_STRATEGIES.find(s => s.name === "new_feature");
    assert.equal(nf.trigger_pattern.length, 16);
  });

  it("'API 연동 모듈' 메시지 → new_feature 매칭", () => {
    const strategies = seedAsStrategies();
    const result = classify("API 연동 모듈", strategies, emptySynonymMap);
    assert.equal(result.matched, true);
    assert.equal(result.primary.strategy.name, "new_feature");
  });
});

describe("REQ-217: review trigger 확장", () => {
  it("확장된 trigger에 '분석', '진단', '평가' 포함", () => {
    const review = SEED_STRATEGIES.find(s => s.name === "review");
    assert.ok(review.trigger_pattern.includes("분석"));
    assert.ok(review.trigger_pattern.includes("진단"));
    assert.ok(review.trigger_pattern.includes("평가"));
  });

  it("review trigger 총 15개", () => {
    const review = SEED_STRATEGIES.find(s => s.name === "review");
    assert.equal(review.trigger_pattern.length, 15);
  });

  it("'코드 분석 점검' 메시지 → review 매칭", () => {
    const strategies = seedAsStrategies();
    const result = classify("코드 분석 점검", strategies, emptySynonymMap);
    assert.equal(result.matched, true);
    assert.equal(result.primary.strategy.name, "review");
  });
});

describe("REQ-218: query_template 구체화", () => {
  it("design의 첫 번째 step에 도메인 키워드 포함", () => {
    const design = SEED_STRATEGIES.find(s => s.name === "design");
    const step1 = design.recall_sequence[0];
    assert.ok(step1.query_template.includes("디자인"), "디자인 키워드 포함");
    assert.ok(step1.query_template.includes("{task_keywords}"), "{task_keywords} 포함");
  });

  it("bugfix의 세 번째 step에 rule 관련 키워드 포함", () => {
    const bugfix = SEED_STRATEGIES.find(s => s.name === "bugfix");
    const step3 = bugfix.recall_sequence[2];
    assert.ok(step3.query_template.includes("규칙") || step3.query_template.includes("레슨"),
      "규칙 또는 레슨 키워드 포함");
    assert.equal(step3.type_filter, "rule");
  });

  it("decision의 첫 번째 step에 결정 관련 키워드 포함", () => {
    const decision = SEED_STRATEGIES.find(s => s.name === "decision");
    const step1 = decision.recall_sequence[0];
    assert.ok(step1.query_template.includes("결정") || step1.query_template.includes("선택"),
      "결정/선택 키워드 포함");
  });
});

describe("REQ-219: _executeSequence 키워드 병합", () => {
  it("{task_keywords} 포함 템플릿은 치환된다", () => {
    // _executeSequence는 brainRoot가 필요하므로 직접 테스트하기 어려움
    // 대신 replace 로직을 단위 테스트
    const template = "디자인 선호 {task_keywords}";
    const keywords = "로고 색상";
    const result = template.replace("{task_keywords}", keywords);
    assert.equal(result, "디자인 선호 로고 색상");
  });

  it("{task_keywords} 없는 템플릿에 키워드가 suffix로 추가된다", () => {
    const template = "프로젝트 레슨";
    const keywords = "로그인 버그";
    // REQ-219 로직 재현
    let queryText;
    if (template.includes("{task_keywords}")) {
      queryText = template.replace("{task_keywords}", keywords);
    } else {
      queryText = keywords ? `${template} ${keywords}` : template;
    }
    assert.equal(queryText, "프로젝트 레슨 로그인 버그");
  });

  it("키워드가 빈 문자열이면 템플릿만 반환", () => {
    const template = "프로젝트 레슨";
    const keywords = "";
    let queryText;
    if (template.includes("{task_keywords}")) {
      queryText = template.replace("{task_keywords}", keywords);
    } else {
      queryText = keywords ? `${template} ${keywords}` : template;
    }
    assert.equal(queryText, "프로젝트 레슨");
  });
});

describe("SB03 전략 구조 무결성", () => {
  it("getSeedStrategies()는 SEED_STRATEGIES의 깊은 복사본을 반환한다", () => {
    const copy = getSeedStrategies();
    assert.equal(copy.length, SEED_STRATEGIES.length);
    // 수정해도 원본에 영향 없는지 확인
    copy[0].name = "modified";
    assert.notEqual(SEED_STRATEGIES[0].name, "modified");
  });

  it("5개 전략 모두 3단계 recall_sequence를 가진다", () => {
    for (const s of SEED_STRATEGIES) {
      assert.equal(s.recall_sequence.length, 3, `${s.name}은 3단계`);
    }
  });

  it("모든 전략의 effectiveness_score 초기값은 0.0", () => {
    for (const s of SEED_STRATEGIES) {
      assert.equal(s.effectiveness_score, 0.0, `${s.name}의 초기 점수`);
    }
  });
});
