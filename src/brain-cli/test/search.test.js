"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { search, getRecordDetail, _isSufficient, _mergeByRecordId, _getSearchGoal } = require("../src/search");
const { writeJsonl } = require("../src/utils");

let testRoot;

function setupBrain() {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-search-test-"));

  fs.mkdirSync(path.join(testRoot, "90_index"), { recursive: true });

  // records_digest.txt 생성
  const digest = [
    "# Brain records_digest.txt",
    "# Format: recordId | title | summary | tags | status",
    "rec_proj_myapp_20260226_0001 | API 설계 결정 | REST API 엔드포인트 구조 결정 | domain/infra,intent/decision | active",
    "rec_proj_myapp_20260226_0002 | 인증 흐름 | OAuth2 인증 플로우 정리 | domain/auth,intent/reference | active",
    "rec_topic_memory_20260226_0001 | 메모리 검색 | 검색 알고리즘 후보 정리 | domain/memory,intent/retrieval | active",
    "rec_user_test_20260226_0001 | 사용자 선호 | 코딩 스타일 선호도 | domain/ui,intent/decision | active",
    "rec_proj_myapp_20260226_0003 | 삭제된 결정 | 더 이상 유효하지 않음 | domain/infra | deprecated"
  ].join("\n") + "\n";

  fs.writeFileSync(path.join(testRoot, "90_index", "records_digest.txt"), digest, "utf-8");

  // records.jsonl 생성 (상세 조회용)
  const records = [
    {
      recordId: "rec_proj_myapp_20260226_0001",
      scopeType: "project",
      scopeId: "myApp",
      type: "decision",
      title: "API 설계 결정",
      summary: "REST API 엔드포인트 구조 결정",
      tags: ["domain/infra", "intent/decision"],
      sourceType: "user_confirmed",
      sourceRef: "10_projects/myApp/ssot/api-design.md",
      status: "active",
      replacedBy: null,
      deprecationReason: null,
      updatedAt: "2026-02-26T10:00:00.000Z",
      contentHash: "sha256:abc123"
    },
    {
      recordId: "rec_proj_myapp_20260226_0002",
      scopeType: "project",
      scopeId: "myApp",
      type: "ref",
      title: "인증 흐름",
      summary: "OAuth2 인증 플로우 정리",
      tags: ["domain/auth", "intent/reference"],
      sourceType: "candidate",
      sourceRef: "10_projects/myApp/refs/auth-flow.md",
      status: "active",
      replacedBy: null,
      deprecationReason: null,
      updatedAt: "2026-02-26T10:00:00.000Z",
      contentHash: "sha256:def456"
    }
  ];
  writeJsonl(path.join(testRoot, "90_index", "records.jsonl"), records);
}

