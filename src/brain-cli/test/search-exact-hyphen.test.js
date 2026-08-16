"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { init } = require("../src/init");
const { BWTEngine } = require("../src/bwt");
const { search } = require("../src/search");

describe("exact recordId with hyphen", () => {
  it("scopeId에 하이픈이 있어도 exact ID가 1위와 1000000점을 받아야 한다", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brain-exact-hyphen-"));
    const root = init(parent).brainRoot;
    try {
      const result = new BWTEngine(root).execute({
        action: "create", sourceRef: "30_topics/work-log/exact.md", content: "exact hyphen id",
        record: { scopeType: "topic", scopeId: "work-log", type: "log", title: "하이픈 ID", summary: "exact", tags: ["domain/memory"], sourceType: "candidate" }
      });
      assert.equal(result.success, true);
      assert.match(result.recordId, /work-log/);
      const recalled = search(root, { currentGoal: result.recordId, topK: 3 });
      assert.equal(recalled.candidates[0].recordId, result.recordId);
      assert.equal(recalled.candidates[0].score, 1000000);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
