"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { classify } = require("../src/classifier");
const { search, createSessionContext } = require("../src/search");
const { getSeedStrategies, SEED_STRATEGIES } = require("../src/meta-strategy");
const { normalizeTokens, stemKorean, _resetSynonymCache } = require("../src/utils");

// === SB04: IntegrationRegression E2E 테스트 ===

// 헬퍼: SEED_STRATEGIES를 classifier 형식으로 변환
function seedAsStrategies() {
  return getSeedStrategies().map(s => ({
    record: { recordId: `seed_${s.name}` },
    content: s
  }));
}

// 헬퍼: 동의어 맵 생성
function makeSynonymMap(entries) {
  const map = new Map();
  for (const [key, values] of entries) {
    map.set(key, values);
  }
  return map;
}

// 통합 테스트용 Brain 픽스처
function createE2EBrain() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-e2e-"));
  const indexDir = path.join(tmpDir, "90_index");
  fs.mkdirSync(indexDir, { recursive: true });

  // tags.json (동의어 포함)
  fs.writeFileSync(path.join(indexDir, "tags.json"), JSON.stringify({
    domain: { synonyms: { frontend: "ui" } },
    intent: { synonyms: { search: "retrieval" } },
    general_synonyms: {
      "프론트엔드": ["ui", "frontend", "화면"],
      "버그": ["오류", "에러", "error", "bug"],
      "디자인": ["design", "스타일"]
    }
  }));

  const now = new Date();
  const d3 = new Date(now - 3 * 86400000).toISOString();
  const d7 = new Date(now - 7 * 86400000).toISOString();

  // records_digest.txt
  const digestLines = [
    "# Format: recordId | title | summary | tags | status | type | sourceType | updatedAt",
    `rec_design1 | 디자인 시스템 가이드 | UI 컴포넌트 스타일 규칙 | domain/ui | active | note | user_confirmed | ${d3}`,
    `rec_bug1 | 로그인 버그 수정 기록 | 로그인 실패 원인과 해결법 | domain/auth | active | note | candidate | ${d3}`,
    `rec_decision1 | 프레임워크 선택 결정 | React vs Vue 비교 후 React 선택 | domain/ui | active | decision | user_confirmed | ${d7}`,
    `rec_feature1 | API 연동 모듈 설계 | REST API 통합 아키텍처 | domain/infra | active | note | candidate | ${d7}`,
    `rec_review1 | 코드 리뷰 체크리스트 | 코드 품질 점검 항목 | domain/devops | active | rule | candidate | ${d7}`,
    `rec_frontend1 | 프론트엔드 화면 구성 | 화면 레이아웃과 스타일 가이드 | domain/ui | active | note | candidate | ${d3}`
  ].join("\n");

  fs.writeFileSync(path.join(indexDir, "records_digest.txt"), digestLines);
  fs.writeFileSync(path.join(indexDir, "records.jsonl"), "", "utf-8");

  return tmpDir;
}

// ─── REQ-220: 한글 활용형 E2E ───

describe("REQ-220: 한글 활용형 E2E 매칭", () => {
  const strategies = seedAsStrategies();
  const emptySynonymMap = new Map();

  it("'버그를 고쳐줘' → bugfix 전략 매칭", () => {
    const result = classify("버그를 고쳐줘", strategies, emptySynonymMap);
    assert.equal(result.matched, true);
    assert.equal(result.primary.strategy.name, "bugfix");
  });

  it("'디자인을 검토해줘' → design 또는 review 매칭", () => {
    const result = classify("디자인을 검토해줘", strategies, emptySynonymMap);
    assert.equal(result.matched, true);
    const primaryName = result.primary.strategy.name;
    assert.ok(
      primaryName === "design" || primaryName === "review",
      `primary는 design 또는 review: ${primaryName}`
    );
  });

  it("'어떤 기술을 선택할까' → decision 전략 매칭", () => {
    const result = classify("어떤 기술을 선택할까", strategies, emptySynonymMap);
    assert.equal(result.matched, true);
    assert.equal(result.primary.strategy.name, "decision");
  });

  it("'새로운 API 모듈을 만들어줘' → new_feature 매칭", () => {
    const result = classify("새로운 API 모듈을 만들어줘", strategies, emptySynonymMap);
    assert.equal(result.matched, true);
    assert.equal(result.primary.strategy.name, "new_feature");
  });

  it("'코드 분석해줘' → review 매칭", () => {
    const result = classify("코드 분석해줘", strategies, emptySynonymMap);
    assert.equal(result.matched, true);
    assert.equal(result.primary.strategy.name, "review");
  });
});

// ─── REQ-222: 동의어 + stem 복합 시나리오 ───

