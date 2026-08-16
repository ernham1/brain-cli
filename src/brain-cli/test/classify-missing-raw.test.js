"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { generatorProfile, sourceFamily } = require("../scripts/classify-missing-raw");

describe("missing Raw classification", () => {
  it("classifies specialized source families", () => {
    assert.equal(sourceFamily("30_topics/work-log/20260721_010101.md"), "work-log");
    assert.equal(sourceFamily("10_projects/clo-handoff/sessions/vscode-x.md"), "session-handoff");
    assert.equal(sourceFamily("10_projects/brain/state.md"), "10_projects/brain");
  });

  it("maps canonical state to applicable exact generators", () => {
    assert.equal(generatorProfile({ source_ref: "30_topics/work-log/a.md" }, { jsonl: 0 }), "work-log-archive+auto-brain-transcript");
    assert.equal(generatorProfile({ source_ref: "30_topics/work-log/a.md" }, { jsonl: 1 }), "work-log-archive");
    assert.equal(generatorProfile({ source_ref: "10_projects/clo-handoff/sessions/a.md" }, { jsonl: 1 }), "session-handoff-transcript");
    assert.equal(generatorProfile({ source_ref: "10_projects/brain/a.md" }, { jsonl: 1 }), "no-specialized-generator");
  });
});
