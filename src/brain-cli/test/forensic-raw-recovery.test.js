"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { init } = require("../src/init");
const { getDb, upsertRecord } = require("../src/db");
const { planRecovery, applyRawRecovery, writeQuarantineCatalog, hashBuffer } = require("../scripts/forensic-raw-recovery");

function record(recordId, sourceRef, contentHash, originalChunk = null) {
  return {
    recordId, scopeType: "project", scopeId: "forensic-test", type: "log",
    title: recordId, summary: "test", tags: ["domain/memory"], sourceType: "candidate",
    sourceRef, status: "active", replacedBy: null, deprecationReason: null,
    updatedAt: new Date().toISOString(), contentHash, originalChunk,
  };
}

describe("forensic Raw recovery", () => {
  it("정확 해시 근거만 A/B로 분류하고 dry-run 뒤 선택 복구해야 한다", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brain-forensic-test-"));
    const root = init(parent).brainRoot;
    const peerRoot = path.join(parent, "PeerBrain");
    fs.mkdirSync(path.join(peerRoot, "10_projects", "forensic-test"), { recursive: true });

    try {
      const duplicateContent = "duplicate exact body";
      const peerContent = "peer exact body";
      const originalContent = "original chunk exact body";
      const duplicateHash = hashBuffer(Buffer.from(duplicateContent));
      const peerHash = hashBuffer(Buffer.from(peerContent));
      const originalHash = hashBuffer(Buffer.from(originalContent));

      const donorRef = "10_projects/forensic-test/donor.md";
      fs.mkdirSync(path.dirname(path.join(root, donorRef)), { recursive: true });
      fs.writeFileSync(path.join(root, donorRef), duplicateContent, "utf8");
      const peerRef = "10_projects/forensic-test/from-peer.md";
      fs.writeFileSync(path.join(peerRoot, peerRef), peerContent, "utf8");

      const db = getDb(root);
      try {
        upsertRecord(db, record("rec_proj_forensic-test_20260721_0001", donorRef, duplicateHash));
        upsertRecord(db, record("rec_proj_forensic-test_20260721_0002", "10_projects/forensic-test/from-duplicate.md", duplicateHash));
        upsertRecord(db, record("rec_proj_forensic-test_20260721_0003", peerRef, peerHash));
        upsertRecord(db, record("rec_proj_forensic-test_20260721_0004", "10_projects/forensic-test/from-original.md", originalHash, originalContent));
        upsertRecord(db, record("rec_proj_forensic-test_20260721_0005", "10_projects/forensic-test/no-evidence.md", hashBuffer(Buffer.from("missing"))));
      } finally {
        db.close();
      }

      const plan = await planRecovery(root, { peerRoots: [peerRoot] });
      assert.equal(plan.totals.dbOnlyRecords, 5);
      assert.equal(plan.totals.dbOnlyWithRaw, 1);
      assert.equal(plan.totals.dbOnlyRawMissing, 4);
      assert.deepEqual(plan.byClass, { B: 1, A: 2, D: 1 });
      assert.equal(fs.existsSync(path.join(root, "10_projects/forensic-test/from-peer.md")), false);

      const applied = await applyRawRecovery(root, { peerRoots: [peerRoot], limit: 3 });
      assert.equal(applied.created.length, 3);
      for (const item of applied.created) {
        assert.equal(fs.existsSync(path.join(root, item.sourceRef)), true);
      }
      assert.equal(fs.existsSync(path.join(root, "10_projects/forensic-test/no-evidence.md")), false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
  it("외부 evidence root는 basename 후보 중 SHA-256 exact 파일만 B등급으로 인정한다", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brain-evidence-root-test-"));
    const root = init(parent).brainRoot;
    const evidenceRoot = path.join(parent, "Evidence");
    fs.mkdirSync(path.join(evidenceRoot, "deep", "backup"), { recursive: true });
    fs.mkdirSync(path.join(evidenceRoot, "wrong"), { recursive: true });
    fs.mkdirSync(path.join(evidenceRoot, "node_modules", "ignored"), { recursive: true });

    try {
      const exactContent = "external exact body";
      const ignoredContent = "ignored exact body";
      const mismatchExpected = "expected but unavailable";
      fs.writeFileSync(path.join(evidenceRoot, "deep", "backup", "external-exact.md"), exactContent, "utf8");
      fs.writeFileSync(path.join(evidenceRoot, "wrong", "external-exact.md"), "wrong body", "utf8");
      fs.writeFileSync(path.join(evidenceRoot, "wrong", "mismatch-only.md"), "another wrong body", "utf8");
      fs.writeFileSync(path.join(evidenceRoot, "node_modules", "ignored", "ignored.md"), ignoredContent, "utf8");

      const db = getDb(root);
      try {
        upsertRecord(db, record(
          "rec_proj_forensic-test_20260721_0101",
          "10_projects/forensic-test/external-exact.md",
          hashBuffer(Buffer.from(exactContent))
        ));
        upsertRecord(db, record(
          "rec_proj_forensic-test_20260721_0102",
          "10_projects/forensic-test/ignored.md",
          hashBuffer(Buffer.from(ignoredContent))
        ));
        upsertRecord(db, record(
          "rec_proj_forensic-test_20260721_0103",
          "10_projects/forensic-test/mismatch-only.md",
          hashBuffer(Buffer.from(mismatchExpected))
        ));
      } finally {
        db.close();
      }

      const plan = await planRecovery(root, { evidenceRoots: [evidenceRoot] });
      assert.deepEqual(plan.byClass, { B: 1, D: 2 });
      assert.equal(plan.evidenceScan.exactEvidenceFiles, 1);
      assert.equal(plan.evidenceScan.skippedDirectories, 1);
      const match = plan.candidates.find(item => item.recordId.endsWith("0101"));
      assert.equal(match.evidence.type, "external-file-exact");
      assert.equal(match.evidence.root, path.resolve(evidenceRoot));

      const applied = await applyRawRecovery(root, { evidenceRoots: [evidenceRoot] });
      assert.equal(applied.created.length, 1);
      assert.equal(fs.readFileSync(path.join(root, match.sourceRef), "utf8"), exactContent);
      assert.equal(fs.existsSync(path.join(root, "10_projects/forensic-test/ignored.md")), false);
      assert.equal(fs.existsSync(path.join(root, "10_projects/forensic-test/mismatch-only.md")), false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
  it("quarantine catalog는 C/D 메타데이터만 보존하고 본문을 기록하지 않는다", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brain-quarantine-test-"));
    const outputPath = path.join(parent, "quarantine.jsonl");
    try {
      const plan = {
        generatedAt: "2026-07-21T00:00:00.000Z",
        brainRoot: path.join(parent, "Brain"),
        evidenceRoots: [path.join(parent, "Evidence")],
        candidates: [
          { recordId: "rec_d", sourceRef: "10_projects/x/d.md", contentHash: "sha256:d", classification: "D", evidence: null, content: "금지 본문" },
          { recordId: "rec_c", sourceRef: "10_projects/x/c.md", contentHash: "sha256:c", classification: "C", evidence: { type: "mismatch", path: "x" }, originalChunk: "금지 원문" },
          { recordId: "rec_a", sourceRef: "10_projects/x/a.md", contentHash: "sha256:a", classification: "A", evidence: { type: "exact" } },
        ],
      };

      const first = writeQuarantineCatalog(plan, outputPath);
      const second = writeQuarantineCatalog(plan, outputPath);
      const rows = fs.readFileSync(outputPath, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(first.records, 2);
      assert.equal(second.records, 2);
      assert.deepEqual(rows.map(row => row.recordId), ["rec_c", "rec_d"]);
      for (const row of rows) {
        assert.equal(row.status, "quarantined");
        assert.equal(Object.hasOwn(row, "content"), false);
        assert.equal(Object.hasOwn(row, "body"), false);
        assert.equal(Object.hasOwn(row, "originalChunk"), false);
        assert.deepEqual(row.checkedEvidenceRoots, plan.evidenceRoots);
      }
      assert.equal(Boolean(second.backupPath), true);
      assert.equal(fs.existsSync(second.backupPath), true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
