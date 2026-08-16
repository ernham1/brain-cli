"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { validate } = require("../src/validate");
const { calculateHash } = require("../src/utils");

const roots = [];

function record(id, sourceRef) {
  return {
    recordId: id, scopeType: "project", scopeId: "brain", type: "log",
    title: id, summary: "정합성 테스트", tags: ["domain/memory", "intent/retrieval"],
    sourceType: "candidate", sourceRef, status: "active", replacedBy: null,
    deprecationReason: null, updatedAt: "2026-07-21T00:00:00.000Z", contentHash: "sha256:test",
  };
}

function insertDb(db, item, sourcePath) {
  db.prepare(`INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    item.recordId, item.scopeType, item.scopeId, item.type, item.title, item.summary,
    JSON.stringify(item.tags), item.sourceRef, item.sourceType, item.status, null, null,
    item.updatedAt, calculateHash(sourcePath), null
  );
}

function createFixture({ digest = true, extraDb = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brain-validate-store-"));
  roots.push(root);
  const indexDir = path.join(root, "90_index");
  fs.mkdirSync(indexDir, { recursive: true });
  fs.mkdirSync(path.join(root, "99_policy"), { recursive: true });
  fs.writeFileSync(path.join(root, "99_policy", "brainPolicy.md"), "# policy\n", "utf-8");
  fs.writeFileSync(path.join(indexDir, "tags.json"), JSON.stringify({ axes: ["domain", "intent"] }), "utf-8");
  fs.writeFileSync(path.join(indexDir, "folderRegistry.json"), "{}", "utf-8");
  fs.writeFileSync(path.join(indexDir, "manifest.json"), JSON.stringify({ files: [] }), "utf-8");

  const sourceRef = "10_projects/brain/one.md";
  const sourcePath = path.join(root, sourceRef);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "one", "utf-8");
  const first = record("rec_proj_brain_20260721_0001", sourceRef);
  fs.writeFileSync(path.join(indexDir, "records.jsonl"), JSON.stringify(first) + "\n", "utf-8");
  const digestLine = [first.recordId, first.title, first.summary, first.tags.join(","), first.status, first.type, first.sourceType, first.updatedAt].join(" | ");
  fs.writeFileSync(path.join(indexDir, "records_digest.txt"), digest ? digestLine + "\n" : "# empty\n", "utf-8");

  const db = new Database(path.join(indexDir, "records.db"));
  db.exec(`CREATE TABLE records (
    record_id TEXT PRIMARY KEY, scope_type TEXT, scope_id TEXT, type TEXT,
    title TEXT, summary TEXT, tags TEXT, source_ref TEXT, source_type TEXT,
    status TEXT, replaced_by TEXT, deprecation_reason TEXT, updated_at TEXT,
    content_hash TEXT, original_chunk TEXT
  )`);
  insertDb(db, first, sourcePath);
  if (extraDb) {
    const secondRef = "10_projects/brain/two.md";
    const secondPath = path.join(root, secondRef);
    fs.writeFileSync(secondPath, "two", "utf-8");
    insertDb(db, record("rec_proj_brain_20260721_0002", secondRef), secondPath);
  }
  db.close();
  return root;
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

describe("validate 교차 저장소 검사", () => {
  it("JSONL, digest, DB가 일치하면 통과한다", () => {
    const result = validate(createFixture());
    assert.equal(result.passed, true, result.errors.join("; "));
  });

  it("중복 recordId를 선형 검사로 탐지한다", () => {
    const root = createFixture();
    const recordsPath = path.join(root, "90_index", "records.jsonl");
    const first = fs.readFileSync(recordsPath, "utf-8").trim();
    fs.writeFileSync(recordsPath, `${first}\n${first}\n`, "utf-8");

    const result = validate(root);
    assert.equal(result.passed, false);
    assert.ok(result.errors.some(error => error.includes("recordId 중복")));
  });

  it("digest에서 JSONL ID가 빠지면 실패한다", () => {
    const result = validate(createFixture({ digest: false }));
    assert.equal(result.passed, false);
    assert.ok(result.errors.some(error => error.includes("digest 누락")));
  });

  it("Raw가 남은 DB 레코드가 JSONL에서 빠지면 실패한다", () => {
    const result = validate(createFixture({ extraDb: true }));
    assert.equal(result.passed, false);
    assert.ok(result.errors.some(error => error.includes("DB→JSONL 누락")));
  });
});
