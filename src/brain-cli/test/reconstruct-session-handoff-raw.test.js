"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { init } = require("../src/init");
const { getDb, upsertRecord } = require("../src/db");
const { generateDigestLine } = require("../src/utils");
const {
  reconstructPlan,
  applyReconstruction,
  renderHandoff,
  hashText,
  sessionParts
} = require("../scripts/reconstruct-session-handoff-raw");

describe("session handoff Raw reconstruction", () => {
  it("transcript cwd and historical digest produce an exact hash before recovery", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brain-handoff-reconstruct-"));
    const root = init(parent).brainRoot;
    const transcripts = path.join(parent, "transcripts");
    fs.mkdirSync(transcripts, { recursive: true });
    try {
      const previous = [];
      const db = getDb(root);
      try {
        for (let index = 1; index <= 5; index++) {
          const record = {
            recordId: `rec_topic_work-log_20260721_000${index}`,
            scopeType: "topic",
            scopeId: "work-log",
            type: "log",
            title: `작업 로그 ${index}`,
            summary: `[15:0${index}] Write: demo-${index}.md`,
            tags: ["domain/dev", "intent/retrieval"],
            sourceType: "candidate",
            sourceRef: `30_topics/work-log/demo-${index}.md`,
            status: "active",
            updatedAt: `2026-07-21T06:0${index}:00.000Z`,
            contentHash: hashText(`raw-${index}`)
          };
          upsertRecord(db, record);
          previous.push(record);
        }

        const sourceRef = "10_projects/clo-handoff/sessions/vscode-20260721-151700-abc12345.md";
        const parts = sessionParts(sourceRef);
        const recentBrain = previous.map(generateDigestLine).join("\n");
        const content = renderHandoff(parts, "D:\\Projects\\Demo", "(git 정보 없음)", recentBrain);
        upsertRecord(db, {
          recordId: "rec_proj_clo-handoff_20260721_0001",
          scopeType: "project",
          scopeId: "clo-handoff",
          type: "note",
          title: "VS Code 핸드오프 — 2026-07-21 15:17",
          summary: "VS Code 세션 종료 (D:\\Projects\\Demo)",
          tags: ["domain/memory", "intent/handoff"],
          sourceType: "candidate",
          sourceRef,
          status: "active",
          updatedAt: "2026-07-21T06:17:01.000Z",
          contentHash: hashText(content)
        });
      } finally {
        db.close();
      }

      fs.writeFileSync(
        path.join(transcripts, "abc12345-0000-0000-0000-000000000000.jsonl"),
        JSON.stringify({ type: "attachment", cwd: "D:\\Projects\\Demo" }) + "\n",
        "utf8"
      );

      const plan = reconstructPlan(root, transcripts);
      assert.equal(plan.totals.targets, 1);
      assert.equal(plan.totals.exactMatches, 1);
      assert.equal(fs.existsSync(path.join(root, plan.matches[0].sourceRef)), false);

      const applied = applyReconstruction(root, transcripts, { limit: 1 });
      assert.equal(applied.created.length, 1);
      assert.equal(hashText(fs.readFileSync(path.join(root, plan.matches[0].sourceRef), "utf8")), plan.matches[0].contentHash);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("uses an adjacent Raw digest snapshot when current DB metadata changed later", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brain-handoff-adjacent-"));
    const root = init(parent).brainRoot;
    const transcripts = path.join(parent, "transcripts");
    fs.mkdirSync(transcripts, { recursive: true });
    try {
      const previous = [];
      const db = getDb(root);
      try {
        for (let index = 1; index <= 5; index++) {
          const record = {
            recordId: `rec_topic_work-log_20260722_000${index}`,
            scopeType: "topic", scopeId: "work-log", type: "log",
            title: `작업 로그 ${index}`,
            summary: `[16:0${index}] Write: historical-${index}.md`,
            tags: ["domain/dev", "intent/retrieval"], sourceType: "candidate",
            sourceRef: `30_topics/work-log/historical-${index}.md`,
            status: "active", updatedAt: `2026-07-22T07:0${index}:00.000Z`,
            contentHash: hashText(`raw-${index}`)
          };
          upsertRecord(db, record);
          previous.push(record);
        }
        const historicalRecent = previous.map(generateDigestLine).join("\n");
        const targetRef = "10_projects/clo-handoff/sessions/vscode-20260722-161400-deadbeef.md";
        upsertRecord(db, {
          recordId: "rec_proj_clo-handoff_20260722_0099", scopeType: "project", scopeId: "clo-handoff",
          type: "note", title: "VS Code 핸드오프 — 2026-07-22 16:14",
          summary: "VS Code 세션 종료 (D:\\Projects\\Demo)",
          tags: ["domain/memory", "intent/handoff"], sourceType: "candidate",
          sourceRef: targetRef, status: "active", updatedAt: "2026-07-22T07:14:01.000Z",
          contentHash: hashText(renderHandoff(sessionParts(targetRef), "D:\\Projects\\Demo", "(git 정보 없음)", historicalRecent))
        });
        const neighborRef = "10_projects/clo-handoff/sessions/vscode-20260722-161401-feedface.md";
        const neighborContent = renderHandoff(sessionParts(neighborRef), "D:\\Projects\\Demo", "(git 정보 없음)", historicalRecent);
        upsertRecord(db, {
          recordId: "rec_proj_clo-handoff_20260722_0100", scopeType: "project", scopeId: "clo-handoff",
          type: "note", title: "VS Code 핸드오프 — 2026-07-22 16:14",
          summary: "VS Code 세션 종료 (D:\\Projects\\Demo)",
          tags: ["domain/memory", "intent/handoff"], sourceType: "candidate",
          sourceRef: neighborRef, status: "active", updatedAt: "2026-07-22T07:14:02.000Z",
          contentHash: hashText(neighborContent)
        });
        const neighborPath = path.join(root, neighborRef);
        fs.mkdirSync(path.dirname(neighborPath), { recursive: true });
        fs.writeFileSync(neighborPath, neighborContent, "utf8");
        upsertRecord(db, { ...previous[4], summary: "later metadata changed" });
      } finally { db.close(); }
      fs.writeFileSync(
        path.join(transcripts, "deadbeef-0000-0000-0000-000000000000.jsonl"),
        JSON.stringify({ type: "attachment", cwd: "D:\\Projects\\Demo" }) + "\n", "utf8"
      );
      const plan = reconstructPlan(root, transcripts);
      const match = plan.matches.find(item => item.recordId === "rec_proj_clo-handoff_20260722_0099");
      assert.ok(match);
      assert.equal(match.evidence.recentBrainSource, "adjacent-raw");
      assert.equal(match.evidence.snapshotRecordId, "rec_proj_clo-handoff_20260722_0100");

      const filteredOut = reconstructPlan(root, transcripts, {
        recordIds: ["rec_proj_clo-handoff_20260722_nonexistent"]
      });
      assert.equal(filteredOut.totals.targets, 0);
      assert.equal(filteredOut.totals.exactMatches, 0);
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  });
});
