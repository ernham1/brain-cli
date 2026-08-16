"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { BWTEngine } = require("../src/bwt");
const {
  search,
  getRecordDetail,
  _classifyQueryType,
  _previewOriginalChunk
} = require("../src/search");
const { validateRecord, validateIntent } = require("../src/schemas");
const { writeJsonl, calculateHashFromString } = require("../src/utils");
const { brainRecall } = require("../src/mcp-server");

let testRoot;
let previousBrainRoot;

function createBaseRoot(prefix = "brain-search-v3-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const dir of ["00_user", "10_projects", "20_agents", "30_topics", "42_facts", "90_index", "99_policy"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "90_index", "records.jsonl"), "", "utf-8");
  fs.writeFileSync(path.join(root, "90_index", "links.jsonl"), "", "utf-8");
  fs.writeFileSync(path.join(root, "90_index", "records_digest.txt"),
    "# Brain records_digest.txt\n# Format: recordId | title | summary | tags | status | type | sourceType | updatedAt\n",
    "utf-8"
  );
  fs.writeFileSync(path.join(root, "90_index", "tags.json"), JSON.stringify({
    version: "1.0",
    axes: ["domain", "intent"],
    domain: { values: ["memory", "search"], synonyms: {}, banned: [] },
    intent: { values: ["retrieval", "decision"], synonyms: {}, banned: [] }
  }, null, 2), "utf-8");
  fs.writeFileSync(path.join(root, "90_index", "folderRegistry.json"), JSON.stringify({
    version: "1.0",
    folders: [
      { path: "00_user/", scopeType: "user", autoCreate: false },
      { path: "10_projects/", scopeType: "project", autoCreate: true },
      { path: "20_agents/", scopeType: "agent", autoCreate: false },
      { path: "30_topics/", scopeType: "topic", autoCreate: true },
      { path: "90_index/", scopeType: null, autoCreate: false },
      { path: "99_policy/", scopeType: null, autoCreate: false }
    ]
  }, null, 2), "utf-8");
  fs.writeFileSync(path.join(root, "90_index", "manifest.json"), JSON.stringify({
    version: "1.0",
    brainRoot: "Brain",
    updatedAt: new Date().toISOString(),
    summary: { totalFiles: 0, byCategory: { policy: 0, user: 0, project: 0, agent: 0, topic: 0, index: 0 } },
    files: []
  }, null, 2), "utf-8");
  fs.writeFileSync(path.join(root, "99_policy", "brainPolicy.md"), "# Brain 운영 정책\n", "utf-8");
  return root;
}

