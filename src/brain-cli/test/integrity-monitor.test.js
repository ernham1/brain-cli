"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { init } = require("../src/init");
const { getDb, upsertRecord } = require("../src/db");
const {
  auditIntegrity,
  createIntegrityBaseline,
  compareWithBaseline,
  writeIntegrityEvent,
  readLatestIntegrityEvent,
} = require("../src/integrity-monitor");

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function makeRecord(recordId, sourceRef, contentHash = "sha256:ok") {
  return {
    recordId, scopeType: "project", scopeId: "monitor-test", type: "log",
    title: recordId, summary: "monitor", tags: ["domain/memory"], sourceType: "candidate",
    sourceRef, status: "active", replacedBy: null, deprecationReason: null,
    updatedAt: "2026-07-21T00:00:00.000Z", contentHash, originalChunk: null,
  };
}

function writeJsonl(brainRoot, records) {
  fs.writeFileSync(
    path.join(brainRoot, "90_index", "records.jsonl"),
    records.map(record => JSON.stringify(record)).join("\n") + "\n",
    "utf8"
  );
}

function writeManifest(brainRoot, records) {
  const seen = new Set();
  const files = [];
  for (const record of records) {
    if (!record.sourceRef || seen.has(record.sourceRef)) continue;
    seen.add(record.sourceRef);
    const sourcePath = path.join(brainRoot, record.sourceRef);
    files.push({
      path: record.sourceRef,
      hash: fs.existsSync(sourcePath) ? `sha256:${hashFile(sourcePath)}` : record.contentHash,
    });
  }
  fs.writeFileSync(
    path.join(brainRoot, "90_index", "manifest.json"),
    JSON.stringify({ version: 1, files }, null, 2),
    "utf8"
  );
}

function insertDb(brainRoot, records) {
  const db = getDb(brainRoot);
  try { for (const record of records) upsertRecord(db, record); }
  finally { db.close(); }
}

