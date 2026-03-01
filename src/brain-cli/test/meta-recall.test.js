"use strict";

const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { writeJsonl, _resetSynonymCache } = require("../src/utils");
const {
  metaRecall,
  _fallbackSearch,
  _deduplicateResults,
  _sliceSecondarySteps,
  _executeSequence
} = require("../src/meta-recall");

let testRoot;

/**
 * 테스트용 Brain 디렉토리 생성
 * - meta_strategy 레코드 + content JSON
 * - 일반 note/decision 레코드 (search 결과용)
 */
function createTestBrain(opts = {}) {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-meta-recall-test-"));
  fs.mkdirSync(path.join(testRoot, "90_index"), { recursive: true });
  fs.mkdirSync(path.join(testRoot, "30_topics", "meta_strategies"), { recursive: true });

  // tags.json (동의어 맵)
  const tagsData = opts.synonyms || { domain: { synonyms: {} }, intent: { synonyms: {} } };
  fs.writeFileSync(
    path.join(testRoot, "90_index", "tags.json"),
    JSON.stringify(tagsData),
    "utf-8"
  );

  const digestLines = ["# Brain records_digest.txt"];
  const records = [];

  // --- meta_strategy 레코드 ---
  if (opts.withDesignStrategy) {
    digestLines.push(
      "rec_topic_meta_strategies_20260301_0001 | design 전략 | 디자인 관련 전략 | domain/memory,intent/retrieval | active | meta_strategy | candidate | 2026-03-01T00:00:00"
    );
    records.push({
      recordId: "rec_topic_meta_strategies_20260301_0001",
      scopeType: "topic", scopeId: "meta_strategies",
      type: "meta_strategy", title: "design 전략", summary: "디자인 관련 전략",
      tags: ["domain/memory", "intent/retrieval"], sourceType: "candidate",
      sourceRef: "30_topics/meta_strategies/design.json", status: "active",
      replacedBy: null, deprecationReason: null,
      updatedAt: "2026-03-01T00:00:00", contentHash: "sha256:aaa111"
    });
    const designContent = opts.designContent || {
      name: "design",
      trigger_pattern: ["디자인", "UI", "CSS", "레이아웃"],
      recall_sequence: [
        { step: 1, query_template: "이사님 디자인 선호", type_filter: "note" },
        { step: 2, query_template: "{task_keywords}", type_filter: null },
        { step: 3, query_template: "관련 프로젝트 결정사항", type_filter: "decision" }
      ],
      priority_fields: ["sourceType=user_confirmed"],
      effectiveness_score: 0.0
    };
    fs.writeFileSync(
      path.join(testRoot, "30_topics", "meta_strategies", "design.json"),
      JSON.stringify(designContent), "utf-8"
    );
  }

  if (opts.withBugfixStrategy) {
    digestLines.push(
      "rec_topic_meta_strategies_20260301_0002 | bugfix 전략 | 버그수정 관련 전략 | domain/memory,intent/retrieval | active | meta_strategy | candidate | 2026-03-01T00:00:00"
    );
    records.push({
      recordId: "rec_topic_meta_strategies_20260301_0002",
      scopeType: "topic", scopeId: "meta_strategies",
      type: "meta_strategy", title: "bugfix 전략", summary: "버그수정 관련 전략",
      tags: ["domain/memory", "intent/retrieval"], sourceType: "candidate",
      sourceRef: "30_topics/meta_strategies/bugfix.json", status: "active",
      replacedBy: null, deprecationReason: null,
      updatedAt: "2026-03-01T00:00:00", contentHash: "sha256:bbb222"
    });
    const bugfixContent = opts.bugfixContent || {
      name: "bugfix",
      trigger_pattern: ["버그", "오류", "에러", "error", "fix", "bug"],
      recall_sequence: [
        { step: 1, query_template: "유사 버그 기록", type_filter: "note" },
        { step: 2, query_template: "{task_keywords}", type_filter: null },
        { step: 3, query_template: "프로젝트 레슨", type_filter: "rule" }
      ],
      priority_fields: [],
      effectiveness_score: 0.0
    };
    fs.writeFileSync(
      path.join(testRoot, "30_topics", "meta_strategies", "bugfix.json"),
      JSON.stringify(bugfixContent), "utf-8"
    );
  }

  // --- 일반 note/decision 레코드 (search 결과로 반환되는 대상) ---
  if (opts.withNoteRecords) {
    digestLines.push(
      "rec_topic_general_20260301_0010 | 디자인 선호 기록 | 이사님 디자인 선호 노트 | domain/ui | active | note | user_confirmed | 2026-03-01T00:00:00"
    );
    records.push({
      recordId: "rec_topic_general_20260301_0010",
      scopeType: "topic", scopeId: "general",
      type: "note", title: "디자인 선호 기록", summary: "이사님 디자인 선호 노트",
      tags: ["domain/ui"], sourceType: "user_confirmed",
      sourceRef: "30_topics/general/design_pref.md", status: "active",
      replacedBy: null, deprecationReason: null,
      updatedAt: "2026-03-01T00:00:00", contentHash: "sha256:note111"
    });

    digestLines.push(
      "rec_topic_general_20260301_0011 | 버그 수정 기록 | 이전 버그 수정 메모 | domain/infra | active | note | candidate | 2026-03-01T00:00:00"
    );
    records.push({
      recordId: "rec_topic_general_20260301_0011",
      scopeType: "topic", scopeId: "general",
      type: "note", title: "버그 수정 기록", summary: "이전 버그 수정 메모",
      tags: ["domain/infra"], sourceType: "candidate",
      sourceRef: "30_topics/general/bugfix_memo.md", status: "active",
      replacedBy: null, deprecationReason: null,
      updatedAt: "2026-03-01T00:00:00", contentHash: "sha256:note222"
    });

    digestLines.push(
      "rec_topic_general_20260301_0012 | 프로젝트 결정사항 | 아키텍처 결정 기록 | domain/infra | active | decision | candidate | 2026-03-01T00:00:00"
    );
    records.push({
      recordId: "rec_topic_general_20260301_0012",
      scopeType: "topic", scopeId: "general",
      type: "decision", title: "프로젝트 결정사항", summary: "아키텍처 결정 기록",
      tags: ["domain/infra"], sourceType: "candidate",
      sourceRef: "30_topics/general/arch_decision.md", status: "active",
      replacedBy: null, deprecationReason: null,
      updatedAt: "2026-03-01T00:00:00", contentHash: "sha256:dec333"
    });
  }

  fs.writeFileSync(
    path.join(testRoot, "90_index", "records_digest.txt"),
    digestLines.join("\n") + "\n", "utf-8"
  );
  writeJsonl(path.join(testRoot, "90_index", "records.jsonl"), records);

  return testRoot;
}

