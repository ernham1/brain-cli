"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { BWTEngine } = require("../src/bwt");
const dbModule = require("../src/db");
const { init } = require("../src/init");
const { generateRecordId, readJsonl } = require("../src/utils");

function createTestBrain() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brain-sequence-test-"));
  return { parent, brainRoot: init(parent).brainRoot };
}

function seedRecord(recordId, overrides = {}) {
  return {
    recordId,
    scopeType: "topic",
    scopeId: "sequence-test",
    type: "note",
    title: "기존 인덱스",
    summary: "보존되어야 하는 레코드",
    tags: [],
    sourceRef: "30_topics/sequence-test/original.md",
    sourceType: "candidate",
    status: "active",
    updatedAt: new Date().toISOString(),
    contentHash: "sha256:seed",
    ...overrides,
  };
}

function createIntent(sourceRef = "30_topics/sequence-test/new.md") {
  return {
    action: "create",
    sourceRef,
    content: "신규 레코드",
    record: {
      scopeType: "topic",
      scopeId: "sequence-test",
      type: "note",
      title: "신규 인덱스",
      summary: "DB 기준 발번 테스트",
      tags: [],
      sourceType: "candidate",
    },
  };
}

describe("recordId DB sequencer", () => {
  it("records.jsonl이 비어도 records.db 최대 순번 다음 ID를 발급한다", () => {
    const { parent, brainRoot } = createTestBrain();
    try {
      const firstId = generateRecordId("topic", "sequence-test", []);
      const existingId = `${firstId.slice(0, -4)}0007`;
      let db = dbModule.getDb(brainRoot);
      dbModule.upsertRecord(db, seedRecord(existingId, { status: "deprecated" }));
      db.close();

      fs.writeFileSync(path.join(brainRoot, "90_index", "records.jsonl"), "", "utf-8");
      const result = new BWTEngine(brainRoot).execute(createIntent());

      assert.equal(result.success, true);
      assert.equal(result.recordId, `${firstId.slice(0, -4)}0008`);

      db = dbModule.getDb(brainRoot);
      const existing = db.prepare("SELECT title, source_ref FROM records WHERE record_id = ?").get(existingId);
      const created = db.prepare("SELECT title, source_ref FROM records WHERE record_id = ?").get(result.recordId);
      db.close();
      assert.deepEqual(existing, {
        title: "기존 인덱스",
        source_ref: "30_topics/sequence-test/original.md",
      });
      assert.deepEqual(created, {
        title: "신규 인덱스",
        source_ref: "30_topics/sequence-test/new.md",
      });
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("strict INSERT는 기존 recordId를 갱신하지 않고 오류를 낸다", () => {
    const { parent, brainRoot } = createTestBrain();
    try {
      const existingId = generateRecordId("topic", "sequence-test", []);
      const db = dbModule.getDb(brainRoot);
      dbModule.upsertRecord(db, seedRecord(existingId));

      assert.throws(
        () => dbModule.insertRecord(db, seedRecord(existingId, {
          title: "덮어쓰기 시도",
          sourceRef: "30_topics/sequence-test/overwrite.md",
        })),
        /recordId 충돌/
      );
      const row = db.prepare("SELECT title, source_ref FROM records WHERE record_id = ?").get(existingId);
      db.close();
      assert.deepEqual(row, {
        title: "기존 인덱스",
        source_ref: "30_topics/sequence-test/original.md",
      });
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
  it("strict INSERT 묶음은 한 건이라도 충돌하면 전체를 롤백한다", () => {
    const { parent, brainRoot } = createTestBrain();
    try {
      const existingId = generateRecordId("topic", "sequence-test", []);
      const newId = `${existingId.slice(0, -4)}0002`;
      const db = dbModule.getDb(brainRoot);
      dbModule.upsertRecord(db, seedRecord(existingId));

      assert.throws(
        () => dbModule.insertRecords(db, [
          seedRecord(newId, { title: "신규 묶음 레코드" }),
          seedRecord(existingId, { title: "충돌 묶음 레코드" }),
        ]),
        /recordId 충돌/
      );
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM records WHERE record_id = ?").get(newId).count, 0);
      assert.equal(db.prepare("SELECT title FROM records WHERE record_id = ?").get(existingId).title, "기존 인덱스");
      db.close();
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
  it("create 발급 ID가 DB에 이미 있으면 파일과 인덱스를 변경하지 않고 중단한다", () => {
    const { parent, brainRoot } = createTestBrain();
    const originalGetNextRecordId = dbModule.getNextRecordId;
    try {
      const existingId = generateRecordId("topic", "sequence-test", []);
      let db = dbModule.getDb(brainRoot);
      dbModule.upsertRecord(db, seedRecord(existingId));
      db.close();
      dbModule.getNextRecordId = () => existingId;

      const sourceRef = "30_topics/sequence-test/collision.md";
      const result = new BWTEngine(brainRoot).execute(createIntent(sourceRef));

      assert.equal(result.success, false);
      assert.equal(result.report.step, 1);
      assert.match(result.report.message, /recordId 충돌/);
      assert.equal(fs.existsSync(path.join(brainRoot, sourceRef)), false);
      assert.equal(readJsonl(path.join(brainRoot, "90_index", "records.jsonl")).length, 0);

      db = dbModule.getDb(brainRoot);
      const rows = db.prepare("SELECT record_id, title, source_ref FROM records").all();
      db.close();
      assert.deepEqual(rows, [{
        record_id: existingId,
        title: "기존 인덱스",
        source_ref: "30_topics/sequence-test/original.md",
      }]);
    } finally {
      dbModule.getNextRecordId = originalGetNextRecordId;
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});