"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  DECISIONS,
  buildSmartMemorySection,
  classifySmartMemoryIntent
} = require("../src/smart-memory");

describe("Smart Memory Intelligence Layer", () => {
  it("검증 의도는 D4 근거 중심 정책으로 분류된다", () => {
    const intent = classifySmartMemoryIntent("최신 원문 근거로 Brain 설계서 검증해줘");

    assert.equal(intent.intent, "verification");
    assert.equal(intent.depthBudget, "D4");
    assert.equal(intent.riskLevel, "medium");
  });

  it("이미 확정된 capability는 현재 사실로 쓰고 신규 제안 반복을 막는다", () => {
    const section = buildSmartMemorySection({
      scopeId: "agentforge",
      goal: "밴딩AI에 HTML 산출물을 넣으면 좋을까?",
      channelMode: "dm",
      evidenceDigest: {
        records: [{
          analyzer: "active_state",
          ref: "cap_html_artifact",
          label: "밴딩AI HTML 산출물",
          confidence: 92,
          evidenceStrength: "overwhelming",
          reasons: ["active capability", "has sourceRefs"]
        }],
        detector: {
          recommendedUse: {
            useForAnswer: true,
            avoidRepeatingAsNew: true
          }
        }
      },
      memoryGraph: {
        activatedNodes: [{
          nodeId: "node_cap_html",
          nodeType: "capability",
          title: "밴딩AI HTML 산출물",
          status: "active",
          activationScore: 91
        }],
        inhibitionSignals: [{
          signal: "avoid_repeating_existing_capability",
          ref: "cap_html_artifact"
        }]
      }
    });

    assert.equal(section.schemaVersion, "smart-memory/v1");
    assert.equal(section.answerPolicy.canAssertCurrentFact, true);
    assert.equal(section.answerPolicy.avoidRepeatingExistingCapability, true);
    assert.ok(section.decisions.some(decision => decision.decision === DECISIONS.USE_AS_CURRENT));
  });

  it("D4 Obsidian 원문 근거는 인용 필요한 evidence로 판정된다", () => {
    const section = buildSmartMemorySection({
      scopeId: "brain",
      goal: "LLM Wiki 원문 근거로 검증해줘",
      channelMode: "dm",
      evidenceDigest: {
        records: [{
          analyzer: "obsidian",
          ref: "depth_001",
          label: "Brain 설계서",
          confidence: 86,
          evidenceStrength: "overwhelming",
          reasons: ["D4", "rawRef"]
        }],
        detector: {
          hasRawEvidence: true,
          recommendedUse: {
            requireCitation: true
          }
        }
      },
      memoryGraph: {
        activatedNodes: []
      }
    });

    assert.equal(section.depth.usedDepth, "D4");
    assert.equal(section.answerPolicy.requiresCitation, true);
    assert.ok(section.decisions.some(decision => decision.decision === DECISIONS.USE_AS_EVIDENCE));
  });

  it("차단된 ref는 현재 사실로 쓰지 않고 policy block으로 표시한다", () => {
    const section = buildSmartMemorySection({
      scopeId: "brain",
      goal: "그룹방에서 개인 기억도 같이 써줘",
      channelMode: "group",
      evidenceDigest: {
        records: [{
          analyzer: "policy",
          ref: "private_fact_1",
          label: "private_fact_1",
          confidence: 100,
          evidenceStrength: "blocked",
          reasons: ["blocked by access policy"]
        }],
        detector: {}
      },
      memoryGraph: {
        activatedNodes: []
      },
      blockedRefs: ["private_fact_1"]
    });

    assert.equal(section.answerPolicy.blockedByPolicy, true);
    assert.equal(section.answerPolicy.canAssertCurrentFact, false);
    assert.ok(section.decisions.some(decision => decision.decision === DECISIONS.BLOCKED_BY_POLICY));
  });
});
