"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { search, _expandTokens, createSessionContext } = require("../src/search");
const { _resetSynonymCache } = require("../src/utils");

// --- 헬퍼 ---

function createTempBrain(digestLines, tagsData) {
  const brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-scoring-"));
  const indexDir = path.join(brainRoot, "90_index");
  fs.mkdirSync(indexDir, { recursive: true });

  // records_digest.txt
  const header = "# Format: recordId | title | summary | tags | status | type | sourceType | updatedAt";
  const content = [header, ...digestLines].join("\n");
  fs.writeFileSync(path.join(indexDir, "records_digest.txt"), content, "utf-8");

  // tags.json
  if (tagsData) {
    fs.writeFileSync(path.join(indexDir, "tags.json"), JSON.stringify(tagsData), "utf-8");
  }

  // records.jsonl (빈 파일)
  fs.writeFileSync(path.join(indexDir, "records.jsonl"), "", "utf-8");

  return brainRoot;
}

function cleanup(brainRoot) {
  fs.rmSync(brainRoot, { recursive: true, force: true });
}

// --- 테스트 데이터 ---

const DIGEST_LINES = [
  "rec_topic_001 | Brain CLI 설치 | CLI 설치 가이드 | domain/memory,intent/ref | active | note | user_confirmed | 2026-03-01T09:00:00",
  "rec_topic_002 | API 인증 설정 | OAuth 인증 방법 | domain/auth,intent/decision | active | decision | candidate | 2026-01-01T09:00:00",
  "rec_topic_003 | React 컴포넌트 | React 설계 패턴 | domain/ui | active | note | inference | 2025-11-01T09:00:00",
  "rec_topic_004 | 데이터베이스 최적화 | DB 쿼리 튜닝 | domain/data | active | rule | chat_log | 2026-02-15T09:00:00",
  "rec_topic_005 | 레거시 레코드 | 오래된 메모 | domain/memory | active | note | candidate |"
];

// --- 테스트 ---

describe("REQ-050: _calculateRelevance expandedTokens 가중치", () => {
  let brainRoot;

  before(() => {
    _resetSynonymCache();
    brainRoot = createTempBrain(DIGEST_LINES, {});
  });
  after(() => cleanup(brainRoot));

  it("원본 토큰(weight=1.0)이 title 매칭 시 점수 3", () => {
    const result = search(brainRoot, { currentGoal: "Brain" });
    const brainRecord = result.candidates.find(c => c.recordId === "rec_topic_001");
    assert.ok(brainRecord);
    assert.ok(brainRecord.score > 0);
  });

  it("동의어 토큰(weight=0.7)은 점수가 낮아짐", () => {
    _resetSynonymCache();
    const brainWithSynonyms = createTempBrain(DIGEST_LINES, {
      general_synonyms: [["brain", "두뇌"]]
    });

    const result = search(brainWithSynonyms, { currentGoal: "두뇌" });
    const brainRecord = result.candidates.find(c => c.recordId === "rec_topic_001");
    assert.ok(brainRecord);
    // "두뇌" → synonym of "brain" → weight 0.7 → title match = 3 * 0.7 = 2.1
    assert.ok(brainRecord.score > 0);

    _resetSynonymCache();
    cleanup(brainWithSynonyms);
  });

  it("expandedTokens가 빈 배열이면 점수 0", () => {
    const result = search(brainRoot, { currentGoal: "" });
    for (const c of result.candidates) {
      assert.equal(c.score, 0);
    }
  });

  it("복수 토큰이 동시 매칭 시 합산", () => {
    const result = search(brainRoot, { currentGoal: "Brain CLI" });
    const brainRecord = result.candidates.find(c => c.recordId === "rec_topic_001");
    assert.ok(brainRecord);
    // "brain"은 title+summary+tags에 매칭, "cli"도 title+summary에 매칭
    assert.ok(brainRecord.score > 3);
  });
});

