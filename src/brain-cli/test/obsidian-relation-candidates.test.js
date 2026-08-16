"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { indexObsidian } = require("../src/obsidian-connector");
const { splitFrontmatter } = require("../src/obsidian-frontmatter");
const {
  applyApprovedRelationCandidate,
  generateRelationCandidates,
  listRelationCandidates,
  reviewRelationCandidate
} = require("../src/obsidian-relation-candidates");
const { buildMemoryGraphBrief, readEdges, seedGraphFromSources } = require("../src/memory-graph");

let brainRoot;
let obsidianRoot;

function writeMarkdown(filePath, frontmatterLines, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [
    "---",
    ...frontmatterLines,
    "---",
    body
  ].join("\n"), "utf-8");
}

function setupRoot() {
  brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-relation-candidates-"));
  obsidianRoot = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-relation-candidates-"));
  fs.mkdirSync(path.join(brainRoot, "90_index"), { recursive: true });

  writeMarkdown(path.join(obsidianRoot, "agents", "Claim-Designer.md"), [
    "canonical_id: agent.claim-designer",
    "doc_type: agent",
    "scope_id: patent",
    "scope: patent",
    "status: active",
    "authority: user_confirmed",
    "memory_classes:",
    "  - workflow",
    "memory:",
    "  node_type: agent",
    "  relations: []"
  ], "# Claim Designer\n\nClaim Designer drafts patent claims.");

  writeMarkdown(path.join(obsidianRoot, "agents", "Claim-Reviewer.md"), [
    "canonical_id: agent.claim-reviewer",
    "doc_type: agent",
    "scope_id: patent",
    "scope: patent",
    "status: active",
    "authority: user_confirmed",
    "memory_classes:",
    "  - workflow",
    "memory:",
    "  node_type: agent",
    "  relations: []"
  ], "# Claim Reviewer\n\nClaim Reviewer reviews patent claims.");

  writeMarkdown(path.join(obsidianRoot, "agents", "Spec-Writer.md"), [
    "canonical_id: agent.spec-writer",
    "doc_type: agent",
    "scope_id: patent",
    "scope: patent",
    "status: active",
    "authority: user_confirmed",
    "memory_classes:",
    "  - workflow",
    "memory:",
    "  node_type: agent",
    "  relations: []"
  ], "# Spec Writer\n\nSpecification Writer prepares technical specification drafts.");

  indexObsidian(brainRoot, { root: obsidianRoot, scope: "patent" });
}

function findDesignerToReviewerCandidate() {
  return listRelationCandidates(brainRoot, { scope: "patent" }).find(candidate =>
    candidate.source.canonicalId === "agent.claim-designer" &&
    candidate.target.canonicalId === "agent.claim-reviewer"
  );
}

function findDesignerToSpecWriterCandidate() {
  return listRelationCandidates(brainRoot, { scope: "patent" }).find(candidate =>
    candidate.source.canonicalId === "agent.claim-designer" &&
    candidate.target.canonicalId === "agent.spec-writer"
  );
}