function teardownBrain() {
  if (testRoot && fs.existsSync(testRoot)) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

describe("search: scopeType/scopeId 필터링", () => {
  before(() => setupBrain());
  after(() => teardownBrain());

  it("project 스코프로 필터링하면 project 레코드만 반환해야 한다", () => {
    const result = search(testRoot, { scopeType: "project" });
    // active만 반환 (deprecated 제외)
    assert.equal(result.candidates.length, 2);
    for (const c of result.candidates) {
      assert.ok(c.recordId.includes("_proj_"));
    }
  });

  it("scopeId까지 지정하면 해당 프로젝트만 반환해야 한다", () => {
    const result = search(testRoot, { scopeType: "project", scopeId: "myApp" });
    assert.equal(result.candidates.length, 2);
  });

  it("topic 스코프로 필터링해야 한다", () => {
    const result = search(testRoot, { scopeType: "topic" });
    assert.equal(result.candidates.length, 1);
    assert.ok(result.candidates[0].recordId.includes("_topic_"));
  });
});

describe("search: status=active 필터", () => {
  before(() => setupBrain());
  after(() => teardownBrain());

  it("deprecated 레코드는 결과에 포함되지 않아야 한다", () => {
    const result = search(testRoot, {});
    const deprecated = result.candidates.filter(c => c.status === "deprecated");
    assert.equal(deprecated.length, 0);
  });
});

describe("search: currentGoal 매칭", () => {
  before(() => setupBrain());
  after(() => teardownBrain());

  it("관련성 높은 레코드가 상위에 정렬되어야 한다", () => {
    const result = search(testRoot, {
      currentGoal: "API 설계 엔드포인트"
    });
    assert.ok(result.candidates.length > 0);
    // "API 설계 결정"이 가장 높은 점수를 받아야 함
    assert.equal(result.candidates[0].title, "API 설계 결정");
  });

  it("메모리 검색 관련 goal은 해당 레코드를 상위로 올려야 한다", () => {
    const result = search(testRoot, {
      currentGoal: "메모리 검색 알고리즘"
    });
    assert.ok(result.candidates.length > 0);
    assert.equal(result.candidates[0].title, "메모리 검색");
  });

  it("goal 별칭도 currentGoal처럼 검색에 사용해야 한다", () => {
    const result = search(testRoot, {
      goal: "API 설계 엔드포인트"
    });
    assert.ok(result.candidates.length > 0);
    assert.equal(result.candidates[0].title, "API 설계 결정");
    assert.equal(_getSearchGoal({ goal: "API 설계" }), "API 설계");
  });
});

describe("search: topK 제한", () => {
  before(() => setupBrain());
  after(() => teardownBrain());

  it("topK=2로 제한하면 최대 2건만 반환해야 한다", () => {
    const result = search(testRoot, { topK: 2 });
    assert.ok(result.candidates.length <= 2);
  });
});

describe("멀티레이어 검색: L0 에스컬레이션", () => {
  before(() => setupBrain());
  after(() => teardownBrain());

  it("currentGoal 없으면 L0에서 즉시 반환되어야 한다", () => {
    const result = search(testRoot, { scopeType: "project" });
    assert.equal(result.candidates.length, 2);
    // DB가 없으므로 L0 경로만 실행됨
    for (const c of result.candidates) {
      assert.equal(c._layer, "L0");
    }
  });

  it("forceLayer=0이면 DB 없이 L0만 실행되어야 한다", () => {
    const result = search(testRoot, {
      currentGoal: "API 설계",
      forceLayer: 0
    });
    assert.ok(result.candidates.length > 0);
    for (const c of result.candidates) {
      assert.equal(c._layer, "L0");
    }
  });

  it("_isSufficient: score >= minScore AND count >= topK 시 true", () => {
    const scored = [
      { score: 10.0 }, { score: 9.0 }, { score: 8.5 },
      { score: 8.1 }, { score: 8.0 }, { score: 7.0 }
    ];
    assert.equal(_isSufficient(scored, { minScore: 8.0 }, 5), true);
  });

  it("_isSufficient: count가 topK보다 적어도 maxScore 충분하면 true", () => {
    const scored = [{ score: 10.0 }, { score: 9.0 }];
    // maxScore(10.0) >= minScore(8.0) → true (count 조건 제거 — Brain recall 속도 개선)
    assert.equal(_isSufficient(scored, { minScore: 8.0 }, 5), true);
  });

  it("_isSufficient: maxScore < minScore 시 false", () => {
    const scored = [
      { score: 3.0 }, { score: 2.0 }, { score: 1.5 },
      { score: 1.0 }, { score: 0.5 }
    ];
    assert.equal(_isSufficient(scored, { minScore: 8.0 }, 3), false);
  });

  it("_isSufficient: 빈 배열은 false", () => {
    assert.equal(_isSufficient([], { minScore: 8.0 }, 5), false);
  });
});

describe("멀티레이어 검색: _mergeByRecordId", () => {
  it("같은 recordId는 높은 score 유지", () => {
    const l0 = [{ recordId: "rec_a", score: 3.0, _layer: "L0", title: "A" }];
    const l1 = [{ recordId: "rec_a", score: 7.0, _layer: "L1", title: "A" }];
    const merged = _mergeByRecordId([l0, l1]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].score, 7.0);
    assert.equal(merged[0]._layer, "L1");
  });

  it("낮은 score가 나중에 와도 높은 score 유지", () => {
    const l1 = [{ recordId: "rec_b", score: 8.0, _layer: "L1", title: "B" }];
    const l0 = [{ recordId: "rec_b", score: 2.0, _layer: "L0", title: "B" }];
    const merged = _mergeByRecordId([l1, l0]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].score, 8.0);
  });

  it("서로 다른 recordId는 모두 포함", () => {
    const l0 = [{ recordId: "rec_a", score: 3.0, _layer: "L0", title: "A" }];
    const l1 = [{ recordId: "rec_b", score: 5.0, _layer: "L1", title: "B" }];
    const merged = _mergeByRecordId([l0, l1]);
    assert.equal(merged.length, 2);
  });

  it("빈 배열들 처리 가능", () => {
    const merged = _mergeByRecordId([[], [], []]);
    assert.equal(merged.length, 0);
  });
});

describe("getRecordDetail: 상세 조회", () => {
  before(() => setupBrain());
  after(() => teardownBrain());

  it("존재하는 recordId로 상세 정보를 조회할 수 있어야 한다", () => {
    const detail = getRecordDetail(testRoot, "rec_proj_myapp_20260226_0001");
    assert.ok(detail);
    assert.equal(detail.title, "API 설계 결정");
    assert.equal(detail.sourceType, "user_confirmed");
    assert.equal(detail.sourceRef, "10_projects/myApp/ssot/api-design.md");
  });

  it("존재하지 않는 recordId는 null을 반환해야 한다", () => {
    const detail = getRecordDetail(testRoot, "rec_none_x_20260101_9999");
    assert.equal(detail, null);
  });
});