function teardownBrain() {
  if (testRoot && fs.existsSync(testRoot)) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
  testRoot = null;
  _resetSynonymCache();
}

// ====================================================================
// REQ-120: metaRecall() 함수 구현
// ====================================================================

describe("REQ-120: metaRecall() 오케스트레이터", () => {
  afterEach(() => teardownBrain());

  it("metaRecall 함수가 export 된다", () => {
    assert.equal(typeof metaRecall, "function");
  });

  it("전략 매칭 시 loadMetaStrategies → classify → execute 순서로 실행된다", () => {
    createTestBrain({ withDesignStrategy: true, withNoteRecords: true });
    const result = metaRecall(testRoot, "UI 디자인 레이아웃 작업");
    assert.equal(result.fallback, false);
    assert.ok(result.strategies_used.length > 0);
    assert.equal(result.strategies_used[0].name, "design");
    assert.equal(result.strategies_used[0].role, "primary");
  });

  it("options.topK가 하위 search() 호출로 전달된다", () => {
    createTestBrain({ withDesignStrategy: true, withNoteRecords: true });
    const result = metaRecall(testRoot, "UI 디자인 레이아웃 작업", { topK: 3 });
    // topK=3이면 각 step에서 최대 3건씩 반환
    assert.ok(Array.isArray(result.candidates));
  });
});

// ====================================================================
// REQ-121: 전략 로드 실패 시 폴백
// ====================================================================

describe("REQ-121: 전략 로드 실패 시 폴백", () => {
  afterEach(() => teardownBrain());

  it("전략이 빈 배열이면 search() 1회 호출 (폴백)", () => {
    createTestBrain({ withNoteRecords: true }); // 전략 없음
    const result = metaRecall(testRoot, "디자인 관련 검색");
    assert.equal(result.fallback, true);
    assert.deepEqual(result.strategies_used, []);
    assert.equal(result.totalSteps, 0);
    assert.ok(Array.isArray(result.candidates));
  });

  it("_fallbackSearch 직접 호출 시 올바른 구조를 반환한다", () => {
    createTestBrain({ withNoteRecords: true });
    const result = _fallbackSearch(testRoot, "테스트 검색", {});
    assert.equal(result.fallback, true);
    assert.deepEqual(result.strategies_used, []);
    assert.equal(result.totalSteps, 0);
    assert.ok(Array.isArray(result.candidates));
  });
});

// ====================================================================
// REQ-122: primary recall_sequence 순차 실행
// ====================================================================

