"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { init } = require("../src/init");
const { getDb, upsertRecord } = require("../src/db");
const { calculateHash, generateDigestLine, writeJsonl } = require("../src/utils");
const { auditTargets, parseArgs, rollbackCreatedRaw } = require("../scripts/run-session-handoff-recovery-batch");

describe("session handoff recovery batch", () => {
  it("parses exactly one batch contract", () => {
    assert.deepEqual(parseArgs([
      "--root=C:\\Brain",
      "--transcripts=C:\\Sessions",
      "--manifest=C:\\plan.json",
      "--batch=B02",
      "--output-dir=C:\\reports"
    ]), {
      root: "C:\\Brain",
      transcripts: "C:\\Sessions",
      manifest: "C:\\plan.json",
      batchId: "B02",
      outputDir: "C:\\reports"
    });
  });

  it("audits five-way equality and only rolls back exact files", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brain-batch-audit-"));
    const root = init(parent).brainRoot;
    try {
      const sourceRef = "10_projects/clo-handoff/sessions/exact.md";
      const rawPath = path.join(root, sourceRef);
      fs.mkdirSync(path.dirname(rawPath), { recursive: true });
      fs.writeFileSync(rawPath, "# exact\n", "utf8");
      const contentHash = calculateHash(rawPath);
      const record = {
        recordId: "rec_proj_clo-handoff_20260816_9999",
        scopeType: "project", scopeId: "clo-handoff", type: "note",
        title: "exact", summary: "exact", tags: ["domain/memory"],
        sourceType: "candidate", sourceRef, status: "active",
        replacedBy: null, deprecationReason: null,
        updatedAt: "2026-08-16T00:00:00.000Z", contentHash
      };
      const db = getDb(root);
      try { upsertRecord(db, record); } finally { db.close(); }
      writeJsonl(path.join(root, "90_index", "records.jsonl"), [record]);
      fs.writeFileSync(path.join(root, "90_index", "records_digest.txt"), generateDigestLine(record) + "\n", "utf8");
      fs.writeFileSync(path.join(root, "90_index", "manifest.json"), JSON.stringify({ files: [{ path: sourceRef, hash: contentHash }] }), "utf8");

      const audit = auditTargets(root, [record.recordId]);
      assert.equal(audit.allExact, true);
      rollbackCreatedRaw(root, [{ recordId: record.recordId, sourceRef, contentHash }]);
      assert.equal(fs.existsSync(rawPath), false);

      fs.writeFileSync(rawPath, "tampered", "utf8");
      rollbackCreatedRaw(root, [{ recordId: record.recordId, sourceRef, contentHash }]);
      assert.equal(fs.existsSync(rawPath), true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