describe("integrity monitor", () => {
  it("6종 정합성 문제를 읽기 전용으로 탐지한다", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brain-monitor-audit-"));
    const brainRoot = init(parent).brainRoot;
    try {
      const valid = makeRecord("rec_proj_monitor-test_20260721_0001", "10_projects/monitor-test/valid.md");
      const duplicate = makeRecord("rec_proj_monitor-test_20260721_0002", "10_projects/monitor-test/duplicate.md");
      const jsonOnly = makeRecord("rec_proj_monitor-test_20260721_0003", "10_projects/monitor-test/json-only.md");
      const dbOnly = makeRecord("rec_proj_monitor-test_20260721_0004", "10_projects/monitor-test/db-only.md");
      const missingRaw = makeRecord("rec_proj_monitor-test_20260721_0005", "10_projects/monitor-test/missing.md");
      const hashMismatchJson = makeRecord("rec_proj_monitor-test_20260721_0006", "10_projects/monitor-test/hash.md", "sha256:json");
      const hashMismatchDb = { ...hashMismatchJson, contentHash: "sha256:db" };
      const noSourceRef = makeRecord("rec_proj_monitor-test_20260721_0007", null, "sha256:legacy");
      const sharedOld = makeRecord("rec_proj_monitor-test_20260721_0008", "10_projects/monitor-test/shared.md", "sha256:old");
      const sharedCurrent = makeRecord("rec_proj_monitor-test_20260721_0009", "10_projects/monitor-test/shared.md", "sha256:current");
      const jsonRecords = [valid, duplicate, duplicate, jsonOnly, missingRaw, hashMismatchJson, noSourceRef, sharedOld, sharedCurrent];
      const dbRecords = [valid, duplicate, dbOnly, missingRaw, hashMismatchDb, noSourceRef, sharedOld, sharedCurrent];
      fs.mkdirSync(path.join(brainRoot, "10_projects", "monitor-test"), { recursive: true });
      for (const record of [valid, duplicate, dbOnly, hashMismatchJson, sharedOld, sharedCurrent]) {
        fs.writeFileSync(path.join(brainRoot, record.sourceRef), record.recordId, "utf8");
      }
      writeJsonl(brainRoot, jsonRecords);
      writeManifest(brainRoot, jsonRecords);
      insertDb(brainRoot, dbRecords);
      fs.writeFileSync(path.join(brainRoot, "90_index", "orphan.tmp"), "preserve", "utf8");

      const protectedPaths = [
        path.join(brainRoot, "90_index", "records.jsonl"),
        path.join(brainRoot, "90_index", "records.db"),
        path.join(brainRoot, "90_index", "manifest.json"),
        path.join(brainRoot, valid.sourceRef),
      ];
      const before = Object.fromEntries(protectedPaths.map(file => [file, hashFile(file)]));
      const audit = auditIntegrity(brainRoot);
      const after = Object.fromEntries(protectedPaths.map(file => [file, hashFile(file)]));

      assert.equal(audit.readOnly, true);
      assert.deepEqual(after, before);
      for (const type of ["duplicate-jsonl", "jsonl-missing-db", "db-missing-jsonl", "missing-raw", "hash-contract", "index-tmp"]) {
        assert.equal(audit.issues.some(issue => issue.type === type), true, `missing issue type: ${type}`);
      }
      assert.equal(fs.readFileSync(path.join(brainRoot, "90_index", "orphan.tmp"), "utf8"), "preserve");
      assert.equal(audit.issues.some(item => item.key === `hash-contract:${noSourceRef.recordId}`), false);
      assert.equal(audit.issues.some(item => item.key === `hash-contract:${sharedOld.recordId}`), false);
      assert.equal(audit.issues.some(item => item.key === `hash-contract:${sharedCurrent.recordId}`), false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("명시 baseline 뒤 같은 상태는 healthy이고 신규 issue만 alert한다", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brain-monitor-baseline-"));
    const brainRoot = init(parent).brainRoot;
    const baselinePath = path.join(brainRoot, "90_index", "integrity-monitor", "baseline.json");
    try {
      const valid = makeRecord("rec_proj_monitor-test_20260721_0101", "10_projects/monitor-test/valid.md");
      fs.mkdirSync(path.join(brainRoot, "10_projects", "monitor-test"), { recursive: true });
      fs.writeFileSync(path.join(brainRoot, valid.sourceRef), "valid", "utf8");
      writeJsonl(brainRoot, [valid]);
      writeManifest(brainRoot, [valid]);
      insertDb(brainRoot, [valid]);

      const created = createIntegrityBaseline(brainRoot, baselinePath);
      const baselineBytes = fs.readFileSync(baselinePath, "utf8");
      assert.equal(compareWithBaseline(auditIntegrity(brainRoot), created.baseline).status, "healthy");

      const jsonOnly = makeRecord("rec_proj_monitor-test_20260721_0102", "10_projects/monitor-test/new.json.md");
      writeJsonl(brainRoot, [valid, jsonOnly]);
      const result = compareWithBaseline(auditIntegrity(brainRoot), created.baseline);
      assert.equal(result.status, "alert");
      assert.deepEqual(result.newIssues.map(issue => issue.key), [`jsonl-missing-db:${jsonOnly.recordId}`]);
      assert.equal(fs.readFileSync(baselinePath, "utf8"), baselineBytes);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
  it("event는 고유 JSON 파일로 누적되고 latest를 읽는다", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brain-monitor-event-"));
    const brainRoot = init(parent).brainRoot;
    try {
      const result = {
        status: "healthy",
        generatedAt: "2026-07-21T00:00:00.000Z",
        knownIssues: [],
        newIssues: [],
        resolvedIssueKeys: [],
        audit: { brainRoot, totals: { issues: 0 }, byType: {} },
      };
      const first = writeIntegrityEvent(brainRoot, result);
      const second = writeIntegrityEvent(brainRoot, result);
      assert.notEqual(first.eventPath, second.eventPath);
      assert.equal(fs.existsSync(first.eventPath), true);
      assert.equal(fs.existsSync(second.eventPath), true);
      const latest = readLatestIntegrityEvent(brainRoot);
      assert.equal(latest.status, "healthy");
      assert.equal(latest.summary.newIssues, 0);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("CLI는 baseline missing=3, healthy=0, 신규 issue alert=2를 반환한다", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brain-monitor-cli-"));
    const brainRoot = init(parent).brainRoot;
    const cliPath = path.join(__dirname, "..", "src", "index.js");
    try {
      const valid = makeRecord("rec_proj_monitor-test_20260721_0201", "10_projects/monitor-test/valid.md");
      fs.mkdirSync(path.join(brainRoot, "10_projects", "monitor-test"), { recursive: true });
      fs.writeFileSync(path.join(brainRoot, valid.sourceRef), "valid", "utf8");
      writeJsonl(brainRoot, [valid]);
      writeManifest(brainRoot, [valid]);
      insertDb(brainRoot, [valid]);

      const missing = spawnSync(process.execPath, [cliPath, "integrity-monitor", "--root", brainRoot, "--json"], { encoding: "utf8" });
      assert.equal(missing.status, 3, missing.stderr || missing.stdout);

      const initialized = spawnSync(process.execPath, [cliPath, "integrity-monitor", "--root", brainRoot, "--init-baseline", "--record-event", "--json"], { encoding: "utf8" });
      assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);

      const jsonOnly = makeRecord("rec_proj_monitor-test_20260721_0202", "10_projects/monitor-test/new.md");
      writeJsonl(brainRoot, [valid, jsonOnly]);
      const alerted = spawnSync(process.execPath, [cliPath, "integrity-monitor", "--root", brainRoot, "--record-event", "--json"], { encoding: "utf8" });
      assert.equal(alerted.status, 2, alerted.stderr || alerted.stdout);
      const parsed = JSON.parse(alerted.stdout);
      assert.equal(parsed.status, "alert");
      assert.deepEqual(parsed.newIssues.map(item => item.key), [`jsonl-missing-db:${jsonOnly.recordId}`]);
      const eventDir = path.join(brainRoot, "90_index", "integrity-monitor", "events");
      assert.equal(fs.readdirSync(eventDir).filter(name => name.endsWith(".json")).length, 2);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});