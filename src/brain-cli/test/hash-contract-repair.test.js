"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { init } = require("../src/init");
const { getDb, upsertRecord } = require("../src/db");
const { calculateHashFromString, generateDigestLine, readJsonl, writeJsonl } = require("../src/utils");
const { auditIntegrity } = require("../src/integrity-monitor");
const { applyExactJsonlHashRepair, planExactJsonlHashRepair } = require("../scripts/repair-hash-contract-index");

function record(recordId, sourceRef, contentHash) {
  return {
    recordId, scopeType: "project", scopeId: "hash-repair", type: "log",
    title: recordId, summary: "hash repair", tags: ["domain/memory"],
    sourceType: "candidate", sourceRef, status: "active", replacedBy: null,
    deprecationReason: null, updatedAt: "2026-07-22T00:00:00.000Z", contentHash,
  };
}

describe("exact JSONL hash-contract repair", () => {
  it("Raw=DB=manifest인 record만 contentHash 한 필드로 정정하고 백업한다", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brain-hash-repair-"));
    const brainRoot = init(parent).brainRoot;
    try {
      const sourceRef = "10_projects/hash-repair/exact.md";
      const content = "exact canonical content";
      const canonicalHash = calculateHashFromString(content);
      const dbRecord = record("rec_proj_hash-repair_20260722_0001", sourceRef, canonicalHash);
      const jsonRecord = { ...dbRecord, contentHash: calculateHashFromString("stale") };
      const sourcePath = path.join(brainRoot, sourceRef);
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, content, "utf8");
      writeJsonl(path.join(brainRoot, "90_index", "records.jsonl"), [jsonRecord]);
      fs.writeFileSync(
        path.join(brainRoot, "90_index", "records_digest.txt"),
        generateDigestLine(jsonRecord) + "\n",
        "utf8"
      );
      fs.writeFileSync(
        path.join(brainRoot, "90_index", "manifest.json"),
        JSON.stringify({ version: "1.0", files: [{ path: sourceRef, hash: canonicalHash }] }, null, 2),
        "utf8"
      );
      const db = getDb(brainRoot);
      try { upsertRecord(db, dbRecord); } finally { db.close(); }

      const before = readJsonl(path.join(brainRoot, "90_index", "records.jsonl"))[0];
      const plan = planExactJsonlHashRepair(brainRoot);
      assert.equal(plan.eligible.length, 1);
      assert.equal(plan.blocked.length, 0);

      const result = applyExactJsonlHashRepair(brainRoot);
      assert.equal(result.changed, 1);
      assert.equal(fs.existsSync(path.join(result.backupDir, "records.jsonl")), true);
      assert.equal(fs.existsSync(path.join(result.backupDir, "records.db")), true);

      const after = readJsonl(path.join(brainRoot, "90_index", "records.jsonl"))[0];
      assert.deepEqual({ ...after, contentHash: before.contentHash }, before);
      assert.equal(after.contentHash, canonicalHash);
      assert.equal(auditIntegrity(brainRoot).issues.some(item => item.key === `hash-contract:${after.recordId}`), false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