describe("REQ-222: 동의어+stem 복합 매칭", () => {
  const strategies = seedAsStrategies();

  it("'프론트엔드 화면을 수정해줘' → stem+synonym → design 매칭", () => {
    // "화면을" → stem → "화면"
    // synonym: "화면" → "프론트엔드" → "ui" → design trigger
    const synonymMap = makeSynonymMap([
      ["화면", ["ui", "프론트엔드"]],
      ["프론트엔드", ["ui", "화면"]],
      ["ui", ["화면", "프론트엔드"]]
    ]);
    const result = classify("프론트엔드 화면을 수정해줘", strategies, synonymMap);
    assert.equal(result.matched, true);
    assert.equal(result.primary.strategy.name, "design");
  });

  it("'에러를 수정해줘' → stem(에러를→에러, 수정해줘→수정) → bugfix", () => {
    const result = classify("에러를 수정해줘", strategies, new Map());
    assert.equal(result.matched, true);
    assert.equal(result.primary.strategy.name, "bugfix");
  });

  it("'결정사항을 검토해줘' → stem+dual match → decision 또는 review", () => {
    const result = classify("결정사항을 검토해줘", strategies, new Map());
    assert.equal(result.matched, true);
    // "결정" 은 decision trigger에 포함 (substring match 가능)
    // "검토" 는 review trigger에 포함
    const name = result.primary.strategy.name;
    assert.ok(name === "decision" || name === "review",
      `primary는 decision 또는 review: ${name}`);
  });
});

// ─── REQ-223: 성능 회귀 테스트 ───

describe("REQ-223: 성능 회귀 테스트", () => {
  let brainRoot;

  before(() => {
    _resetSynonymCache();
    brainRoot = createE2EBrain();
  });

  after(() => {
    fs.rmSync(brainRoot, { recursive: true, force: true });
    _resetSynonymCache();
  });

  it("search 100회 반복 — 기존 대비 2배 이내 (5초 제한)", () => {
    const iterations = 100;
    const queries = [
      "버그를 고쳐줘",
      "디자인 검토해줘",
      "어떤 프레임워크를 선택할까",
      "프론트엔드 화면 수정",
      "코드 리뷰 체크리스트"
    ];

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const q = queries[i % queries.length];
      search(brainRoot, { currentGoal: q, topK: 10 });
    }
    const elapsed = performance.now() - start;

    // 100회 검색이 5초 이내여야 함 (충분히 여유있는 기준)
    assert.ok(elapsed < 5000,
      `100회 검색 ${elapsed.toFixed(0)}ms — 5초 제한 초과`);
  });

  it("normalizeTokens+stemKorean 1000회 반복 — 100ms 이내", () => {
    const messages = [
      "버그를 고쳐줘",
      "디자인에서 색상을 변경해줘",
      "어떤 기술을 선택할까",
      "새로운 컴포넌트를 추가해줘",
      "코드 검토해줘 피드백 주세요"
    ];

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      normalizeTokens(messages[i % messages.length]);
    }
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 100,
      `normalizeTokens 1000회: ${elapsed.toFixed(1)}ms — 100ms 제한 초과`);
  });

  it("classify 100회 반복 — 500ms 이내", () => {
    const strategies = seedAsStrategies();
    const synonymMap = new Map();
    const messages = [
      "버그를 고쳐줘",
      "디자인 검토해줘",
      "기술 선택 추천",
      "API 연동 모듈 추가",
      "코드 분석 점검"
    ];

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      classify(messages[i % messages.length], strategies, synonymMap);
    }
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 500,
      `classify 100회: ${elapsed.toFixed(0)}ms — 500ms 제한 초과`);
  });
});

// ─── 한글 스테밍 + 검색 통합 ───

describe("SB04: 한글 stem + search 통합", () => {
  let brainRoot;

  before(() => {
    _resetSynonymCache();
    brainRoot = createE2EBrain();
  });

  after(() => {
    fs.rmSync(brainRoot, { recursive: true, force: true });
    _resetSynonymCache();
  });

  it("'버그를' 검색 → 버그 관련 레코드가 상위에 위치", () => {
    const result = search(brainRoot, {
      currentGoal: "버그를 수정해야 합니다",
      topK: 5
    });
    assert.ok(result.candidates.length > 0, "결과 존재");
    // stem("버그를") = "버그" → 버그 관련 레코드 매칭
    const bugRecord = result.candidates.find(c => c.recordId === "rec_bug1");
    assert.ok(bugRecord, "버그 수정 기록이 결과에 포함");
  });

  it("'화면을 수정해줘' → stem + 동의어 → 디자인/프론트엔드 레코드 매칭", () => {
    const result = search(brainRoot, {
      currentGoal: "화면을 수정해줘",
      topK: 5
    });
    assert.ok(result.candidates.length > 0, "결과 존재");
    // stem("화면을") = "화면" → 동의어 확장으로 ui/프론트엔드 매칭
    const uiRecords = result.candidates.filter(c =>
      c.recordId === "rec_design1" || c.recordId === "rec_frontend1"
    );
    assert.ok(uiRecords.length > 0, "UI/디자인 레코드가 매칭됨");
  });

  it("'프레임워크를 선택할까' → stem 후 검색 결과 포함", () => {
    const result = search(brainRoot, {
      currentGoal: "프레임워크를 선택할까",
      topK: 5
    });
    assert.ok(result.candidates.length > 0, "결과 존재");
    // stem("프레임워크를") = "프레임워크", stem("선택할까") = "선택"
    const decisionRecord = result.candidates.find(c => c.recordId === "rec_decision1");
    assert.ok(decisionRecord, "프레임워크 선택 결정 레코드가 매칭됨");
  });
});