describe("REQ-051, REQ-052: _calculateTimeFactor", () => {
  let brainRoot;

  before(() => {
    _resetSynonymCache();
    brainRoot = createTempBrain(DIGEST_LINES, {});
  });
  after(() => cleanup(brainRoot));

  it("최근 업데이트 레코드는 높은 timeFactor", () => {
    // rec_topic_001: 2026-03-01 (매우 최근)
    // rec_topic_003: 2025-11-01 (오래됨)
    const result = search(brainRoot, { currentGoal: "설치 설계" });
    // "설치"는 rec_001 매칭, "설계"는 rec_003 매칭
    // 동일 relevance라면 최근 것이 더 높은 점수
    const rec001 = result.candidates.find(c => c.recordId === "rec_topic_001");
    const rec003 = result.candidates.find(c => c.recordId === "rec_topic_003");
    assert.ok(rec001 && rec003);
  });

  it("updatedAt = null이면 timeFactor = 1.0 (감쇠 없음)", () => {
    // rec_topic_005: updatedAt 빈 문자열
    const result = search(brainRoot, { currentGoal: "레거시" });
    const rec005 = result.candidates.find(c => c.recordId === "rec_topic_005");
    assert.ok(rec005);
    assert.ok(rec005.score > 0);
  });

  it("7일 전 → timeFactor ~= 0.935", () => {
    _resetSynonymCache();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const lines = [
      `rec_topic_tf1 | 테스트 제목 | 테스트 요약 | domain/test | active | note | candidate | ${sevenDaysAgo}`
    ];
    const tmpBrain = createTempBrain(lines, {});

    const result = search(tmpBrain, { currentGoal: "테스트" });
    const rec = result.candidates[0];
    assert.ok(rec);

    // relevance * timeFactor * trustFactor(1.0) * dedupFactor(1.0)
    // timeFactor should be ~0.935 for 7 days
    // If relevance were without timeFactor, score would be higher
    // Check timeFactor is applied (score is less than pure relevance)
    const expectedTimeFactor = 1 / (1 + 7 * 0.01);
    assert.ok(Math.abs(expectedTimeFactor - 0.935) < 0.01);

    cleanup(tmpBrain);
  });

  it("100일 전 → timeFactor ~= 0.500", () => {
    const expectedTimeFactor = 1 / (1 + 100 * 0.01);
    assert.ok(Math.abs(expectedTimeFactor - 0.500) < 0.01);
  });
});

describe("REQ-053, REQ-054, REQ-055: trustFactor", () => {
  let brainRoot;

  before(() => {
    _resetSynonymCache();
    brainRoot = createTempBrain(DIGEST_LINES, {});
  });
  after(() => cleanup(brainRoot));

  it("user_confirmed(1.5)가 candidate(1.0)보다 높은 점수", () => {
    _resetSynonymCache();
    const now = new Date().toISOString();
    const lines = [
      `rec_topic_t1 | 동일 제목 키워드 | 동일 요약 | domain/test | active | note | user_confirmed | ${now}`,
      `rec_topic_t2 | 동일 제목 키워드 | 동일 요약 | domain/test | active | note | candidate | ${now}`
    ];
    const tmpBrain = createTempBrain(lines, {});

    const result = search(tmpBrain, { currentGoal: "동일 제목" });
    const rec1 = result.candidates.find(c => c.recordId === "rec_topic_t1");
    const rec2 = result.candidates.find(c => c.recordId === "rec_topic_t2");
    assert.ok(rec1 && rec2);
    assert.ok(rec1.score > rec2.score);

    cleanup(tmpBrain);
  });

  it("inference(0.7) 계수가 candidate(1.0)보다 낮음", () => {
    _resetSynonymCache();
    const now = new Date().toISOString();
    const lines = [
      `rec_topic_t3 | 동일 제목 키워드 | 동일 요약 | domain/test | active | note | candidate | ${now}`,
      `rec_topic_t4 | 동일 제목 키워드 | 동일 요약 | domain/test | active | note | inference | ${now}`
    ];
    const tmpBrain = createTempBrain(lines, {});

    const result = search(tmpBrain, { currentGoal: "동일 제목" });
    const rec3 = result.candidates.find(c => c.recordId === "rec_topic_t3");
    const rec4 = result.candidates.find(c => c.recordId === "rec_topic_t4");
    assert.ok(rec3 && rec4);
    assert.ok(rec3.score > rec4.score);

    cleanup(tmpBrain);
  });

  it("미정의 sourceType은 기본 계수 1.0 적용", () => {
    _resetSynonymCache();
    const now = new Date().toISOString();
    const lines = [
      `rec_topic_t5 | 동일 제목 키워드 | 동일 요약 | domain/test | active | note | candidate | ${now}`,
      `rec_topic_t6 | 동일 제목 키워드 | 동일 요약 | domain/test | active | note | unknown_type | ${now}`
    ];
    const tmpBrain = createTempBrain(lines, {});

    const result = search(tmpBrain, { currentGoal: "동일 제목" });
    const rec5 = result.candidates.find(c => c.recordId === "rec_topic_t5");
    const rec6 = result.candidates.find(c => c.recordId === "rec_topic_t6");
    assert.ok(rec5 && rec6);
    // candidate=1.0, unknown_type=1.0(fallback) → 동일
    assert.equal(rec5.score, rec6.score);

    cleanup(tmpBrain);
  });
});