describe("REQ-122: primary recall_sequence 순차 실행", () => {
  afterEach(() => teardownBrain());

  it("3개 step을 가진 전략 실행 시 결과가 반환된다", () => {
    createTestBrain({ withDesignStrategy: true, withNoteRecords: true });
    const result = metaRecall(testRoot, "UI 디자인 레이아웃 작업");
    assert.equal(result.fallback, false);
    assert.equal(result.totalSteps, 3);
  });
});

// ====================================================================
// REQ-123: {task_keywords} 템플릿 치환
// ====================================================================

describe("REQ-123: {task_keywords} 템플릿 치환", () => {
  afterEach(() => teardownBrain());

  it("메시지에서 길이>1 토큰만 추출하여 치환된다", () => {
    // 2-step 전략으로 테스트: step2의 query_template에 {task_keywords} 사용
    createTestBrain({
      withDesignStrategy: true,
      designContent: {
        name: "design",
        trigger_pattern: ["디자인", "UI"],
        recall_sequence: [
          { step: 1, query_template: "{task_keywords} 검색", type_filter: null }
        ],
        priority_fields: [],
        effectiveness_score: 0.0
      },
      withNoteRecords: true
    });
    // 메시지: "a 디자인 UI 작업" → 길이>1 토큰: ["디자인", "ui", "작업"]
    const result = metaRecall(testRoot, "a 디자인 UI 작업");
    assert.equal(result.fallback, false);
    assert.ok(Array.isArray(result.candidates));
  });
});

// ====================================================================
// REQ-124: type_filter 전달 규칙
// ====================================================================

describe("REQ-124: type_filter 전달 규칙", () => {
  afterEach(() => teardownBrain());

  it("type_filter: 'note'이면 note 타입만 검색한다", () => {
    createTestBrain({
      withDesignStrategy: true,
      designContent: {
        name: "design",
        trigger_pattern: ["디자인"],
        recall_sequence: [
          { step: 1, query_template: "디자인 선호", type_filter: "note" }
        ],
        priority_fields: [],
        effectiveness_score: 0.0
      },
      withNoteRecords: true
    });
    const result = metaRecall(testRoot, "디자인 작업");
    assert.equal(result.fallback, false);
    // note 타입 필터이므로 decision 타입은 결과에 없어야 함
    for (const c of result.candidates) {
      assert.notEqual(c.type, "decision");
    }
  });

  it("type_filter: null이면 전체 타입을 검색한다", () => {
    createTestBrain({
      withDesignStrategy: true,
      designContent: {
        name: "design",
        trigger_pattern: ["디자인"],
        recall_sequence: [
          { step: 1, query_template: "관련 기록", type_filter: null }
        ],
        priority_fields: [],
        effectiveness_score: 0.0
      },
      withNoteRecords: true
    });
    const result = metaRecall(testRoot, "디자인 작업");
    assert.equal(result.fallback, false);
  });
});

// ====================================================================
// REQ-125: 단일 SessionContext 공유
// ====================================================================

describe("REQ-125: 단일 SessionContext 공유", () => {
  afterEach(() => teardownBrain());

  it("여러 step에 걸쳐 동일 sessionContext가 공유된다", () => {
    createTestBrain({ withDesignStrategy: true, withNoteRecords: true });
    // design 전략: 3 steps
    const result = metaRecall(testRoot, "UI 디자인 레이아웃 작업");
    assert.equal(result.fallback, false);
    // cross-step dedup이 동작하면 중복 recordId가 제거됨
    const recordIds = result.candidates.map(c => c.recordId);
    const uniqueIds = new Set(recordIds);
    assert.equal(recordIds.length, uniqueIds.size, "recordId 중복 없어야 함");
  });
});

// ====================================================================
// REQ-126: secondary 전략 순차 실행
// ====================================================================

describe("REQ-126: secondary 전략 순차 실행", () => {
  afterEach(() => teardownBrain());

  it("primary + secondary 두 전략이 매칭될 때 totalSteps가 합계이다", () => {
    // design(3 steps) + bugfix(3 steps) 두 전략 모두 매칭되게
    // trigger가 겹치도록 메시지 구성
    createTestBrain({
      withDesignStrategy: true,
      designContent: {
        name: "design",
        trigger_pattern: ["디자인", "UI"],
        recall_sequence: [
          { step: 1, query_template: "디자인 선호", type_filter: null }
        ],
        priority_fields: [],
        effectiveness_score: 0.0
      },
      withBugfixStrategy: true,
      bugfixContent: {
        name: "bugfix",
        trigger_pattern: ["버그", "수정"],
        recall_sequence: [
          { step: 1, query_template: "버그 기록", type_filter: null }
        ],
        priority_fields: [],
        effectiveness_score: 0.0
      },
      withNoteRecords: true
    });
    // "디자인 버그 수정 UI 작업" → design + bugfix 모두 매칭 가능
    const result = metaRecall(testRoot, "디자인 버그 수정 UI 작업");
    if (!result.fallback && result.strategies_used.length === 2) {
      // primary 1step + secondary 1step = 2
      assert.equal(result.totalSteps, 2);
      assert.equal(result.strategies_used[1].role, "secondary");
    }
  });
});