function seedSearchRecords(root) {
  const records = [
    {
      recordId: "rec_proj_brain_20260629_0001",
      scopeType: "project",
      scopeId: "brain",
      type: "decision",
      title: "Brain L0 임계값",
      summary: "L0 검색 임계값은 8.0으로 유지한다",
      tags: ["domain/search", "intent/decision"],
      sourceType: "user_confirmed",
      sourceRef: "10_projects/brain/l0-threshold.md",
      status: "active",
      replacedBy: null,
      deprecationReason: null,
      updatedAt: "2026-06-29T00:00:00.000Z",
      contentHash: "sha256:111",
      originalChunk: "이사님: Brain의 L0 임계값이 뭐였지?\nCodex: L0 임계값은 8.0입니다."
    },
    {
      recordId: "rec_proj_brain_20260629_0002",
      scopeType: "project",
      scopeId: "brain",
      type: "note",
      title: "오케스트레이터 설계",
      summary: "텔레클로는 완료 보고 대신 검증과 재작업 지시를 맡는다",
      tags: ["domain/memory", "intent/retrieval"],
      sourceType: "candidate",
      sourceRef: "10_projects/brain/orchestrator.md",
      status: "active",
      replacedBy: null,
      deprecationReason: null,
      updatedAt: "2026-06-28T00:00:00.000Z",
      contentHash: "sha256:222"
    },
    {
      recordId: "rec_proj_brain_20260629_0003",
      scopeType: "project",
      scopeId: "brain",
      type: "note",
      title: "검증 루프",
      summary: "작업 결과는 증거 기준을 통과해야 완료로 인정한다",
      tags: ["domain/search", "intent/retrieval"],
      sourceType: "candidate",
      sourceRef: "10_projects/brain/verification-loop.md",
      status: "active",
      replacedBy: null,
      deprecationReason: null,
      updatedAt: "2026-06-28T01:00:00.000Z",
      contentHash: "sha256:333"
    }
  ];
  writeJsonl(path.join(root, "90_index", "records.jsonl"), records);
  fs.writeFileSync(path.join(root, "90_index", "records_digest.txt"), [
    "# Brain records_digest.txt",
    "# Format: recordId | title | summary | tags | status | type | sourceType | updatedAt",
    "rec_proj_brain_20260629_0001 | Brain L0 임계값 | L0 검색 임계값은 8.0으로 유지한다 | domain/search,intent/decision | active | decision | user_confirmed | 2026-06-29T00:00:00.000Z",
    "rec_proj_brain_20260629_0002 | 오케스트레이터 설계 | 텔레클로는 완료 보고 대신 검증과 재작업 지시를 맡는다 | domain/memory,intent/retrieval | active | note | candidate | 2026-06-28T00:00:00.000Z",
    "rec_proj_brain_20260629_0003 | 검증 루프 | 작업 결과는 증거 기준을 통과해야 완료로 인정한다 | domain/search,intent/retrieval | active | note | candidate | 2026-06-28T01:00:00.000Z"
  ].join("\n") + "\n", "utf-8");
  writeJsonl(path.join(root, "42_facts", "facts.jsonl"), [
    {
      factId: "fact_l0_threshold",
      scopeType: "project",
      scopeId: "brain",
      subject: "Brain L0",
      predicate: "threshold",
      object: "8.0",
      status: "active",
      sourceRecordIds: ["rec_proj_brain_20260629_0001"],
      sourceRefs: ["10_projects/brain/l0-threshold.md"],
      sourceType: "user_confirmed",
      confidence: 0.9,
      updatedAt: "2026-06-29T00:00:00.000Z"
    }
  ]);
  writeJsonl(path.join(root, "90_index", "links.jsonl"), [
    {
      fromId: "rec_proj_brain_20260629_0002",
      toId: "rec_proj_brain_20260629_0003",
      linkType: "depends_on",
      createdAt: "2026-06-29T00:00:00.000Z"
    }
  ]);
}