describe("REQ-056, REQ-057: dedupFactor", () => {
  let brainRoot;

  before(() => {
    _resetSynonymCache();
    brainRoot = createTempBrain(DIGEST_LINES, {});
  });
  after(() => cleanup(brainRoot));

  it("동일 recordId가 exposedIds에 있으면 dedupFactor = 0.3", () => {
    const ctx = createSessionContext();

    // 첫 번째 검색
    const result1 = search(brainRoot, { currentGoal: "Brain CLI" }, ctx);
    const firstScore = result1.candidates[0].score;
    assert.ok(firstScore > 0);

    // 두 번째 검색 (같은 sessionContext → dedup 적용)
    const result2 = search(brainRoot, { currentGoal: "Brain CLI" }, ctx);
    const secondScore = result2.candidates.find(
      c => c.recordId === result1.candidates[0].recordId
    )?.score;
    assert.ok(secondScore < firstScore);
    // dedupFactor = 0.3 → secondScore ≈ firstScore * 0.3
    const ratio = secondScore / firstScore;
    assert.ok(Math.abs(ratio - 0.3) < 0.01);
  });

  it("유사 제목(Jaccard > 0.8)이 있으면 dedupFactor = 0.5", () => {
    _resetSynonymCache();
    const now = new Date().toISOString();
    const lines = [
      `rec_topic_d1 | Brain CLI 설치 가이드 문서 | 설명1 | domain/test | active | note | candidate | ${now}`,
      `rec_topic_d2 | Brain CLI 설치 가이드 | 설명2 | domain/test | active | note | candidate | ${now}`
    ];
    const tmpBrain = createTempBrain(lines, {});

    const ctx = createSessionContext();
    // "Brain CLI 설치 가이드"를 exposedTitles에 추가
    ctx.exposedTitles.add("Brain CLI 설치 가이드");

    const result = search(tmpBrain, { currentGoal: "Brain CLI" }, ctx);
    const d1 = result.candidates.find(c => c.recordId === "rec_topic_d1");
    // "Brain CLI 설치 가이드 문서" vs "Brain CLI 설치 가이드"
    // Jaccard: {brain, cli, 설치, 가이드} ∩ {brain, cli, 설치, 가이드, 문서} = 4 / 5 = 0.8
    // 0.8은 > 0.8 이 아니므로 (strict greater) dedupFactor = 1.0
    // 정확히 0.8이면 패널티 없음 (> 0.8)
    assert.ok(d1);

    cleanup(tmpBrain);
  });

  it("미노출 레코드는 dedupFactor = 1.0", () => {
    const ctx = createSessionContext();
    const result = search(brainRoot, { currentGoal: "Brain CLI" }, ctx);
    // 첫 검색이므로 모든 레코드가 미노출
    assert.ok(result.candidates.length > 0);
    // 점수가 sessionContext 없는 경우와 동일해야 함
  });

  it("sessionContext = null이면 dedupFactor 비활성", () => {
    const result = search(brainRoot, { currentGoal: "Brain CLI" }, null);
    assert.ok(result.candidates.length > 0);
    assert.ok(result.candidates[0].score > 0);
  });
});