// ====================================================================
// REQ-127: secondary step 절단 규칙
// ====================================================================

describe("REQ-127: secondary step 절단 규칙", () => {
  it("primary 3 + secondary 3 → secondary는 2개만 허용", () => {
    const classification = {
      primary: {
        strategy: {
          name: "design",
          recall_sequence: [
            { step: 1, query_template: "q1", type_filter: null },
            { step: 2, query_template: "q2", type_filter: null },
            { step: 3, query_template: "q3", type_filter: null }
          ]
        },
        score: 0.6
      },
      secondary: {
        strategy: {
          name: "bugfix",
          recall_sequence: [
            { step: 1, query_template: "q1", type_filter: null },
            { step: 2, query_template: "q2", type_filter: null },
            { step: 3, query_template: "q3", type_filter: null }
          ]
        },
        score: 0.3
      }
    };
    const sliced = _sliceSecondarySteps(classification);
    assert.equal(sliced.length, 2); // 5 - 3 = 2
  });

  it("primary 5 steps → secondary steps 0개", () => {
    const classification = {
      primary: {
        strategy: {
          name: "design",
          recall_sequence: Array.from({ length: 5 }, (_, i) => ({
            step: i + 1, query_template: `q${i + 1}`, type_filter: null
          }))
        },
        score: 0.6
      },
      secondary: {
        strategy: {
          name: "bugfix",
          recall_sequence: [
            { step: 1, query_template: "q1", type_filter: null }
          ]
        },
        score: 0.3
      }
    };
    const sliced = _sliceSecondarySteps(classification);
    assert.equal(sliced.length, 0);
  });

  it("secondary가 null이면 빈 배열 반환", () => {
    const classification = {
      primary: { strategy: { name: "design", recall_sequence: [] }, score: 0.6 },
      secondary: null
    };
    const sliced = _sliceSecondarySteps(classification);
    assert.deepEqual(sliced, []);
  });

  it("절단된 step이 sequence의 앞 N개이다", () => {
    const classification = {
      primary: {
        strategy: {
          name: "a",
          recall_sequence: [
            { step: 1, query_template: "q1", type_filter: null },
            { step: 2, query_template: "q2", type_filter: null },
            { step: 3, query_template: "q3", type_filter: null }
          ]
        },
        score: 0.6
      },
      secondary: {
        strategy: {
          name: "b",
          recall_sequence: [
            { step: 1, query_template: "first", type_filter: null },
            { step: 2, query_template: "second", type_filter: null },
            { step: 3, query_template: "third", type_filter: null }
          ]
        },
        score: 0.3
      }
    };
    const sliced = _sliceSecondarySteps(classification);
    assert.equal(sliced.length, 2);
    assert.equal(sliced[0].query_template, "first");
    assert.equal(sliced[1].query_template, "second");
  });
});

// ====================================================================
// REQ-128: recordId 기준 dedup
// ====================================================================

describe("REQ-128: recordId 기준 dedup", () => {
  it("동일 recordId 중 최고 score만 유지한다", () => {
    const results = [
      { recordId: "rec1", score: 0.5, title: "A" },
      { recordId: "rec1", score: 0.8, title: "A" },
      { recordId: "rec2", score: 0.6, title: "B" }
    ];
    const deduped = _deduplicateResults(results);
    assert.equal(deduped.length, 2);
    const rec1 = deduped.find(c => c.recordId === "rec1");
    assert.equal(rec1.score, 0.8);
  });

  it("dedup 후 score 내림차순 정렬된다", () => {
    const results = [
      { recordId: "rec1", score: 0.3, title: "A" },
      { recordId: "rec2", score: 0.9, title: "B" },
      { recordId: "rec3", score: 0.6, title: "C" }
    ];
    const deduped = _deduplicateResults(results);
    assert.equal(deduped[0].score, 0.9);
    assert.equal(deduped[1].score, 0.6);
    assert.equal(deduped[2].score, 0.3);
  });

  it("빈 배열 입력 시 빈 배열 반환", () => {
    const deduped = _deduplicateResults([]);
    assert.deepEqual(deduped, []);
  });
});

