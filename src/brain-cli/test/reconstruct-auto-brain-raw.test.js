"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { init } = require("../src/init");
const { getDb, upsertRecord } = require("../src/db");
const { reconstructPlan, applyReconstruction, renderCandidates, hashText } = require("../scripts/reconstruct-auto-brain-raw");

describe("auto Brain Raw transcript reconstruction", () => {
  it("transcript 이벤트로 만든 본문 해시가 DB와 같을 때만 복원한다", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brain-reconstruct-test-"));
    const root = init(parent).brainRoot;
    const transcripts = path.join(parent, "transcripts");
    fs.mkdirSync(transcripts, { recursive: true });
    try {
      const sourceRef = "30_topics/work-log/20260721_151741.md";
      const toolUse = { name: "Write", input: { file_path: "d:\\Projects\\Demo\\LOOP_STATUS.md", content: "# 상태\n완료" } };
      const target = { sourceRef };
      const content = renderCandidates(toolUse, {}, target)[0];
      const db = getDb(root);
      try {
        upsertRecord(db, {
          recordId: "rec_topic_work-log_20260721_0001", scopeType: "topic", scopeId: "work-log", type: "log",
          title: "작업 로그 — 2026-07-21 15:17", summary: "[15:17] Write: Projects/Demo/LOOP_STATUS.md",
          tags: ["domain/dev"], sourceType: "candidate", sourceRef, status: "active",
          updatedAt: "2026-07-21T06:17:42.000Z", contentHash: hashText(content),
        });
      } finally { db.close(); }

      const transcriptLines = [
        { timestamp: "2026-07-21T06:17:40.000Z", message: { content: [{ type: "tool_use", id: "tool-1", name: "Write", input: toolUse.input }] } },
        { timestamp: "2026-07-21T06:17:41.000Z", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok", is_error: false }] } },
      ];
      fs.writeFileSync(path.join(transcripts, "session.jsonl"), transcriptLines.map(item => JSON.stringify(item)).join("\n") + "\n", "utf8");

      const plan = await reconstructPlan(root, transcripts);
      assert.equal(plan.totals.targets, 1);
      assert.equal(plan.totals.exactMatches, 1);
      assert.equal(fs.existsSync(path.join(root, sourceRef)), false);

      await assert.rejects(() => applyReconstruction(root, transcripts, { limit: 1 }), /allowlist/);
      const applied = await applyReconstruction(root, transcripts, { limit: 1, recordIds: ["rec_topic_work-log_20260721_0001"] });
      assert.equal(applied.created.length, 1);
      assert.equal(fs.readFileSync(path.join(root, sourceRef), "utf8"), content);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

