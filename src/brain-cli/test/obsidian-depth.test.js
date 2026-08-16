"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { indexObsidian } = require("../src/obsidian-connector");
const { indexDepthForSource, retrieveDepth, chooseDepth, allowedDepths } = require("../src/depth-retriever");
const { createMemoryBrief } = require("../src/context-assembler");
const { upsertFact } = require("../src/fact-ledger");

let testRoot;
let obsidianRoot;

function setupRoot() {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-obsidian-depth-"));
  obsidianRoot = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-ai-"));
  fs.mkdirSync(path.join(testRoot, "90_index"), { recursive: true });
  fs.writeFileSync(path.join(testRoot, "90_index", "records_digest.txt"), "", "utf-8");
  fs.writeFileSync(path.join(obsidianRoot, "Brain-Memory-Kernel.md"), [
    "---",
    "doc_type: design",
    "status: final",
    "visibility: project",
    "scope: brain",
    "---",
    "# Brain Memory Kernel",
    "Brain Memory Kernel은 Active State와 Fact Ledger를 사용한다.",
    "## 검증",
    "설계서 검증은 D2 섹션에서 시작한다.",
    "",
    "충돌 판단은 D3 블록 근거와 D4 원문 라인까지 확인한다.",
    "반복 제안 차단은 기존 fact와 답변 초안을 함께 비교한다.",
    "Brain Memory Kernel conflictMode automatic review supported."
  ].join("\n"), "utf-8");
}

describe("Obsidian D0-D4 retrieval", () => {
  beforeEach(setupRoot);
  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.rmSync(obsidianRoot, { recursive: true, force: true });
  });

  it("source registry와 depth index를 생성하고 depth를 자동 선택한다", () => {
    const indexed = indexObsidian(testRoot, { root: obsidianRoot, scope: "brain", limit: 10 });
    const source = indexed.sources[0];
    const depth = indexDepthForSource(testRoot, source.sourceId);
    const result = retrieveDepth(testRoot, { goal: "Brain Memory Kernel 설계서 검증해줘", scopeId: "brain", depth: "auto" });

    assert.equal(indexed.indexed, 1);
    assert.ok(depth.entries.some(entry => entry.depth === "D2"));
    assert.ok(depth.entries.some(entry => entry.depth === "D3" && entry.lineStart && entry.lineEnd));
    assert.ok(depth.entries.some(entry => entry.depth === "D4" && entry.rawRef && entry.rawRef.includes("Brain-Memory-Kernel.md")));
    assert.equal(chooseDepth("설계서 검증해줘", "auto"), "D4");
    assert.ok(allowedDepths("D4").has("D3"));
    assert.ok(result.sections.some(section => section.depth === "D4"));
  });

  it("간단 질문은 낮은 depth만 사용하고 원문 요청은 D4 라인을 반환한다", () => {
    const indexed = indexObsidian(testRoot, { root: obsidianRoot, scope: "brain", limit: 10 });
    indexDepthForSource(testRoot, indexed.sources[0].sourceId);

    const simple = retrieveDepth(testRoot, { goal: "Brain Memory Kernel 뭐야", scopeId: "brain", depth: "auto" });
    const evidence = retrieveDepth(testRoot, { goal: "충돌 판단 원문 라인 근거", scopeId: "brain", depth: "auto", topK: 10 });

    assert.equal(simple.selectedDepth, "D1");
    assert.ok(simple.sections.every(section => ["D0", "D1"].includes(section.depth)));
    assert.equal(evidence.selectedDepth, "D4");
    assert.ok(evidence.sections.some(section => section.depth === "D4" && section.rawRef && section.lineStart <= section.lineEnd));
  });

  it("Memory Brief에 obsidianSignals와 usedRefs를 포함한다", () => {
    const indexed = indexObsidian(testRoot, { root: obsidianRoot, scope: "brain", limit: 10 });
    indexDepthForSource(testRoot, indexed.sources[0].sourceId);
    const brief = createMemoryBrief(testRoot, { project: "brain", goal: "설계서 검증해줘" });

    assert.ok(Array.isArray(brief.sections.obsidianSignals.sections));
    assert.ok(brief.usedRefs.some(ref => ref.includes("Brain-Memory-Kernel.md")));
  });

  it("Memory Brief는 peer root의 Obsidian D4 근거도 합산한다", () => {
    const primaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-primary-no-obsidian-"));
    fs.mkdirSync(path.join(primaryRoot, "90_index"), { recursive: true });
    fs.writeFileSync(path.join(primaryRoot, "90_index", "records_digest.txt"), "", "utf-8");

    try {
      const indexed = indexObsidian(testRoot, { root: obsidianRoot, scope: "brain", limit: 10 });
      indexDepthForSource(testRoot, indexed.sources[0].sourceId);
      const brief = createMemoryBrief(primaryRoot, {
        project: "brain",
        goal: "충돌 판단 원문 라인 근거",
        depth: "auto",
        depthTopK: 10,
        peerRoots: [testRoot]
      });

      assert.ok(brief.sections.obsidianSignals.sections.some(section =>
        section.depth === "D4" && section._rootRole === "peer"
      ));
    } finally {
      fs.rmSync(primaryRoot, { recursive: true, force: true });
    }
  });

  it("Fact Ledger와 Obsidian D4 원문이 충돌하면 Detector가 검토 신호를 낸다", () => {
    upsertFact(testRoot, {
      scopeId: "brain",
      subject: "Brain Memory Kernel",
      predicate: "conflictMode",
      object: "manual review only",
      sourceRefs: ["rec_confirmed_conflict_mode"],
      sourceType: "user_confirmed"
    });
    upsertFact(testRoot, {
      scopeId: "brain",
      subject: "Brain Memory Kernel",
      predicate: "conflictMode",
      object: "automatic review supported",
      sourceRefs: ["rec_candidate_conflict_mode"],
      sourceType: "candidate"
    });
    const indexed = indexObsidian(testRoot, { root: obsidianRoot, scope: "brain", limit: 10 });
    indexDepthForSource(testRoot, indexed.sources[0].sourceId);

    const brief = createMemoryBrief(testRoot, {
      project: "brain",
      goal: "Brain Memory Kernel conflictMode 최신 충돌 검증 원문 근거",
      depth: "auto",
      depthTopK: 10
    });
    const detector = brief.sections.evidenceDigest.detector;

    assert.equal(detector.status, "review_before_use");
    assert.equal(detector.recommendedUse.requireReview, true);
    assert.equal(detector.recommendedUse.requireCitation, true);
    assert.ok(detector.reasons.includes("fact_obsidian_conflict"));
    assert.ok(detector.reasons.includes("disputed_fact_present"));
    assert.ok(brief.sections.evidenceDigest.records.some(record =>
      record.analyzer === "obsidian" &&
      record.reasons.includes("rawRef")
    ));
    assert.ok(brief.sections.evidenceDigest.records.some(record =>
      record.analyzer === "fact" &&
      record.reasons.includes("status:disputed")
    ));
  });
});
