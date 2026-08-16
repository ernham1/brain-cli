"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { search } = require("../src/search");

const tempRoots = [];

function createBrain(records) {
  const brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-search-integrity-"));
  tempRoots.push(brainRoot);
  const indexDir = path.join(brainRoot, "90_index");
  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(path.join(indexDir, "records.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + "\n", "utf-8");
  const digest = records.map(record => [record.recordId, record.title, record.summary, record.tags.join(","), record.status, record.type, record.sourceType, record.updatedAt].join(" | "));
  fs.writeFileSync(path.join(indexDir, "records_digest.txt"), digest.join("\n") + "\n", "utf-8");
  fs.writeFileSync(path.join(indexDir, "links.jsonl"), "", "utf-8");
  fs.writeFileSync(path.join(indexDir, "tags.json"), JSON.stringify({ axes: ["domain", "intent"] }), "utf-8");
  return brainRoot;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sampleRecord() {
  return {
    recordId: "rec_proj_aios_20260720_0010",
    scopeType: "project",
    scopeId: "aios",
    type: "log",
    title: "AIOS 기억 저장 확인",
    summary: "정확 recordId 조회용 레코드",
    tags: ["domain/memory", "intent/retrieval"],
    sourceType: "candidate",
    sourceRef: "10_projects/aios/20260720-memory.md",
    status: "active",
    replacedBy: null,
    deprecationReason: null,
    updatedAt: "2026-07-20T00:10:00.000Z",
    contentHash: "sha256:test",
  };
}

afterEach(() => {
  while (tempRoots.length > 0) fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
});

describe("search는 정본 원장을 변경하지 않는다", () => {
  it("일반 검색 전후 records.jsonl 해시와 행 수가 같다", () => {
    const brainRoot = createBrain([sampleRecord()]);
    const recordsPath = path.join(brainRoot, "90_index", "records.jsonl");
    const beforeHash = sha256(recordsPath);
    const beforeLines = fs.readFileSync(recordsPath, "utf-8").trim().split(/\r?\n/).length;
    const result = search(brainRoot, { currentGoal: "AIOS 기억", topK: 5 });
    assert.ok(result.candidates.length > 0);
    assert.equal(sha256(recordsPath), beforeHash);
    assert.equal(fs.readFileSync(recordsPath, "utf-8").trim().split(/\r?\n/).length, beforeLines);
  });
});

describe("정확 recordId 조회", () => {
  it("완전 일치 레코드를 첫 결과로 반환한다", () => {
    const record = sampleRecord();
    const brainRoot = createBrain([record]);
    const result = search(brainRoot, { currentGoal: record.recordId, topK: 5 });
    assert.equal(result.candidates[0]?.recordId, record.recordId);
  });
});