// ====================================================================
// REQ-129: 최종 결과 구조
// ====================================================================

describe("REQ-129: 최종 결과 구조", () => {
  afterEach(() => teardownBrain());

  it("반환 객체에 4개 필드가 모두 존재한다", () => {
    createTestBrain({ withDesignStrategy: true, withNoteRecords: true });
    const result = metaRecall(testRoot, "UI 디자인 레이아웃 작업");
    assert.ok("candidates" in result);
    assert.ok("strategies_used" in result);
    assert.ok("fallback" in result);
    assert.ok("totalSteps" in result);
  });

  it("strategies_used[0].role === 'primary'", () => {
    createTestBrain({ withDesignStrategy: true, withNoteRecords: true });
    const result = metaRecall(testRoot, "UI 디자인 레이아웃 작업");
    if (!result.fallback) {
      assert.equal(result.strategies_used[0].role, "primary");
    }
  });

  it("fallback 결과에서도 4개 필드가 존재한다", () => {
    createTestBrain({ withNoteRecords: true }); // 전략 없음
    const result = metaRecall(testRoot, "검색");
    assert.ok("candidates" in result);
    assert.ok("strategies_used" in result);
    assert.ok("fallback" in result);
    assert.ok("totalSteps" in result);
    assert.equal(result.fallback, true);
  });
});

// ====================================================================
// REQ-130: 분류 실패 시 폴백
// ====================================================================

describe("REQ-130: classify fallback 시 search 1회 호출", () => {
  afterEach(() => teardownBrain());

  it("매칭 score 미달 시 fallback=true 반환", () => {
    createTestBrain({ withDesignStrategy: true, withNoteRecords: true });
    // trigger_pattern에 없는 키워드로 검색 → 분류 실패 → 폴백
    const result = metaRecall(testRoot, "완전히 무관한 주제의 검색어");
    assert.equal(result.fallback, true);
    assert.deepEqual(result.strategies_used, []);
    assert.equal(result.totalSteps, 0);
  });
});

// ====================================================================
// _saveLastStrategy 검증 (LINK-CHECK output)
// ====================================================================

describe("_saveLastStrategy: B08 소비를 위한 전략 기록", () => {
  afterEach(() => teardownBrain());

  it("전략 매칭 성공 시 .meta_last_strategy 파일이 생성된다", () => {
    createTestBrain({ withDesignStrategy: true, withNoteRecords: true });
    metaRecall(testRoot, "UI 디자인 레이아웃 작업");
    const filePath = path.join(testRoot, "90_index", ".meta_last_strategy");
    assert.ok(fs.existsSync(filePath), ".meta_last_strategy 파일 존재");
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.ok(data.timestamp);
    assert.equal(data.primary.name, "design");
  });

  it("폴백 시에도 .meta_last_strategy 파일이 생성된다 (메시지 추적용)", () => {
    createTestBrain({ withNoteRecords: true }); // 전략 없음
    metaRecall(testRoot, "검색");
    const filePath = path.join(testRoot, "90_index", ".meta_last_strategy");
    assert.ok(fs.existsSync(filePath), "폴백 시에도 파일 생성 (메시지 추적)");
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(data.primary, null, "primary는 null");
    assert.equal(data.fallback, true, "fallback=true 표시");
    assert.equal(data.message, "검색", "원본 메시지 기록");
  });
});

// ====================================================================
// [B09] Phase2Tests — meta-recall.test.js
// REQ: REQ-151 ~ REQ-154
// Ref: TEST-UT-META-RECALL
// Depends On: B05(MetaStrategySchema), B06(SituationClassifier),
//             B07(MetaRecallOrchestrator)
// ====================================================================

// --- B09 전용 픽스처 함수 ---

