"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { findSourceRefIssues, repairSourceRefs } = require("../src/source-ref-repair");
const { readJsonl, writeJsonl } = require("../src/utils");
const { validate } = require("../src/validate");

let brainRoot;

function setupBrain() {
  brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-source-ref-repair-"));
  for (const dir of ["10_projects/test", "30_topics/ok", "90_index", "99_policy"]) {
    fs.mkdirSync(path.join(brainRoot, dir), { recursive: true });
  }

  fs.writeFileSync(path.join(brainRoot, "99_policy", "brainPolicy.md"), "# policy\n", "utf-8");
  fs.writeFileSync(path.join(brainRoot, "90_index", "tags.json"), JSON.stringify({
    version: "1.0",
    axes: ["domain", "intent"],
    domain: { values: [], synonyms: {}, banned: [] },
    intent: { values: [], synonyms: {}, banned: [] }
  }), "utf-8");
  fs.writeFileSync(path.join(brainRoot, "90_index", "folderRegistry.json"), JSON.stringify({ version: "1.0", folders: [] }), "utf-8");

  fs.writeFileSync(path.join(brainRoot, "30_topics/ok/keep.md"), "# keep\n", "utf-8");
  writeJsonl(path.join(brainRoot, "90_index", "records.jsonl"), [
    {
      recordId: "rec_proj_test_20260615_0001",
      scopeType: "project",
      scopeId: "test",
      type: "note",
      title: "누락 기록",
      summary: "원문 파일이 사라진 active record",
      tags: ["domain/memory"],
      sourceType: "candidate",
      sourceRef: "10_projects/test/missing.md",
      status: "active",
      replacedBy: null,
      deprecationReason: null,
      updatedAt: "2026-06-15T00:00:00.000Z",
      contentHash: "sha256:old"
    },
    {
      recordId: "rec_topic_ok_20260615_0001",
      scopeType: "topic",
      scopeId: "ok",
      type: "note",
      title: "정상 기록",
      summary: "원문 파일이 있는 record",
      tags: [],
      sourceType: "candidate",
      sourceRef: "30_topics/ok/keep.md",
      status: "active",
      replacedBy: null,
      deprecationReason: null,
      updatedAt: "2026-06-15T00:00:00.000Z",
      contentHash: "sha256:keep"
    }
  ]);
  fs.writeFileSync(path.join(brainRoot, "90_index", "manifest.json"), JSON.stringify({
    version: "1.0",
    updatedAt: "2026-06-15T00:00:00.000Z",
    summary: { totalFiles: 3, byCategory: { project: 1, topic: 2 } },
    files: [
      { path: "10_projects/test/missing.md", hash: "sha256:old", size: 1, updatedAt: "2026-06-15T00:00:00.000Z", category: "project" },
      { path: "30_topics/ok/keep.md", hash: "sha256:keep", size: 7, updatedAt: "2026-06-15T00:00:00.000Z", category: "topic" },
      { path: "30_topics/ok/orphan.md", hash: "sha256:orphan", size: 1, updatedAt: "2026-06-15T00:00:00.000Z", category: "topic" }
    ]
  }, null, 2), "utf-8");
  fs.writeFileSync(path.join(brainRoot, "90_index", "records_digest.txt"), "", "utf-8");
}

function teardownBrain() {
  if (brainRoot && fs.existsSync(brainRoot)) {
    fs.rmSync(brainRoot, { recursive: true, force: true });
  }
}

describe("sourceRef repair", () => {
  beforeEach(setupBrain);
  afterEach(teardownBrain);

  it("active record의 누락된 sourceRef 파일을 메타데이터 문서로 복구한다", () => {
    const before = findSourceRefIssues(brainRoot);
    assert.equal(before.missingRecordSourceRefs.length, 1);
    assert.equal(before.manifestOnlyMissingEntries.length, 1);

    const report = repairSourceRefs(brainRoot);
    assert.equal(report.restored.length, 1);
    assert.equal(report.removedManifestEntries.length, 1);

    const restoredPath = path.join(brainRoot, "10_projects/test/missing.md");
    assert.ok(fs.existsSync(restoredPath));
    const restoredContent = fs.readFileSync(restoredPath, "utf-8");
    assert.match(restoredContent, /Brain sourceRef 자동 복구 문서/);
    assert.match(restoredContent, /rec_proj_test_20260615_0001/);

    const records = readJsonl(path.join(brainRoot, "90_index", "records.jsonl"));
    const restoredRecord = records.find(record => record.recordId === "rec_proj_test_20260615_0001");
    assert.notEqual(restoredRecord.contentHash, "sha256:old");

    const manifest = JSON.parse(fs.readFileSync(path.join(brainRoot, "90_index", "manifest.json"), "utf-8"));
    assert.ok(manifest.files.some(entry => entry.path === "10_projects/test/missing.md"));
    assert.equal(manifest.files.some(entry => entry.path === "30_topics/ok/orphan.md"), false);

    const validation = validate(brainRoot);
    assert.equal(validation.warnings.some(w => w.includes("record sourceRef 파일 없음")), false);
    assert.equal(validation.warnings.some(w => w.includes("manifest 참조 파일 없음")), false);
  });

  it("dry-run은 파일과 인덱스를 변경하지 않는다", () => {
    const report = repairSourceRefs(brainRoot, { dryRun: true });
    assert.equal(report.restored.length, 1);
    assert.equal(report.removedManifestEntries.length, 1);
    assert.equal(fs.existsSync(path.join(brainRoot, "10_projects/test/missing.md")), false);

    const manifest = JSON.parse(fs.readFileSync(path.join(brainRoot, "90_index", "manifest.json"), "utf-8"));
    assert.ok(manifest.files.some(entry => entry.path === "30_topics/ok/orphan.md"));
  });
});
