"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { init } = require("../src/init");
const { getDb, upsertRecord } = require("../src/db");
const {
  parseArchive,
  reconstructPlan,
  applyReconstruction,
  publicReport,
  hashText
} = require("../scripts/reconstruct-work-log-archive-raw");

describe("work-log archive Raw reconstruction", () => {
  it("extracts the original bytes and restores only an exact DB hash match", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brain-archive-reconstruct-"));
    const root = init(parent).brainRoot;
    try {
      const content = "# 파일 수정 — 2026-04-01 00:02\n\n## 대상 파일\nD:\\Demo\\file.txt";
      const fileName = "20260401_000207.md";
      const archive = `# Work Log Archive — 2026-04\n\n---\n## ${fileName}\n${content}\n\n`;
      const archivePath = path.join(root, "30_topics", "work-log", "archive_2026-04.md");
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.writeFileSync(archivePath, archive, "utf8");

      const parsed = parseArchive(archive);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].content, content);

      const sourceRef = `30_topics/work-log/${fileName}`;
      const db = getDb(root);
      try {
        upsertRecord(db, {
          recordId: "rec_topic_work-log_20260401_0001",
          scopeType: "topic",
          scopeId: "work-log",
          type: "log",
          title: "작업 로그",
          summary: "파일 수정",
          tags: ["domain/dev"],
          sourceType: "candidate",
          sourceRef,
          status: "active",
          updatedAt: "2026-04-01T00:02:08.000Z",
          contentHash: hashText(content)
        });
      } finally {
        db.close();
      }

      const plan = reconstructPlan(root);
      assert.equal(plan.totals.exactMatches, 1);
      assert.equal(fs.existsSync(path.join(root, sourceRef)), false);
      assert.equal(JSON.stringify(publicReport(plan)).includes(content), false);

      const applied = applyReconstruction(root, { limit: 1 });
      assert.equal(applied.created.length, 1);
      assert.equal(fs.readFileSync(path.join(root, sourceRef), "utf8"), content);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
