"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  applyFrontmatter,
  planFrontmatter,
  previewFrontmatter,
  splitFrontmatter
} = require("../src/obsidian-frontmatter");
const { indexObsidian } = require("../src/obsidian-connector");

let obsidianRoot;

function setupRoot() {
  obsidianRoot = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-frontmatter-"));
  fs.mkdirSync(path.join(obsidianRoot, "시스템설계"), { recursive: true });
  fs.writeFileSync(path.join(obsidianRoot, "시스템설계", "Brain-Memory-Kernel.md"), [
    "# Brain Memory Kernel",
    "",
    "Memory Graph 설계 문서."
  ].join("\n"), "utf-8");
  fs.writeFileSync(path.join(obsidianRoot, "AgentForge.md"), [
    "---",
    "doc_type: planning",
    "scope_id: agentforge",
    "canonical_id: agentforge.plan",
    "memory:",
    "  node_type: workflow",
    "  relations:",
    "    - target: agentforge.review",
    "      type: verifies",
    "      strength: 0.7",
    "---",
    "# AgentForge",
    "밴딩AI 계획."
  ].join("\n"), "utf-8");
}

describe("Obsidian frontmatter automation", () => {
  beforeEach(setupRoot);
  afterEach(() => {
    fs.rmSync(obsidianRoot, { recursive: true, force: true });
  });

  it("dry-run은 변경 대상과 preview를 반환한다", () => {
    const result = applyFrontmatter(obsidianRoot, { dryRun: true });

    assert.equal(result.mode, "dry_run");
    assert.equal(result.total, 2);
    assert.equal(result.changeCount, 2);
    assert.ok(result.previews[0].frontmatter.canonical_id);
    assert.ok(result.previews.some(item => item.frontmatter.scope_id === "brain"));
  });

  it("apply는 backup을 만들고 기존 frontmatter 값을 보존한다", () => {
    const result = applyFrontmatter(obsidianRoot, {
      backupDir: path.join(obsidianRoot, "backup")
    });
    const agentForgePath = path.join(obsidianRoot, "AgentForge.md");
    const content = fs.readFileSync(agentForgePath, "utf-8");
    const parsed = splitFrontmatter(content).data;

    assert.equal(result.mode, "apply");
    assert.equal(result.appliedCount, 2);
    assert.equal(parsed.doc_type, "planning");
    assert.equal(parsed.scope_id, "agentforge");
    assert.ok(parsed.canonical_id);
    assert.ok(fs.existsSync(path.join(obsidianRoot, "backup", "AgentForge.md")));
  });

  it("source registry는 frontmatter 확장 필드를 반영한다", () => {
    applyFrontmatter(obsidianRoot, {});
    const brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-frontmatter-index-"));

    try {
      const indexed = indexObsidian(brainRoot, { root: obsidianRoot, scope: "brain" });
      const source = indexed.sources.find(item => item.path.endsWith("Brain-Memory-Kernel.md"));

      assert.ok(source.canonicalId);
      assert.ok(source.memoryClasses.includes("architecture"));
      assert.ok(source.scopeHints.includes("brain"));
      assert.equal(source.defaultDepth, "D2");
      assert.equal(source.maxAutoDepth, "D4");
      assert.equal(source.requiresConfirmationForFact, true);
      assert.equal(source.needsReview, false);

      const agentForgeSource = indexed.sources.find(item => item.path.endsWith("AgentForge.md"));
      assert.equal(agentForgeSource.memoryNodeType, "workflow");
      assert.deepEqual(agentForgeSource.relations, [{
        target: "agentforge.review",
        type: "verifies",
        direction: "outgoing",
        strength: 0.7,
        status: "active",
        reason: null
      }]);
    } finally {
      fs.rmSync(brainRoot, { recursive: true, force: true });
    }
  });

  it("source registry는 숨김 backup 폴더를 색인하지 않고 prune할 수 있다", () => {
    applyFrontmatter(obsidianRoot, {});
    const hiddenDir = path.join(obsidianRoot, ".brain-frontmatter-backup");
    fs.mkdirSync(hiddenDir, { recursive: true });
    fs.writeFileSync(path.join(hiddenDir, "backup.md"), "# backup\n", "utf-8");
    const brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-frontmatter-prune-"));

    try {
      const first = indexObsidian(brainRoot, { root: obsidianRoot, scope: "brain" });
      const second = indexObsidian(brainRoot, { root: obsidianRoot, scope: "brain", prune: true });

      assert.equal(first.indexed, 2);
      assert.equal(second.total, 2);
      assert.equal(second.sources.some(source => source.path.includes(".brain-frontmatter-backup")), false);
    } finally {
      fs.rmSync(brainRoot, { recursive: true, force: true });
    }
  });

  it("planFrontmatter는 변경 본문을 반환하되 실제 파일은 바꾸지 않는다", () => {
    const filePath = path.join(obsidianRoot, "시스템설계", "Brain-Memory-Kernel.md");
    const before = fs.readFileSync(filePath, "utf-8");
    const plan = planFrontmatter(obsidianRoot);
    const preview = previewFrontmatter(filePath);
    const after = fs.readFileSync(filePath, "utf-8");

    assert.equal(plan.changeCount, 2);
    assert.equal(preview.changed, true);
    assert.equal(before, after);
  });
});
