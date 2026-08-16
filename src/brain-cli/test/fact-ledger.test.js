"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { upsertFact, listFacts } = require("../src/fact-ledger");
const { loadActiveState } = require("../src/active-state");

let testRoot;

function setupRoot() {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-fact-ledger-"));
  fs.mkdirSync(path.join(testRoot, "90_index"), { recursive: true });
}

describe("Fact Ledger", () => {
  beforeEach(setupRoot);
  afterEach(() => fs.rmSync(testRoot, { recursive: true, force: true }));

  it("HTML 지원 fact를 생성하고 Active State capability에 반영한다", () => {
    const result = upsertFact(testRoot, {
      scopeId: "agentforge",
      subject: "AgentForge",
      predicate: "supports",
      object: "HTML artifact generation",
      sourceRefs: ["docs/design/html.md"],
      sourceType: "user_confirmed"
    });
    const facts = listFacts(testRoot, { scopeId: "agentforge" });
    const state = loadActiveState(testRoot, "agentforge");

    assert.equal(result.fact.status, "active");
    assert.equal(facts.length, 1);
    assert.ok(state.facts.some(fact => fact.id === result.fact.factId));
    assert.ok(state.capabilities.some(capability => capability.title.includes("HTML")));
  });

  it("낮은 신뢰의 충돌 fact는 기존 active를 덮지 않고 disputed가 된다", () => {
    upsertFact(testRoot, {
      scopeId: "agentforge",
      subject: "AgentForge",
      predicate: "supports",
      object: "HTML artifact generation",
      sourceRefs: ["rec_confirmed"],
      sourceType: "user_confirmed"
    });
    const result = upsertFact(testRoot, {
      scopeId: "agentforge",
      subject: "AgentForge",
      predicate: "supports",
      object: "text artifact only",
      sourceRefs: ["rec_candidate"],
      sourceType: "candidate"
    });

    assert.equal(result.fact.status, "disputed");
    assert.equal(result.conflicts.length, 1);
    assert.equal(listFacts(testRoot, { scopeId: "agentforge", status: "active" }).length, 1);
  });

  it("높은 신뢰의 충돌 fact는 기존 active를 superseded로 전환한다", () => {
    const first = upsertFact(testRoot, {
      scopeId: "agentforge",
      subject: "AgentForge",
      predicate: "defaultOutput",
      object: "markdown brief",
      sourceRefs: ["rec_old"],
      sourceType: "user_confirmed"
    });
    const second = upsertFact(testRoot, {
      scopeId: "agentforge",
      subject: "AgentForge",
      predicate: "defaultOutput",
      object: "html artifact",
      sourceRefs: ["rec_new"],
      sourceType: "user_confirmed"
    });
    const activeFacts = listFacts(testRoot, { scopeId: "agentforge", status: "active" });
    const supersededFacts = listFacts(testRoot, { scopeId: "agentforge", status: "superseded" });

    assert.equal(second.fact.status, "active");
    assert.deepEqual(second.fact.supersedes, [first.fact.factId]);
    assert.equal(activeFacts.length, 1);
    assert.equal(activeFacts[0].object, "html artifact");
    assert.equal(supersededFacts.length, 1);
    assert.equal(supersededFacts[0].object, "markdown brief");
  });
});
