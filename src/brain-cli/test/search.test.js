"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { search, getRecordDetail } = require("../src/search");
const { writeJsonl } = require("../src/utils");

let testRoot;

function setupBrain() {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-search-test-"));

  fs.mkdirSync(path.join(testRoot, "90_index"), { recursive: true });

  // records_digest.txt 생성
  const digest = [
    "# Brain records_digest.txt",
    "# Format: recordId | title | summary | tags | status",
    "rec_proj_myApp_20260226_0001 | API 설계 결정 | REST API 엔드포인트 구조 결정 | domain/infra,intent/decision | active",
    "rec_proj_myApp_20260226_0002 | 인증 흐름 | OAuth2 인증 플로우 정리 | domain/auth,intent/reference | active",
    "rec_topic_memory_20260226_0001 | 메모리 검색 | 검색 알고리즘 후보 정리 | domain/memory,intent/retrieval | active",
    "rec_user_test_20260226_0001 | 사용자 선호 | 코딩 스타일 선호도 | domain/ui,intent/decision | active",
    "rec_proj_myApp_20260226_0003 | 삭제된 결정 | 더 이상 유효하지 않음 | domain/infra | deprecated"
  ].join("\n") + "\n";

  fs.writeFileSync(path.join(testRoot, "90_index", "records_digest.txt"), digest, "utf-8");

  // records.jsonl 생성 (상세 조회용)
  const records = [
    {
      recordId: "rec_proj_myApp_20260226_0001",
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
      recordId: "rec_proj_myApp_20260226_0002",
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
});

describe("search: topK 제한", () => {
  before(() => setupBrain());
  after(() => teardownBrain());

  it("topK=2로 제한하면 최대 2건만 반환해야 한다", () => {
    const result = search(testRoot, { topK: 2 });
    assert.ok(result.candidates.length <= 2);
  });
});

describe("getRecordDetail: 상세 조회", () => {
  before(() => setupBrain());
  after(() => teardownBrain());

  it("존재하는 recordId로 상세 정보를 조회할 수 있어야 한다", () => {
    const detail = getRecordDetail(testRoot, "rec_proj_myApp_20260226_0001");
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
