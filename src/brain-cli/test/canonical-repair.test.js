"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { applyRepair, planRepair } = require("../scripts/repair-canonical-index-from-db");
const { readJsonl, calculateHash } = require("../src/utils");

const tempRoots = [];

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brain-canonical-repair-"));
  tempRoots.push(root);
  const indexDir = path.join(root, "90_index");
  const sourceRef = "10_projects/brain/20260721-recover-me.md";
  const sourcePath = path.join(root, sourceRef);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(path.join(root, "99_policy"), { recursive: true });
  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(sourcePath, "# 복구 대상\n원문이 남아 있다.\n", "utf-8");
  fs.writeFileSync(path.join(root, "99_policy", "brainPolicy.md"), "# policy\n", "utf-8");
  fs.writeFileSync(path.join(indexDir, "records.jsonl"), "", "utf-8");
  fs.writeFileSync(path.join(indexDir, "records_digest.txt"), "# digest\n", "utf-8");
  fs.writeFileSync(path.join(indexDir, "tags.json"), JSON.stringify({ axes: ["domain", "intent"] }), "utf-8");
  fs.writeFileSync(path.join(indexDir, "folderRegistry.json"), "{}", "utf-8");
  fs.writeFileSync(path.join(indexDir, "manifest.json"), JSON.stringify({ files: [] }), "utf-8");

  const db = new Database(path.join(indexDir, "records.db"));
  db.exec(`CREATE TABLE records (
    record_id TEXT PRIMARY KEY, scope_type TEXT, scope_id TEXT, type TEXT,
    title TEXT, summary TEXT, tags TEXT, source_ref TEXT, source_type TEXT,
    status TEXT, replaced_by TEXT, deprecation_reason TEXT, updated_at TEXT,
    content_hash TEXT, original_chunk TEXT
  )`);
  db.prepare(`INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "rec_proj_brain_20260721_0099", "project", "brain", "log", "복구 대상",
    "Raw가 남은 DB-only 레코드", JSON.stringify(["domain/memory", "intent/retrieval"]),
    sourceRef, "candidate", "active", null, null, "2026-07-21T01:00:00.000Z",
    calculateHash(sourcePath), null
  );
  db.close();
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
});

describe("canonical index repair", () => {
  it("dry-run은 파일을 바꾸지 않고 복구 가능 건수를 센다", () => {
    const root = createFixture();
    const recordsPath = path.join(root, "90_index", "records.jsonl");
    const before = fs.readFileSync(recordsPath, "utf-8");
    const plan = planRepair(root);
    assert.equal(plan.recoverable, 1);
    assert.equal(fs.readFileSync(recordsPath, "utf-8"), before);
  });

  it("apply는 백업 후 같은 recordId를 JSONL/digest/manifest에 복구하고 멱등이다", () => {
    const root = createFixture();
    assert.throws(() => applyRepair(root), /--record-id/);
    const result = applyRepair(root, { recordIds: ["rec_proj_brain_20260721_0099"] });
    assert.equal(result.recovered, 1);
    assert.ok(result.backupDir && fs.existsSync(result.backupDir));
    for (const name of ["records.jsonl", "records_digest.txt", "manifest.json"]) {
      assert.ok(fs.existsSync(path.join(result.backupDir, name)));
    }
    const records = readJsonl(path.join(root, "90_index", "records.jsonl"));
    assert.equal(records[0].recordId, "rec_proj_brain_20260721_0099");
    assert.match(fs.readFileSync(path.join(root, "90_index", "records_digest.txt"), "utf-8"), /rec_proj_brain_20260721_0099/);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "90_index", "manifest.json"), "utf-8"));
    assert.equal(manifest.files[0].path, "10_projects/brain/20260721-recover-me.md");
    assert.equal(applyRepair(root, { recordIds: ["rec_proj_brain_20260721_0099"] }).recovered, 0);
  });

  it("recordId allowlist 밖의 DB-only 레코드는 적용 후보에서 제외한다", () => {
    const root = createFixture();
    const plan = planRepair(root, { recordIds: ["rec_proj_brain_20260721_missing"] });
    assert.equal(plan.recoverable, 0);
    assert.deepEqual(plan.requestedRecordIds, ["rec_proj_brain_20260721_missing"]);
  });
});
