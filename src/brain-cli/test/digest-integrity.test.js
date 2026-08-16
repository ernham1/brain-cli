"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { generateDigestLine } = require("../src/utils");

describe("digest 한 줄 계약", () => {
  it("제목·요약의 줄바꿈과 파이프를 안전하게 정규화한다", () => {
    const line = generateDigestLine({
      recordId: "rec_proj_brain_20260721_0001",
      title: "첫 줄\n둘째 줄 | 부제",
      summary: "요약\r\n계속 | 상세",
      tags: ["domain/memory", "intent/retrieval"],
      status: "active",
      type: "log",
      sourceType: "candidate",
      updatedAt: "2026-07-21T00:00:00.000Z",
    });
    assert.equal(line.split(/\r?\n/).length, 1);
    assert.equal(line.split(" | ").length, 8);
    assert.match(line, /첫 줄 둘째 줄 \/ 부제/);
  });
});