describe("Brain search enhancement v3.1", () => {
  beforeEach(() => {
    previousBrainRoot = process.env.BRAIN_ROOT;
    testRoot = createBaseRoot();
    process.env.BRAIN_ROOT = testRoot;
  });

  afterEach(() => {
    if (previousBrainRoot === undefined) delete process.env.BRAIN_ROOT;
    else process.env.BRAIN_ROOT = previousBrainRoot;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("originalChunk는 선택 필드이며 기존 14필드 레코드와 호환된다", () => {
    const legacyRecord = {
      recordId: "rec_proj_brain_20260629_0009",
      scopeType: "project",
      scopeId: "brain",
      type: "note",
      title: "기존 레코드",
      summary: "기존 14필드만 있는 레코드",
      tags: ["domain/search"],
      sourceType: "candidate",
      sourceRef: "10_projects/brain/legacy.md",
      status: "active",
      replacedBy: null,
      deprecationReason: null,
      updatedAt: "2026-06-29T00:00:00.000Z",
      contentHash: "sha256:legacy"
    };

    assert.equal(validateRecord(legacyRecord).valid, true);
    assert.equal(validateIntent({
      action: "create",
      sourceRef: "10_projects/brain/new.md",
      content: "본문",
      originalChunk: null,
      record: {
        scopeType: "project",
        scopeId: "brain",
        type: "note",
        title: "새 기록",
        summary: "요약",
        tags: ["domain/search"],
        sourceType: "candidate"
      }
    }).valid, true);
    assert.equal(validateIntent({
      action: "create",
      sourceRef: "10_projects/brain/new.md",
      content: "본문",
      originalChunk: { text: "bad" },
      record: {
        scopeType: "project",
        scopeId: "brain",
        type: "note",
        title: "새 기록",
        summary: "요약",
        tags: ["domain/search"],
        sourceType: "candidate"
      }
    }).valid, false);
  });

  it("BWT create/update는 originalChunk를 2000자로 잘라 저장한다", () => {
    const engine = new BWTEngine(testRoot);
    const longOriginal = "원".repeat(2100);
    const result = engine.execute({
      action: "create",
      sourceRef: "10_projects/brain/original.md",
      content: "요약 본문",
      originalChunk: longOriginal,
      record: {
        scopeType: "project",
        scopeId: "brain",
        type: "note",
        title: "원본 청크 테스트",
        summary: "원본 청크 저장 검증",
        tags: ["domain/search"],
        sourceType: "candidate"
      }
    });

    assert.equal(result.success, true);
    let detail = getRecordDetail(testRoot, result.recordId);
    assert.equal(detail.originalChunk.length, 2000);

    const updated = new BWTEngine(testRoot).execute({
      action: "update",
      recordId: result.recordId,
      sourceRef: "10_projects/brain/original.md",
      content: "수정 본문",
      originalChunk: "수정된 원본"
    });
    assert.equal(updated.success, true);
    detail = getRecordDetail(testRoot, result.recordId);
    assert.equal(detail.originalChunk, "수정된 원본");
    assert.equal(detail.contentHash, calculateHashFromString("수정 본문"));
  });

  it("query type을 temporal/factual/relational/exploratory로 분류한다", () => {
    assert.equal(_classifyQueryType("금요일 변경된 내용 테스트 검증"), "temporal");
    assert.equal(_classifyQueryType("Brain의 L0 임계값이 뭐였지"), "factual");
    assert.equal(_classifyQueryType("오케스트레이터와 검증 루프 연결 관계"), "relational");
    assert.equal(_classifyQueryType("메모리 시스템 개선 아이디어"), "exploratory");
  });

  it("factual query는 Fact Ledger source record를 FACT 레이어로 부스팅한다", () => {
    seedSearchRecords(testRoot);
    const result = search(testRoot, {
      scopeType: "project",
      scopeId: "brain",
      currentGoal: "Brain의 L0 임계값이 뭐였지",
      topK: 3
    });

    assert.equal(result.queryType, "factual");
    assert.equal(result.candidates[0].recordId, "rec_proj_brain_20260629_0001");
    assert.equal(result.candidates[0]._layer, "FACT");
    assert.match(result.candidates[0].originalChunkPreview, /L0 임계값은 8.0/);
    assert.ok(result.searchPlan.factLedgerFirst);
  });

  it("relational query는 links.jsonl의 1-hop 후보를 L1.5로 포함한다", () => {
    seedSearchRecords(testRoot);
    const result = search(testRoot, {
      scopeType: "project",
      scopeId: "brain",
      currentGoal: "오케스트레이터 후속 관계",
      topK: 5
    });

    assert.equal(result.queryType, "relational");
    assert.ok(result.searchPlan.graphTraversal);
    const linked = result.candidates.find(candidate => candidate.recordId === "rec_proj_brain_20260629_0003");
    assert.ok(linked);
    assert.equal(linked._layer, "L1.5");
    assert.deepEqual(linked.linkedFrom, ["rec_proj_brain_20260629_0002"]);
  });

  it("MCP brainRecall은 originalChunk 전문 대신 preview만 반환한다", () => {
    seedSearchRecords(testRoot);
    const text = brainRecall({ goal: "Brain의 L0 임계값이 뭐였지", scopeType: "project", scopeId: "brain", topK: 1 });

    assert.match(text, /Brain L0 임계값/);
    assert.match(text, /원본:/);
    assert.doesNotMatch(text, /originalChunk/);
    assert.ok(_previewOriginalChunk("a".repeat(250)).length <= 203);
  });
});
