"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { init } = require("../src/init");
const { getDb, insertRecord } = require("../src/db");
const { calculateHash, writeJsonl } = require("../src/utils");
const { planRepair, applyRepair } = require("../scripts/repair-jsonl-missing-db");

function recordFor(recordId, sourceRef, contentHash) {
  return { recordId, scopeType: "project", scopeId: "demo", type: "note", title: "복구 대상", summary: "JSONL only", tags: ["domain/memory"], sourceType: "candidate", sourceRef, status: "active", replacedBy: null, deprecationReason: null, updatedAt: "2026-08-16T00:00:00.000Z", contentHash };
}

describe("targeted JSONL missing DB repair", () => {
  it("inserts exactly one hash-verified record and is idempotent", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brain-jsonl-db-repair-"));
    const root = init(parent).brainRoot;
    try {
      const sourceRef = "10_projects/demo/exact.md";
      const rawPath = path.join(root, sourceRef);
      fs.mkdirSync(path.dirname(rawPath), { recursive: true });
      fs.writeFileSync(rawPath, "# exact\n", "utf8");
      const target = recordFor("rec_proj_demo_20260816_0002", sourceRef, calculateHash(rawPath));
      writeJsonl(path.join(root, "90_index", "records.jsonl"), [target]);

      const db = getDb(root);
      try {
        insertRecord(db, recordFor("rec_proj_demo_20260816_0001", "10_projects/demo/existing.md", "sha256:existing"));
      } finally { db.close(); }

      const plan = planRepair(root, { recordId: target.recordId });
      assert.equal(plan.candidates.length, 1);
      assert.equal(plan.candidates[0].contentHash, target.contentHash);

      const applied = applyRepair(root, { recordId: target.recordId });
      assert.equal(applied.applied, true);
      assert.equal(applied.inserted, 1);
      assert.ok(applied.backupFiles.includes("records.db"));

      const check = getDb(root);
      try {
        assert.equal(check.prepare("SELECT COUNT(*) AS count FROM records").get().count, 2);
        assert.equal(check.prepare("SELECT COUNT(*) AS count FROM records_fts WHERE record_id = ?").get(target.recordId).count, 1);
        assert.equal(check.prepare("SELECT content_hash FROM records WHERE record_id = ?").get(target.recordId).content_hash, target.contentHash);
      } finally { check.close(); }

      const repeated = applyRepair(root, { recordId: target.recordId });
      assert.equal(repeated.applied, false);
      assert.equal(repeated.inserted, 0);
      assert.equal(repeated.plan.skipped[0].reason, "already-in-db");
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  });

  it("refuses a Raw file whose hash differs from JSONL", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brain-jsonl-db-repair-hash-"));
    const root = init(parent).brainRoot;
    try {
      const sourceRef = "10_projects/demo/tampered.md";
      const rawPath = path.join(root, sourceRef);
      fs.mkdirSync(path.dirname(rawPath), { recursive: true });
      fs.writeFileSync(rawPath, "tampered", "utf8");
      const target = recordFor("rec_proj_demo_20260816_0003", sourceRef, "sha256:wrong");
      writeJsonl(path.join(root, "90_index", "records.jsonl"), [target]);
      const emptyDb = getDb(root);
      emptyDb.close();
      const plan = planRepair(root, { recordId: target.recordId });
      assert.equal(plan.candidates.length, 0);
      assert.equal(plan.skipped[0].reason, "content-hash-mismatch");
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  });

  it("requires an explicit record id for apply", () => {
    assert.throws(() => applyRepair("C:\\not-used"), /--record/);
  });
});