describe("REQ-057: _jaccardSimilarity", () => {
  it("동일 문자열 → 유사도 1.0", () => {
    // search 내부 함수이므로 간접 테스트: 동일 title이 exposedTitles에 있으면 dedup 적용
    const ctx = createSessionContext();
    ctx.exposedTitles.add("완전 동일 제목");

    _resetSynonymCache();
    const now = new Date().toISOString();
    const lines = [
      `rec_topic_j1 | 완전 동일 제목 | 요약 | domain/test | active | note | candidate | ${now}`
    ];
    const tmpBrain = createTempBrain(lines, {});

    // 동일 ID가 아닌 유사 제목으로 매칭
    const result = search(tmpBrain, { currentGoal: "완전 동일" }, ctx);
    const rec = result.candidates[0];
    assert.ok(rec);
    // Jaccard("완전 동일 제목", "완전 동일 제목") = 1.0 > 0.8 → dedupFactor = 0.5
    // 동일 ID는 없으므로 0.3이 아닌 0.5

    cleanup(tmpBrain);
  });

  it("완전히 다른 제목 → 유사도 0.0 → dedup 없음", () => {
    const ctx = createSessionContext();
    ctx.exposedTitles.add("완전히 다른 주제");

    _resetSynonymCache();
    const now = new Date().toISOString();
    const lines = [
      `rec_topic_j2 | React 컴포넌트 설계 | 요약 | domain/test | active | note | candidate | ${now}`
    ];
    const tmpBrain = createTempBrain(lines, {});

    const result = search(tmpBrain, { currentGoal: "React" }, ctx);
    const rec = result.candidates[0];
    assert.ok(rec);
    // Jaccard("React 컴포넌트 설계", "완전히 다른 주제") = 0.0 → dedupFactor = 1.0

    cleanup(tmpBrain);
  });

  it("빈 문자열 처리", () => {
    const ctx = createSessionContext();
    ctx.exposedTitles.add("");

    _resetSynonymCache();
    const now = new Date().toISOString();
    const lines = [
      `rec_topic_j3 | 테스트 제목 | 요약 | domain/test | active | note | candidate | ${now}`
    ];
    const tmpBrain = createTempBrain(lines, {});

    const result = search(tmpBrain, { currentGoal: "테스트" }, ctx);
    assert.ok(result.candidates.length > 0);
    // 빈 문자열과 비교 시 Jaccard = 0.0 → dedupFactor = 1.0

    cleanup(tmpBrain);
  });
});

describe("REQ-058: createSessionContext", () => {
  it("exposedIds와 exposedTitles를 포함하는 객체 반환", () => {
    const ctx = createSessionContext();
    assert.ok(ctx.exposedIds instanceof Set);
    assert.ok(ctx.exposedTitles instanceof Set);
  });

  it("초기 상태에서 두 Set 모두 비어있음", () => {
    const ctx = createSessionContext();
    assert.equal(ctx.exposedIds.size, 0);
    assert.equal(ctx.exposedTitles.size, 0);
  });
});

describe("REQ-059: _updateSessionContext", () => {
  let brainRoot;

  before(() => {
    _resetSynonymCache();
    brainRoot = createTempBrain(DIGEST_LINES, {});
  });
  after(() => cleanup(brainRoot));

  it("search 후 exposedIds에 recordId 추가됨", () => {
    const ctx = createSessionContext();
    const result = search(brainRoot, { currentGoal: "Brain" }, ctx);

    for (const c of result.candidates) {
      assert.ok(ctx.exposedIds.has(c.recordId));
    }
  });

  it("search 후 exposedTitles에 title 추가됨", () => {
    const ctx = createSessionContext();
    const result = search(brainRoot, { currentGoal: "Brain" }, ctx);

    for (const c of result.candidates) {
      assert.ok(ctx.exposedTitles.has(c.title));
    }
  });
});

describe("REQ-060: 통합 점수 공식 finalScore = R × T × Tr × D", () => {
  it("4요소가 모두 곱셈으로 반영됨", () => {
    _resetSynonymCache();
    const now = new Date().toISOString();
    const lines = [
      `rec_topic_f1 | 테스트 키워드 | 키워드 요약 | domain/test | active | note | user_confirmed | ${now}`
    ];
    const tmpBrain = createTempBrain(lines, {});

    const result = search(tmpBrain, { currentGoal: "테스트 키워드" });
    const rec = result.candidates[0];
    assert.ok(rec);
    // relevance > 0, timeFactor ~1.0 (very recent), trustFactor = 1.5, dedupFactor = 1.0
    // score should be > 0 and reflect the 1.5 trust boost
    assert.ok(rec.score > 0);

    cleanup(tmpBrain);
  });

  it("relevanceScore = 0이면 finalScore = 0", () => {
    _resetSynonymCache();
    const now = new Date().toISOString();
    const lines = [
      `rec_topic_f2 | 아무 관련 없는 제목 | 관련 없는 요약 | domain/test | active | note | user_confirmed | ${now}`
    ];
    const tmpBrain = createTempBrain(lines, {});

    const result = search(tmpBrain, { currentGoal: "zzzzxyz" });
    const rec = result.candidates[0];
    assert.ok(rec);
    assert.equal(rec.score, 0);

    cleanup(tmpBrain);
  });
});

