"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  calculateHash,
  calculateHashFromString,
  generateRecordId,
  readJsonl,
  writeJsonl,
  safeReadJson,
  generateDigestLine,
  isoNow,
  ensureDir
} = require("../src/utils");

// 테스트용 임시 디렉토리
let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-cli-test-"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("calculateHash / calculateHashFromString", () => {
  it("파일 해시와 문자열 해시가 동일한 내용이면 같아야 한다", () => {
    const content = "Hello, Brain!";
    const filePath = path.join(tmpDir, "hash-test.txt");
    fs.writeFileSync(filePath, content, "utf-8");

    const fileHash = calculateHash(filePath);
    const strHash = calculateHashFromString(content);

    assert.equal(fileHash, strHash);
    assert.ok(fileHash.startsWith("sha256:"));
    assert.equal(fileHash.length, 7 + 64); // "sha256:" + 64 hex chars
  });

  it("빈 문자열도 유효한 해시를 반환해야 한다", () => {
    const hash = calculateHashFromString("");
    assert.ok(hash.startsWith("sha256:"));
  });
});

describe("generateRecordId", () => {
  it("create 시 올바른 형식의 recordId를 생성해야 한다", () => {
    const id = generateRecordId("project", "myApp", []);
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    assert.match(id, /^rec_proj_myApp_\d{8}_0001$/);
    assert.ok(id.includes(today));
  });

  it("기존 레코드가 있으면 시퀀스 번호가 증가해야 한다", () => {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const existing = [
      { recordId: `rec_proj_myApp_${today}_0001` },
      { recordId: `rec_proj_myApp_${today}_0003` }
    ];
    const id = generateRecordId("project", "myApp", existing);
    assert.ok(id.endsWith("_0004"));
  });

  it("scopeType 약어가 올바르게 적용되어야 한다", () => {
    assert.ok(generateRecordId("user", "test", []).startsWith("rec_user_"));
    assert.ok(generateRecordId("agent", "test", []).startsWith("rec_agent_"));
    assert.ok(generateRecordId("topic", "test", []).startsWith("rec_topic_"));
    assert.ok(generateRecordId("project", "test", []).startsWith("rec_proj_"));
  });
});

describe("readJsonl / writeJsonl", () => {
  it("빈 파일은 빈 배열을 반환해야 한다", () => {
    const filePath = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(filePath, "", "utf-8");
    assert.deepEqual(readJsonl(filePath), []);
  });

  it("존재하지 않는 파일은 빈 배열을 반환해야 한다", () => {
    assert.deepEqual(readJsonl(path.join(tmpDir, "nonexistent.jsonl")), []);
  });

  it("write 후 read하면 동일한 데이터를 반환해야 한다", () => {
    const filePath = path.join(tmpDir, "roundtrip.jsonl");
    const data = [
      { recordId: "rec_proj_a_20260101_0001", title: "Test 1" },
      { recordId: "rec_proj_a_20260101_0002", title: "Test 2" }
    ];
    writeJsonl(filePath, data);
    const read = readJsonl(filePath);
    assert.deepEqual(read, data);
  });
});

describe("safeReadJson", () => {
  it("유효한 JSON 파일을 읽을 수 있어야 한다", () => {
    const filePath = path.join(tmpDir, "valid.json");
    fs.writeFileSync(filePath, JSON.stringify({ key: "value" }), "utf-8");
    const result = safeReadJson(filePath);
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { key: "value" });
  });

  it("존재하지 않는 파일은 ok=false를 반환해야 한다", () => {
    const result = safeReadJson(path.join(tmpDir, "nope.json"));
    assert.equal(result.ok, false);
  });

  it("잘못된 JSON은 ok=false를 반환해야 한다", () => {
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, "not json!", "utf-8");
    const result = safeReadJson(filePath);
    assert.equal(result.ok, false);
  });
});

describe("generateDigestLine", () => {
  it("올바른 형식의 다이제스트 라인을 생성해야 한다", () => {
    const record = {
      recordId: "rec_proj_a_20260101_0001",
      title: "테스트 제목",
      summary: "테스트 요약",
      tags: ["domain/memory", "intent/retrieval"],
      status: "active"
    };
    const line = generateDigestLine(record);
    assert.equal(
      line,
      "rec_proj_a_20260101_0001 | 테스트 제목 | 테스트 요약 | domain/memory,intent/retrieval | active"
    );
  });

  it("태그가 비어있어도 올바르게 생성되어야 한다", () => {
    const record = {
      recordId: "rec_user_x_20260101_0001",
      title: "No tags",
      summary: "",
      tags: [],
      status: "deprecated"
    };
    const line = generateDigestLine(record);
    assert.ok(line.includes("| deprecated"));
    assert.ok(line.includes("|  |")); // empty tags
  });
});

describe("isoNow", () => {
  it("ISO 8601 형식을 반환해야 한다", () => {
    const now = isoNow();
    assert.match(now, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("ensureDir", () => {
  it("중첩된 디렉토리를 생성해야 한다", () => {
    const nested = path.join(tmpDir, "a", "b", "c");
    ensureDir(nested);
    assert.ok(fs.existsSync(nested));
  });

  it("이미 존재하는 디렉토리에서도 에러가 발생하지 않아야 한다", () => {
    ensureDir(tmpDir);
    assert.ok(fs.existsSync(tmpDir));
  });
});
