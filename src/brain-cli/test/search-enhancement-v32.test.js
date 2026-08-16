"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { search } = require("../src/search");
const { migrateFromJsonl } = require("../src/db");
const { evaluateSearchQuality } = require("../src/search-evaluation");
const { writeJsonl } = require("../src/utils");
const { upsertNodes, upsertEdges, edgeIdFor } = require("../src/memory-graph");

let testRoot;

function createRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brain-search-v32-"));
  for (const dir of ["10_projects", "30_topics", "49_memory_graph", "90_index", "99_policy"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "99_policy", "brainPolicy.md"), "# policy\n", "utf-8");
  fs.writeFileSync(path.join(root, "90_index", "tags.json"), JSON.stringify({
    version: "1.0",
    axes: ["domain", "intent"],
    domain: { values: ["memory", "agent"], synonyms: {}, banned: [] },
    intent: { values: ["retrieval", "decision"], synonyms: {}, banned: [] }
  }, null, 2), "utf-8");
  return root;
}

function seedRecords(root) {
  const records = [
    record("rec_proj_brain_20260629_1001", "Claim Designer", "claim 초안을 만드는 에이전트", "10_projects/brain/claim-designer.md"),
    record("rec_proj_brain_20260629_1002", "Spec Writer", "사양서를 작성하는 에이전트", "10_projects/brain/spec-writer.md"),
    record("rec_proj_brain_20260629_1003", "원문 전용 기록", "제목과 요약에는 특수 키워드가 없다", "10_projects/brain/original-only.md", "candidate", "본문 안에만 hidden-original-token-20260629 라는 단서가 있습니다."),
    record("rec_proj_brain_20260629_1004", "무관한 기록", "검색 품질 평가에서 나오면 안 되는 항목", "10_projects/brain/noise.md"),
  ];
  writeJsonl(path.join(root, "90_index", "records.jsonl"), records);
  fs.writeFileSync(path.join(root, "90_index", "records_digest.txt"), [
    "# Format: recordId | title | summary | tags | status | type | sourceType | updatedAt",
    ...records.map(r => `${r.recordId} | ${r.title} | ${r.summary} | ${r.tags.join(",")} | ${r.status} | ${r.type} | ${r.sourceType} | ${r.updatedAt}`)
  ].join("\n") + "\n", "utf-8");
  migrateFromJsonl(root);
  return records;
}

function record(recordId, title, summary, sourceRef, sourceType = "candidate", originalChunk = null) {
  return {
    recordId,
    scopeType: "project",
    scopeId: "brain",
    type: "note",
    title,
    summary,
    tags: ["domain/memory", "intent/retrieval"],
    sourceType,
    sourceRef,
    status: "active",
    replacedBy: null,
    deprecationReason: null,
    updatedAt: "2026-06-29T00:00:00.000Z",
    contentHash: `sha256:${recordId}`,
    ...(originalChunk ? { originalChunk } : {})
  };
}

function seedMemoryGraph(root) {
  const claimNode = {
    nodeId: "node_claim_designer",
    nodeType: "obsidian_doc",
    scopeId: "brain",
    title: "Claim Designer",
    summary: "claim designer workflow source",
    sourceRef: "10_projects/brain/claim-designer.md",
    status: "active",
    authority: "user_confirmed",
    metadata: { sourceRefs: ["10_projects/brain/claim-designer.md"] }
  };
  const specNode = {
    nodeId: "node_spec_writer",
    nodeType: "obsidian_doc",
    scopeId: "brain",
    title: "Spec Writer",
    summary: "spec writer receives claim draft",
    sourceRef: "10_projects/brain/spec-writer.md",
    status: "active",
    authority: "normal",
    metadata: { sourceRefs: ["10_projects/brain/spec-writer.md"] }
  };
  upsertNodes(root, [claimNode, specNode]);
  upsertEdges(root, [{
    edgeId: edgeIdFor(claimNode.nodeId, specNode.nodeId, "outputs_to"),
    fromNodeId: claimNode.nodeId,
    toNodeId: specNode.nodeId,
    relation: "outputs_to",
    weight: 0.85,
    confidence: 0.85,
    provenance: ["10_projects/brain/claim-designer.md", "10_projects/brain/spec-writer.md"],
    metadata: {}
  }]);
}

describe("Brain search enhancement v3.2", () => {
  beforeEach(() => {
    testRoot = createRoot();
    seedRecords(testRoot);
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("originalChunk 전문 보조 FTS로 제목/요약에 없는 원문 단서를 찾는다", () => {
    const result = search(testRoot, {
      scopeType: "project",
      scopeId: "brain",
      currentGoal: "hidden-original-token-20260629",
      topK: 3
    });

    assert.equal(result.candidates[0].recordId, "rec_proj_brain_20260629_1003");
    assert.equal(result.candidates[0]._layer, "ORIGINAL");
    assert.match(result.candidates[0].originalChunkPreview, /hidden-original-token-20260629/);
    assert.equal(Object.hasOwn(result.candidates[0], "originalChunk"), false);
  });

  it("Memory Graph activation으로 직접 키워드가 없는 연결 record를 후보에 포함한다", () => {
    seedMemoryGraph(testRoot);
    const result = search(testRoot, {
      scopeType: "project",
      scopeId: "brain",
      currentGoal: "Claim Designer outputs_to 관계",
      topK: 5
    });

    assert.equal(result.queryType, "relational");
    const graphCandidate = result.candidates.find(c => c.recordId === "rec_proj_brain_20260629_1002");
    assert.ok(graphCandidate);
    assert.equal(graphCandidate._layer, "GRAPH");
    assert.ok(graphCandidate.graphNodeIds?.includes("node_spec_writer") || graphCandidate.graphRelations?.includes("outputs_to"));
  });

  it("검색 품질 평가 세트가 Hit@1/Hit@3/MRR와 실패 여부를 계산한다", () => {
    seedMemoryGraph(testRoot);
    const report = evaluateSearchQuality(testRoot, {
      topK: 5,
      cases: [{
        caseId: "original-token",
        query: "hidden-original-token-20260629",
        scopeType: "project",
        scopeId: "brain",
        expectedRecordIds: ["rec_proj_brain_20260629_1003"],
        forbiddenRecordIds: ["rec_proj_brain_20260629_1004"],
        expectedQueryType: "exploratory",
        mustHitAt: 1
      }, {
        caseId: "graph-relation",
        query: "Claim Designer outputs_to 관계",
        scopeType: "project",
        scopeId: "brain",
        expectedRecordIds: ["rec_proj_brain_20260629_1002"],
        expectedQueryType: "relational",
        mustHitAt: 3
      }]
    });

    assert.equal(report.status, "passed");
    assert.equal(report.total, 2);
    assert.equal(report.metrics.hitAt3, 1);
    assert.ok(report.metrics.mrr > 0);
  });
});