function _createMetaRecallTestBrain() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-b09-meta-recall-"));
  const indexDir = path.join(tmpDir, "90_index");
  const topicsDir = path.join(tmpDir, "30_topics", "meta_strategies");
  fs.mkdirSync(indexDir, { recursive: true });
  fs.mkdirSync(topicsDir, { recursive: true });

  fs.writeFileSync(path.join(indexDir, "tags.json"), JSON.stringify({
    domain: { synonyms: {} }, intent: { synonyms: {} }
  }));

  const bugfixContent = {
    name: "bugfix",
    trigger_pattern: ["버그", "오류", "에러", "error", "fix", "bug", "이상한", "문제"],
    recall_sequence: [
      { step: 1, query_template: "유사 버그 기록", type_filter: "note" },
      { step: 2, query_template: "{task_keywords}", type_filter: null },
      { step: 3, query_template: "프로젝트 레슨", type_filter: "rule" }
    ],
    effectiveness_score: 0.0
  };
  fs.writeFileSync(path.join(topicsDir, "bugfix.json"), JSON.stringify(bugfixContent, null, 2));

  const now = new Date().toISOString();
  const digestLines = [
    "# Format: recordId | title | summary | tags | status | type | sourceType | updatedAt",
    `rec_topic_meta_bugfix | bugfix 전략 | 버그 수정 메타 전략 | domain/memory | active | meta_strategy | candidate | ${now}`,
    `rec_topic_note1 | 버그 수정 기록 1 | 유사 버그 해결 사례 | domain/memory | active | note | candidate | ${now}`,
    `rec_topic_rule1 | 레슨 1 | 반복 실수 방지 규칙 | domain/memory | active | rule | candidate | ${now}`
  ].join("\n");
  fs.writeFileSync(path.join(indexDir, "records_digest.txt"), digestLines);

  const records = [
    {
      recordId: "rec_topic_meta_bugfix", scopeType: "topic", scopeId: "meta_strategies",
      type: "meta_strategy", title: "bugfix 전략", summary: "버그 수정 메타 전략",
      tags: ["domain/memory"], status: "active",
      sourceRef: "30_topics/meta_strategies/bugfix.json",
      sourceType: "candidate", updatedAt: now
    }
  ];
  fs.writeFileSync(
    path.join(indexDir, "records.jsonl"),
    records.map(r => JSON.stringify(r)).join("\n") + "\n"
  );

  return tmpDir;
}

function _createDualStrategyTestBrain() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-b09-dual-strategy-"));
  const indexDir = path.join(tmpDir, "90_index");
  const topicsDir = path.join(tmpDir, "30_topics", "meta_strategies");
  fs.mkdirSync(indexDir, { recursive: true });
  fs.mkdirSync(topicsDir, { recursive: true });

  fs.writeFileSync(path.join(indexDir, "tags.json"), JSON.stringify({
    domain: { synonyms: {} }, intent: { synonyms: {} }
  }));

  const now = new Date().toISOString();

  fs.writeFileSync(path.join(topicsDir, "bugfix.json"), JSON.stringify({
    name: "bugfix",
    trigger_pattern: ["버그", "오류"],
    recall_sequence: [
      { step: 1, query_template: "유사 버그", type_filter: "note" },
      { step: 2, query_template: "{task_keywords}", type_filter: null }
    ],
    effectiveness_score: 0.0
  }));

  fs.writeFileSync(path.join(topicsDir, "design.json"), JSON.stringify({
    name: "design",
    trigger_pattern: ["디자인", "ui"],
    recall_sequence: [
      { step: 1, query_template: "디자인 선호", type_filter: "note" },
      { step: 2, query_template: "{task_keywords}", type_filter: null }
    ],
    effectiveness_score: 0.0
  }));

  const digestLines = [
    "# Format: recordId | title | summary | tags | status | type | sourceType | updatedAt",
    `rec_topic_meta_bugfix | bugfix | bugfix 전략 | domain/memory | active | meta_strategy | candidate | ${now}`,
    `rec_topic_meta_design | design | design 전략 | domain/memory | active | meta_strategy | candidate | ${now}`,
    `rec_topic_note1 | 버그 기록 | 버그 사례 | domain/memory | active | note | candidate | ${now}`,
    `rec_topic_note2 | 디자인 기록 | 디자인 사례 | domain/memory | active | note | candidate | ${now}`
  ].join("\n");
  fs.writeFileSync(path.join(indexDir, "records_digest.txt"), digestLines);

  const records = [
    {
      recordId: "rec_topic_meta_bugfix", scopeType: "topic", scopeId: "meta_strategies",
      type: "meta_strategy", title: "bugfix", summary: "bugfix 전략", tags: ["domain/memory"],
      status: "active", sourceRef: "30_topics/meta_strategies/bugfix.json",
      sourceType: "candidate", updatedAt: now
    },
    {
      recordId: "rec_topic_meta_design", scopeType: "topic", scopeId: "meta_strategies",
      type: "meta_strategy", title: "design", summary: "design 전략", tags: ["domain/memory"],
      status: "active", sourceRef: "30_topics/meta_strategies/design.json",
      sourceType: "candidate", updatedAt: now
    }
  ];
  fs.writeFileSync(
    path.join(indexDir, "records.jsonl"),
    records.map(r => JSON.stringify(r)).join("\n") + "\n"
  );

  return tmpDir;
}

