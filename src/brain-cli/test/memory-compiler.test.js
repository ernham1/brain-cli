"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { writeJsonl, readJsonl } = require("../src/utils");
const { classifyMemory, compileMemory, classesPath } = require("../src/memory-compiler");
const { listFacts } = require("../src/fact-ledger");

let testRoot;

function setupRoot() {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-memory-compiler-"));
  fs.mkdirSync(path.join(testRoot, "90_index"), { recursive: true });
}

describe("Memory Compiler", () => {
  beforeEach(setupRoot);
  afterEach(() => fs.rmSync(testRoot, { recursive: true, force: true }));

  it("record type을 deterministic memory class로 분류한다", () => {
    assert.equal(classifyMemory({ type: "project_state" }), "semantic");
    assert.equal(classifyMemory({ type: "log" }), "episodic");
    assert.equal(classifyMemory({ type: "rule" }), "procedural");
    assert.equal(classifyMemory({ type: "log", summary: "Guard 실패: HTML 신규 제안 반복" }), "reflection");
  });

  it("HTML project_state record를 컴파일하면 fact candidate를 Fact Ledger에 넘긴다", () => {
    writeJsonl(path.join(testRoot, "90_index", "records.jsonl"), [{
      recordId: "rec_proj_agentforge_20260511_0001",
      scopeType: "project",
      scopeId: "agentforge",
      type: "project_state",
      sourceType: "user_confirmed",
      sourceRef: "docs/html.md",
      title: "밴딩AI HTML 산출물",
      summary: "밴딩AI는 HTML 산출물을 지원한다."
    }]);

    const result = compileMemory(testRoot, { recordId: "rec_proj_agentforge_20260511_0001" });
    const classes = readJsonl(classesPath(testRoot));
    const facts = listFacts(testRoot, { scopeId: "agentforge" });

    assert.equal(result.total, 1);
    assert.equal(classes[0].memoryClass, "semantic");
    assert.equal(facts[0].object, "HTML artifact generation");
    assert.equal(facts[0].status, "active");
  });
});
