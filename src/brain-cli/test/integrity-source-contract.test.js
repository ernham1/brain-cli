"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { init } = require("../src/init");
const { getDb, upsertRecord } = require("../src/db");
const { auditIntegrity } = require("../src/integrity-monitor");
const { calculateHashFromString, generateDigestLine, writeJsonl } = require("../src/utils");
const { validate } = require("../src/validate");

function makeRecord(recordId, sourceRef, contentHash) {
  return {
    recordId, scopeType: "project", scopeId: "source-contract", type: "log",
    title: recordId, summary: "source contract", tags: ["domain/memory"],
    sourceType: "candidate", sourceRef, status: "active", replacedBy: null,
    deprecationReason: null, updatedAt: "2026-07-22T00:00:00.000Z", contentHash,
  };
}

describe("integrity source contract", () => {
  it("명시된 mutable source만 manifest hash 비교에서 제외한다", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brain-source-contract-"));
    const brainRoot = init(parent).brainRoot;
    try {
      const mutableRef = "10_projects/demo/vscode-latest.md";
      const ordinaryRef = "10_projects/demo/ordinary.md";
      const content = "current raw";
      const contentHash = calculateHashFromString(content);
      const records = [
        makeRecord("rec_proj_source-contract_20260722_0001", mutableRef, contentHash),
        makeRecord("rec_proj_source-contract_20260722_0002", ordinaryRef, contentHash),
      ];
      for (const record of records) {
        const sourcePath = path.join(brainRoot, record.sourceRef);
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, content, "utf8");
      }
      writeJsonl(path.join(brainRoot, "90_index", "records.jsonl"), records);
      fs.writeFileSync(
        path.join(brainRoot, "90_index", "manifest.json"),
        JSON.stringify({ files: records.map(record => ({ path: record.sourceRef, hash: "sha256:stale" })) }),
        "utf8"
      );
      const db = getDb(brainRoot);
      try { for (const record of records) upsertRecord(db, record); } finally { db.close(); }

      const before = auditIntegrity(brainRoot);
      assert.equal(before.issues.some(item => item.key === `hash-contract:source:${mutableRef}`), true);
      assert.equal(before.issues.some(item => item.key === `hash-contract:source:${ordinaryRef}`), true);

      const contractDir = path.join(brainRoot, "90_index", "integrity-monitor");
      fs.mkdirSync(contractDir, { recursive: true });
      fs.writeFileSync(
        path.join(contractDir, "source-contract.json"),
        JSON.stringify({
          version: 1,
          manifestHashExclusions: [{
            sourceRef: mutableRef,
            kind: "mutable_operational",
            reason: "테스트 실시간 포인터",
          }],
        }),
        "utf8"
      );

      const after = auditIntegrity(brainRoot);
      assert.equal(after.issues.some(item => item.key === `hash-contract:source:${mutableRef}`), false);
      assert.equal(after.issues.some(item => item.key === `hash-contract:source:${ordinaryRef}`), true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("sourceRefPrefix로 선언한 Wiki 파생물은 monitor와 validate 해시 경고에서 제외한다", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brain-source-prefix-"));
    const brainRoot = init(parent).brainRoot;
    try {
      const sourceRef = "40_wiki/demo/wiki.md";
      const content = "# demo wiki\n\ncurrent state";
      const record = makeRecord("rec_proj_source-contract_20260722_0003", sourceRef, calculateHashFromString(content));
      const sourcePath = path.join(brainRoot, sourceRef);
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, content, "utf8");
      writeJsonl(path.join(brainRoot, "90_index", "records.jsonl"), [record]);
      fs.writeFileSync(
        path.join(brainRoot, "90_index", "records_digest.txt"),
        `${generateDigestLine(record)}\n`,
        "utf8"
      );
      fs.writeFileSync(
        path.join(brainRoot, "90_index", "manifest.json"),
        JSON.stringify({ files: [{ path: sourceRef, hash: "sha256:stale" }] }),
        "utf8"
      );
      const db = getDb(brainRoot);
      try { upsertRecord(db, record); } finally { db.close(); }

      const contractDir = path.join(brainRoot, "90_index", "integrity-monitor");
      fs.mkdirSync(contractDir, { recursive: true });
      fs.writeFileSync(
        path.join(contractDir, "source-contract.json"),
        JSON.stringify({
          version: 1,
          manifestHashExclusions: [{
            sourceRefPrefix: "40_wiki/",
            sourceRefSuffix: "/wiki.md",
            kind: "mutable_derived",
            reason: "Wiki는 Raw에서 정제되는 최신 상태 문서",
          }],
        }),
        "utf8"
      );

      const audit = auditIntegrity(brainRoot);
      assert.equal(audit.issues.some(item => item.key === `hash-contract:source:${sourceRef}`), false);
      const validation = validate(brainRoot);
      assert.equal(validation.warnings.some(item => item.includes(`해시 불일치 (수동 변경?): ${sourceRef}`)), false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
