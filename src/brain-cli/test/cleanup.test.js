"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { cleanup } = require("../src/cleanup");

function makeTmpBrain() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brain-cleanup-"));
  const brain = path.join(tmp, "Brain");
  for (const dir of ["90_index", "10_projects/test", "30_topics/work-log", "30_topics/handoff-to-vscode"]) {
    fs.mkdirSync(path.join(brain, dir), { recursive: true });
  }
  return { brain, tmp };
}

function writeRecords(brain, records) {
  fs.writeFileSync(
    path.join(brain, "90_index", "records.jsonl"),
    records.map(record => JSON.stringify(record)).join("\n") + "\n"
  );
}

function writeManifest(brain, files) {
  fs.writeFileSync(
    path.join(brain, "90_index", "manifest.json"),
    JSON.stringify({ version: 1, files }, null, 2)
  );
}

describe("cleanup read-only audit", () => {
  let brain;
  let tmp;

  beforeEach(() => {
    ({ brain, tmp } = makeTmpBrain());
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reports broken references and manifest entries without removing them", () => {
    const records = [{
      recordId: "rec_proj_test_20260331_0001",
      sourceRef: "10_projects/test/missing.md",
      scopeId: "test",
      status: "active"
    }];
    const manifestFiles = [{ path: "10_projects/test/ghost.md" }];
    writeRecords(brain, records);
    writeManifest(brain, manifestFiles);

    const beforeRecords = fs.readFileSync(path.join(brain, "90_index", "records.jsonl"), "utf8");
    const beforeManifest = fs.readFileSync(path.join(brain, "90_index", "manifest.json"), "utf8");
    const report = cleanup(brain);

    assert.equal(report.brokenRefs, 1);
    assert.equal(report.manifestCleaned, 1);
    assert.equal(report.readOnly, true);
    assert.equal(fs.readFileSync(path.join(brain, "90_index", "records.jsonl"), "utf8"), beforeRecords);
    assert.equal(fs.readFileSync(path.join(brain, "90_index", "manifest.json"), "utf8"), beforeManifest);
  });

  it("never deletes or archives individual work-log Raw documents", () => {
    const rawPath = path.join(brain, "30_topics", "work-log", "20260301_120000.md");
    fs.writeFileSync(rawPath, "# Log\nimmutable");
    writeRecords(brain, [{
      recordId: "rec_topic_work-log_20260301_0001",
      sourceRef: "30_topics/work-log/20260301_120000.md",
      scopeId: "work-log",
      status: "active"
    }]);
    writeManifest(brain, [{ path: "30_topics/work-log/20260301_120000.md" }]);

    const report = cleanup(brain);

    assert.equal(report.archived, 0);
    assert.equal(fs.readFileSync(rawPath, "utf8"), "# Log\nimmutable");
    assert.equal(fs.existsSync(path.join(brain, "30_topics", "work-log", "archive_2026-03.md")), false);
    assert.equal(fs.readFileSync(path.join(brain, "90_index", "records.jsonl"), "utf8").includes("rec_topic_work-log_20260301_0001"), true);
  });

  it("reports completed handoffs without changing lifecycle metadata", () => {
    const handoffPath = path.join(brain, "30_topics", "handoff-to-vscode", "done.md");
    fs.writeFileSync(handoffPath, "done");
    writeRecords(brain, [{
      recordId: "rec_topic_handoff_20260331_0001",
      title: "완료 — 빌드 작업",
      sourceRef: "30_topics/handoff-to-vscode/done.md",
      scopeId: "handoff-to-vscode",
      status: "active"
    }]);
    writeManifest(brain, []);

    const report = cleanup(brain);
    const stored = JSON.parse(fs.readFileSync(path.join(brain, "90_index", "records.jsonl"), "utf8"));

    assert.equal(report.handoffDeprecated, 1);
    assert.equal(stored.status, "active");
    assert.equal(stored.replacedBy, undefined);
  });
});