describe("Obsidian relation candidates", () => {
  beforeEach(setupRoot);
  afterEach(() => {
    fs.rmSync(brainRoot, { recursive: true, force: true });
    fs.rmSync(obsidianRoot, { recursive: true, force: true });
  });

  it("후보 생성은 source registry 유사도로 relation candidate를 저장한다", () => {
    const result = generateRelationCandidates(brainRoot, {
      scope: "patent",
      minScore: 0.35,
      limit: 10
    });
    const candidate = findDesignerToReviewerCandidate();

    assert.equal(result.sourceCount, 3);
    assert.ok(result.generatedCount >= 3);
    assert.ok(candidate);
    assert.equal(candidate.status, "candidate");
    assert.equal(candidate.relation.type, "similar_to");
    assert.ok(candidate.signals.includes("same_scope"));
    assert.ok(candidate.signals.includes("shared_memory_class"));
  });

  it("후보 리뷰는 approved/dismissed 상태와 결정 로그를 남긴다", () => {
    generateRelationCandidates(brainRoot, { scope: "patent", minScore: 0.35, limit: 10 });
    const candidate = findDesignerToReviewerCandidate();
    const review = reviewRelationCandidate(brainRoot, {
      candidateId: candidate.candidateId,
      decision: "approved",
      reason: "같은 특허 청구항 워크플로우 agent",
      reviewer: "Codex"
    });

    assert.equal(review.candidate.status, "approved");
    assert.equal(review.decision.decision, "approved");
    assert.equal(review.decision.candidateId, candidate.candidateId);
  });

  it("approved 후보만 frontmatter에 적용하고 재색인 후 Memory Graph edge가 생성된다", () => {
    generateRelationCandidates(brainRoot, { scope: "patent", minScore: 0.35, limit: 10 });
    const candidate = findDesignerToReviewerCandidate();
    reviewRelationCandidate(brainRoot, {
      candidateId: candidate.candidateId,
      decision: "approved",
      reason: "같은 청구항 agent 묶음",
      reviewer: "Codex"
    });

    const result = applyApprovedRelationCandidate(brainRoot, {
      candidateId: candidate.candidateId,
      backupDir: path.join(obsidianRoot, ".relation-backup"),
      appliedBy: "Codex"
    });
    const sourceContent = fs.readFileSync(path.join(obsidianRoot, "agents", "Claim-Designer.md"), "utf-8");
    const frontmatter = splitFrontmatter(sourceContent).data;

    assert.equal(result.application.status, "applied");
    assert.ok(fs.existsSync(path.join(obsidianRoot, ".relation-backup", "agents", "Claim-Designer.md")));
    assert.deepEqual(frontmatter.memory.relations, [{
      target: "agent.claim-reviewer",
      type: "similar_to",
      direction: "outgoing",
      strength: candidate.relation.strength,
      status: "active",
      reason: "같은 청구항 agent 묶음"
    }]);

    indexObsidian(brainRoot, { root: obsidianRoot, scope: "patent", prune: true });
    seedGraphFromSources(brainRoot, { scopeId: "patent" });
    const relationEdge = readEdges(brainRoot).find(edge =>
      edge.relation === "similar_to" &&
      edge.metadata.source === "obsidian_frontmatter"
    );

    assert.ok(relationEdge);
    assert.equal(relationEdge.weight, candidate.relation.strength);
  });

  it("승인 적용된 relation은 직접 매칭되지 않는 대상 노드를 1-hop으로 활성화한다", () => {
    generateRelationCandidates(brainRoot, { scope: "patent", minScore: 0.35, limit: 10 });
    const candidate = findDesignerToSpecWriterCandidate();
    assert.ok(candidate);

    reviewRelationCandidate(brainRoot, {
      candidateId: candidate.candidateId,
      decision: "approved",
      reason: "청구항 설계 후 명세서 작성으로 이어지는 workflow",
      reviewer: "Codex"
    });
    applyApprovedRelationCandidate(brainRoot, {
      candidateId: candidate.candidateId,
      backupDir: path.join(obsidianRoot, ".relation-backup"),
      appliedBy: "Codex"
    });

    indexObsidian(brainRoot, { root: obsidianRoot, scope: "patent", prune: true });
    seedGraphFromSources(brainRoot, { scopeId: "patent" });
    const brief = buildMemoryGraphBrief(brainRoot, {
      scopeId: "patent",
      goal: "claim designer workflow",
      topK: 8
    });

    assert.ok(brief.activatedNodes.some(node => node.title === "Claim-Designer"));
    assert.ok(brief.activatedNodes.some(node => node.title === "Spec-Writer"));
    assert.ok(brief.activatedEdges.some(edge => edge.relation === "similar_to"));
  });

  it("dismissed 후보는 적용을 거부한다", () => {
    generateRelationCandidates(brainRoot, { scope: "patent", minScore: 0.35, limit: 10 });
    const candidate = findDesignerToReviewerCandidate();
    reviewRelationCandidate(brainRoot, {
      candidateId: candidate.candidateId,
      decision: "dismissed",
      reason: "운영 관계로 보기 어려움",
      reviewer: "Codex"
    });

    assert.throws(() => applyApprovedRelationCandidate(brainRoot, {
      candidateId: candidate.candidateId,
      appliedBy: "Codex"
    }), /approved relation candidate/);
  });
});