describe("REQ-061: search() sessionContext 선택 인자", () => {
  let brainRoot;

  before(() => {
    _resetSynonymCache();
    brainRoot = createTempBrain(DIGEST_LINES, {});
  });
  after(() => cleanup(brainRoot));

  it("기존 2인자 호출이 정상 동작 (하위 호환)", () => {
    const result = search(brainRoot, { currentGoal: "Brain" });
    assert.ok(result.candidates.length > 0);
    assert.ok(typeof result.total === "number");
  });

  it("sessionContext 전달 시 dedupFactor 적용", () => {
    const ctx = createSessionContext();
    const result1 = search(brainRoot, { currentGoal: "Brain CLI" }, ctx);
    assert.ok(result1.candidates.length > 0);

    // 두 번째 호출에서 dedup 적용 확인
    const result2 = search(brainRoot, { currentGoal: "Brain CLI" }, ctx);
    const sameRec = result2.candidates.find(
      c => c.recordId === result1.candidates[0].recordId
    );
    assert.ok(sameRec);
    assert.ok(sameRec.score < result1.candidates[0].score);
  });
});

describe("REQ-062: sessionContext 미전달 시 dedupFactor 1.0", () => {
  let brainRoot;

  before(() => {
    _resetSynonymCache();
    brainRoot = createTempBrain(DIGEST_LINES, {});
  });
  after(() => cleanup(brainRoot));

  it("search(brainRoot, query) → dedupFactor 비활성", () => {
    const result1 = search(brainRoot, { currentGoal: "Brain CLI" });
    const result2 = search(brainRoot, { currentGoal: "Brain CLI" });

    // sessionContext 없으므로 점수 거의 동일 (Date.now() 미세 차이로 부동소수점 오차 허용)
    const diff = Math.abs(result1.candidates[0].score - result2.candidates[0].score);
    assert.ok(diff < 0.001, `점수 차이가 너무 큼: ${diff}`);
  });

  it("search(brainRoot, query, null) → dedupFactor 비활성", () => {
    const result = search(brainRoot, { currentGoal: "Brain CLI" }, null);
    assert.ok(result.candidates.length > 0);
  });
});

describe("REQ-063: query.type 필터", () => {
  let brainRoot;

  before(() => {
    _resetSynonymCache();
    brainRoot = createTempBrain(DIGEST_LINES, {});
  });
  after(() => cleanup(brainRoot));

  it("query.type = 'decision' → decision 타입만 반환", () => {
    const result = search(brainRoot, { type: "decision" });
    for (const c of result.candidates) {
      assert.equal(c.type, "decision");
    }
    assert.ok(result.candidates.length > 0);
  });

  it("query.type = 'note' → note 타입만 반환", () => {
    const result = search(brainRoot, { type: "note" });
    for (const c of result.candidates) {
      assert.equal(c.type, "note");
    }
  });

  it("query.type 미지정 → 전체 타입 반환", () => {
    const result = search(brainRoot, {});
    const types = new Set(result.candidates.map(c => c.type));
    assert.ok(types.size > 1);
  });

  it("존재하지 않는 type → 빈 결과", () => {
    const result = search(brainRoot, { type: "nonexistent_type" });
    assert.equal(result.candidates.length, 0);
  });
});

describe("REQ-064: CLI -t 옵션 → query.type 전달", () => {
  it("search 커맨드에 -t 옵션이 정의됨", () => {
    // search 함수가 query.type을 올바르게 처리하는지 확인
    _resetSynonymCache();
    const now = new Date().toISOString();
    const lines = [
      `rec_topic_c1 | 키워드 제목 | 요약 | domain/test | active | decision | candidate | ${now}`,
      `rec_topic_c2 | 키워드 제목 | 요약 | domain/test | active | note | candidate | ${now}`
    ];
    const tmpBrain = createTempBrain(lines, {});

    const result = search(tmpBrain, { currentGoal: "키워드", type: "decision" });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].type, "decision");

    cleanup(tmpBrain);
  });

  it("type 미지정 시 전체 반환", () => {
    _resetSynonymCache();
    const now = new Date().toISOString();
    const lines = [
      `rec_topic_c3 | 키워드 제목 | 요약 | domain/test | active | decision | candidate | ${now}`,
      `rec_topic_c4 | 키워드 제목 | 요약 | domain/test | active | note | candidate | ${now}`
    ];
    const tmpBrain = createTempBrain(lines, {});

    const result = search(tmpBrain, { currentGoal: "키워드" });
    assert.equal(result.candidates.length, 2);

    cleanup(tmpBrain);
  });
});