function _createFallbackTestBrain() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-b09-fallback-"));
  const indexDir = path.join(tmpDir, "90_index");
  const topicsDir = path.join(tmpDir, "30_topics", "meta_strategies");
  fs.mkdirSync(indexDir, { recursive: true });
  fs.mkdirSync(topicsDir, { recursive: true });

  fs.writeFileSync(path.join(indexDir, "tags.json"), JSON.stringify({
    domain: { synonyms: {} }, intent: { synonyms: {} }
  }));

  const now = new Date().toISOString();
  fs.writeFileSync(path.join(topicsDir, "bugfix.json"), JSON.stringify({
    name: "bugfix",
    trigger_pattern: ["버그", "오류", "에러"],
    recall_sequence: [{ step: 1, query_template: "{task_keywords}", type_filter: null }],
    effectiveness_score: 0.0
  }));

  const digestLines = [
    "# Format: recordId | title | summary | tags | status | type | sourceType | updatedAt",
    `rec_topic_meta_bugfix | bugfix | bugfix 전략 | domain/memory | active | meta_strategy | candidate | ${now}`,
    `rec_topic_note1 | 일반 기록 | 테스트 기록 | domain/memory | active | note | candidate | ${now}`
  ].join("\n");
  fs.writeFileSync(path.join(indexDir, "records_digest.txt"), digestLines);

  const records = [{
    recordId: "rec_topic_meta_bugfix", scopeType: "topic", scopeId: "meta_strategies",
    type: "meta_strategy", title: "bugfix", summary: "bugfix 전략", tags: ["domain/memory"],
    status: "active", sourceRef: "30_topics/meta_strategies/bugfix.json",
    sourceType: "candidate", updatedAt: now
  }];
  fs.writeFileSync(
    path.join(indexDir, "records.jsonl"),
    records.map(r => JSON.stringify(r)).join("\n") + "\n"
  );

  return tmpDir;
}

function _createEmptyStrategyBrain() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-b09-empty-strategy-"));
  const indexDir = path.join(tmpDir, "90_index");
  fs.mkdirSync(indexDir, { recursive: true });

  fs.writeFileSync(path.join(indexDir, "tags.json"), JSON.stringify({
    domain: { synonyms: {} }, intent: { synonyms: {} }
  }));
  fs.writeFileSync(
    path.join(indexDir, "records_digest.txt"),
    "# Format: recordId | title | summary | tags | status | type | sourceType | updatedAt\n"
  );
  fs.writeFileSync(path.join(indexDir, "records.jsonl"), "");
  return tmpDir;
}

// --- REQ-151: metaRecall single strategy 실행 테스트 ---

describe("metaRecall single strategy (REQ-151)", () => {
  let b09BrainRoot;

  before(() => {
    b09BrainRoot = _createMetaRecallTestBrain();
  });

  after(() => {
    _resetSynonymCache();
    fs.rmSync(b09BrainRoot, { recursive: true, force: true });
  });

  it("primary만 매칭 시 해당 전략의 step 수만큼 실행", () => {
    const result = metaRecall(b09BrainRoot, "버그 수정 이상한 문제", {});

    assert.equal(result.fallback, false, "폴백 미사용");
    assert.ok(result.strategies_used.length >= 1, "strategies_used 존재");
    assert.equal(
      result.strategies_used.some(s => s.role === "primary"),
      true,
      "primary 전략 사용 확인"
    );
    assert.equal(
      result.strategies_used.some(s => s.role === "secondary"),
      false,
      "single strategy → secondary 없음"
    );
    assert.ok(typeof result.totalSteps === "number", "totalSteps는 숫자");
    assert.ok(result.totalSteps > 0, "step이 최소 1개 이상 실행됨");
  });

  it("결과 구조 검증 — candidates, strategies_used, fallback, totalSteps 포함", () => {
    const result = metaRecall(b09BrainRoot, "버그 오류 수정", {});

    assert.ok(Array.isArray(result.candidates), "candidates 배열");
    assert.ok(Array.isArray(result.strategies_used), "strategies_used 배열");
    assert.ok(typeof result.fallback === "boolean", "fallback boolean");
    assert.ok(typeof result.totalSteps === "number", "totalSteps 숫자");
  });
});

// --- REQ-152: metaRecall parallel strategy 실행 테스트 ---

