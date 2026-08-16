"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { writeJsonl } = require("../src/utils");
const { upsertFact } = require("../src/fact-ledger");
const { createMemoryBrief } = require("../src/context-assembler");
const { guardDraft } = require("../src/answer-guard");
const { listSmartMemoryProposals } = require("../src/smart-memory-learning");

let testRoot;
let peerRoot;

function setupRoot() {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-cross-agent-"));
  peerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-cross-agent-peer-"));
  fs.mkdirSync(path.join(testRoot, "90_index"), { recursive: true });
  fs.mkdirSync(path.join(peerRoot, "90_index"), { recursive: true });
  fs.writeFileSync(path.join(testRoot, "90_index", "records_digest.txt"), "", "utf-8");
  fs.writeFileSync(path.join(peerRoot, "90_index", "records_digest.txt"), "", "utf-8");
  writeJsonl(path.join(testRoot, "90_index", "records.jsonl"), []);
  writeJsonl(path.join(peerRoot, "90_index", "records.jsonl"), []);
  upsertFact(testRoot, {
    scopeId: "agentforge",
    subject: "AgentForge",
    predicate: "supports",
    object: "HTML artifact generation",
    sourceRefs: ["fixture/cross-agent"],
    sourceType: "user_confirmed"
  });
}

describe("Cross-agent memory contract", () => {
  beforeEach(setupRoot);
  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.rmSync(peerRoot, { recursive: true, force: true });
  });

  it("채널이 달라도 brief schema와 HTML fact는 유지된다", () => {
    const modes = ["codex_local", "telegram_1_1", "telegram_multi_agent", "desktop_claude"];
    let baselinePolicy = null;
    for (const mode of modes) {
      const brief = createMemoryBrief(testRoot, {
        project: "agentforge",
        goal: "밴딩AI에 HTML 산출물을 넣으면 좋을까?",
        channelMode: mode,
        conversationId: "room-1"
      });
      assert.ok(brief.sections.activeState);
      assert.ok(Array.isArray(brief.sections.facts));
      assert.ok(Array.isArray(brief.blockedRefs));
      assert.ok(brief.sections.facts.some(fact => fact.object === "HTML artifact generation"));
      assert.ok(brief.sections.evidenceDigest.detector.recommendedUse);
      assert.equal(brief.sections.smartMemory.schemaVersion, "smart-memory/v1");
      assert.ok(brief.sections.smartMemory.intent);
      assert.ok(brief.sections.smartMemory.decisions.some(decision => decision.decision === "use_as_current"));
      assert.equal(brief.sections.smartMemory.answerPolicy.avoidRepeatingExistingCapability, true);
      const comparablePolicy = {
        canAssertCurrentFact: brief.sections.smartMemory.answerPolicy.canAssertCurrentFact,
        avoidRepeatingExistingCapability: brief.sections.smartMemory.answerPolicy.avoidRepeatingExistingCapability,
        blockedByPolicy: brief.sections.smartMemory.answerPolicy.blockedByPolicy,
        groundingMode: brief.sections.smartMemory.answerPolicy.groundingMode
      };
      if (!baselinePolicy) baselinePolicy = comparablePolicy;
      else assert.deepEqual(comparablePolicy, baselinePolicy);
    }
  });

  it("같은 draft의 Guard 판정은 채널과 무관하게 일치한다", () => {
    const brief = createMemoryBrief(testRoot, {
      project: "agentforge",
      goal: "밴딩AI에 HTML 산출물을 넣으면 좋을까?",
      channelMode: "codex_local"
    });
    const result = guardDraft(testRoot, {
      brief,
      draftText: "오픈소스를 활용해 HTML 산출물을 밴딩AI에 추가하면 좋겠습니다."
    });
    assert.equal(result.status, "revise_required");
    assert.equal(result.findings[0].failureType, "known_capability_as_new_suggestion");
    assert.ok(result.findings[0].guardReasons.includes("avoid_repeating_as_new"));
    const proposals = listSmartMemoryProposals(testRoot, { scopeId: "agentforge" });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].schemaVersion, "smart-memory-learning-proposal/v1");
    assert.equal(proposals[0].eventType, "memory_prevented_error");
  });

  it("primary root에 없는 fact도 peer root에서 합산하고 factId로 dedupe한다", () => {
    fs.rmSync(path.join(testRoot, "42_facts"), { recursive: true, force: true });
    upsertFact(peerRoot, {
      scopeId: "agentforge",
      subject: "AgentForge",
      predicate: "supports",
      object: "HTML artifact generation",
      sourceRefs: ["peer/fact"],
      sourceType: "user_confirmed"
    });

    const brief = createMemoryBrief(testRoot, {
      project: "agentforge",
      goal: "밴딩AI에 HTML 산출물을 넣으면 좋을까?",
      channelMode: "codex_local",
      peerRoots: [peerRoot]
    });

    assert.equal(brief.sections.facts.filter(fact => fact.object === "HTML artifact generation").length, 1);
    assert.equal(brief.sections.facts[0]._source, path.basename(peerRoot));
    assert.deepEqual(brief.roots.peers, [path.basename(peerRoot)]);
  });
});
