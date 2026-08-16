"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { validateIntent, validateSourceRef } = require("../src/schemas");

describe("sourceRef validation", () => {
  it("rejects Windows absolute sourceRef paths", () => {
    const errors = validateSourceRef("C:\\Projects\\AgentForge\\docs\\design\\note.md");
    assert.ok(errors.some(error => error.includes("Brain 내부 상대경로")));
  });

  it("rejects parent directory traversal", () => {
    const errors = validateSourceRef("30_topics/../secrets.md");
    assert.ok(errors.some(error => error.includes("상위경로")));
  });

  it("accepts Brain relative sourceRef paths", () => {
    assert.deepEqual(validateSourceRef("10_projects/agentforge/note.md"), []);
  });

  it("validates create intents before BWT path writes", () => {
    const result = validateIntent({
      action: "create",
      sourceRef: "C:/Projects/AgentForge/docs/design/note.md",
      content: "본문",
      record: {
        scopeType: "project",
        scopeId: "agentforge",
        type: "note",
        title: "테스트",
        summary: "요약",
        tags: ["domain/dev"],
        sourceType: "candidate",
      },
    });

    assert.equal(result.valid, false);
    assert.ok(result.errors.some(error => error.includes("Brain 내부 상대경로")));
  });

  it("rejects create intents with sourceRef but without content", () => {
    const result = validateIntent({
      action: "create",
      sourceRef: "10_projects/agentforge/note.md",
      record: {
        scopeType: "project",
        scopeId: "agentforge",
        type: "note",
        title: "테스트",
        summary: "요약",
        tags: ["domain/dev"],
        sourceType: "candidate",
      },
    });

    assert.equal(result.valid, false);
    assert.ok(result.errors.some(error => error.includes("content 필드 필수")));
  });
});