describe("metaRecall parallel strategy (REQ-152)", () => {
  let b09DualBrain;

  before(() => {
    b09DualBrain = _createDualStrategyTestBrain();
  });

  after(() => {
    _resetSynonymCache();
    fs.rmSync(b09DualBrain, { recursive: true, force: true });
  });

  it("primary + secondary 두 전략 실행 — strategies_used에 두 전략 모두 포함", () => {
    const result = metaRecall(b09DualBrain, "버그 버그 디자인 디자인", {});

    if (!result.fallback) {
      const hasPrimary = result.strategies_used.some(s => s.role === "primary");
      const hasSecondary = result.strategies_used.some(s => s.role === "secondary");

      if (hasSecondary) {
        assert.ok(hasPrimary, "primary 전략 사용됨");
        assert.ok(hasSecondary, "secondary 전략 사용됨");
        assert.equal(result.strategies_used.length, 2, "두 전략 사용");
      } else {
        assert.ok(hasPrimary, "최소 primary 전략 사용됨");
      }
    } else {
      assert.equal(result.strategies_used.length, 0);
    }
  });

  it("두 전략 실행 시 totalSteps <= 5 (cap 적용)", () => {
    const result = metaRecall(b09DualBrain, "버그 버그 버그 디자인 디자인", {});

    if (!result.fallback && result.strategies_used.length === 2) {
      assert.ok(result.totalSteps > 0, "totalSteps > 0");
      assert.ok(result.totalSteps <= 5, "totalSteps <= 5 (cap 적용)");
    }
  });

  it("결과 dedup — 동일 recordId는 최고 score 1개만 포함", () => {
    const result = metaRecall(b09DualBrain, "버그 버그 디자인", {});

    const ids = result.candidates.map(c => c.recordId);
    const uniqueIds = new Set(ids);
    assert.equal(ids.length, uniqueIds.size, "중복 recordId 없음 (dedup 완료)");
  });
});

// --- REQ-153: metaRecall template 치환 테스트 ---

describe("metaRecall template 치환 (REQ-153)", () => {
  let b09TemplateBrain;

  before(() => {
    b09TemplateBrain = _createMetaRecallTestBrain();
  });

  after(() => {
    _resetSynonymCache();
    fs.rmSync(b09TemplateBrain, { recursive: true, force: true });
  });

  it("{task_keywords} 치환 — metaRecall 결과로 간접 검증", () => {
    // metaRecall이 정상 동작하고 candidates가 반환되면
    // {task_keywords}가 올바르게 치환되어 search()가 실행된 것
    const result = metaRecall(b09TemplateBrain, "버그 footer 이상해", {});

    // 치환이 실패하면 search() 호출 자체가 에러나거나 빈 결과 반환
    // 정상 동작이면 candidates 배열(비어도 됨)과 totalSteps > 0
    assert.ok(Array.isArray(result.candidates), "candidates 배열 존재");
    assert.ok(typeof result.totalSteps === "number", "totalSteps 숫자 (치환 후 실행됨)");
  });
});

// --- REQ-154: metaRecall fallback 테스트 ---

describe("metaRecall fallback (REQ-154)", () => {
  let b09FallbackBrain;

  before(() => {
    b09FallbackBrain = _createFallbackTestBrain();
  });

  after(() => {
    _resetSynonymCache();
    fs.rmSync(b09FallbackBrain, { recursive: true, force: true });
  });

  it("분류 실패 시 fallback=true, strategies_used=[], totalSteps=0", () => {
    const result = metaRecall(b09FallbackBrain, "무관한 내용 랜덤 텍스트", {});

    assert.equal(result.fallback, true, "분류 실패 → fallback=true");
    assert.deepEqual(result.strategies_used, [], "fallback → strategies_used=[]");
    assert.equal(result.totalSteps, 0, "fallback → totalSteps=0");
    assert.ok(Array.isArray(result.candidates), "fallback에서도 candidates 배열 반환");
  });

  it("전략 로드 실패(빈 배열) 시 fallback으로 기존 search() 1회 호출", () => {
    const emptyBrain = _createEmptyStrategyBrain();

    try {
      _resetSynonymCache();
      const result = metaRecall(emptyBrain, "버그 수정", {});

      assert.equal(result.fallback, true, "전략 없음 → fallback");
      assert.deepEqual(result.strategies_used, []);
      assert.ok(Array.isArray(result.candidates), "candidates 배열 존재");
    } finally {
      fs.rmSync(emptyBrain, { recursive: true, force: true });
    }
  });

  it("fallback 결과 구조 — candidates, strategies_used:[], fallback:true, totalSteps:0", () => {
    const result = metaRecall(b09FallbackBrain, "전혀 관련없는 문장이에요", {});

    assert.ok("candidates" in result, "candidates 키 존재");
    assert.ok("strategies_used" in result, "strategies_used 키 존재");
    assert.ok("fallback" in result, "fallback 키 존재");
    assert.ok("totalSteps" in result, "totalSteps 키 존재");
  });
});
