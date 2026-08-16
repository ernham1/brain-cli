"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { writeJsonl } = require("../src/utils");
const { createMemoryBrief } = require("../src/context-assembler");
const { guardDraft } = require("../src/answer-guard");
const { readConsolidationLog, readEdges, upsertEdges } = require("../src/memory-graph");
const {
  applyApprovedSmartMemoryProposal,
  listSmartMemoryApplications,
  listSmartMemoryProposalDecisions,
  listSmartMemoryProposals,
  reviewSmartMemoryProposal,
  smartMemoryProposalsPath,
  upsertSmartMemoryLearningProposal
} = require("../src/smart-memory-learning");
const {
  getSmartMemoryPolicyForScope,
  smartMemoryPolicyPath
} = require("../src/smart-memory-policy");

let testRoot;

function setupRoot() {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-smart-memory-learning-"));
  fs.mkdirSync(path.join(testRoot, "90_index"), { recursive: true });
  fs.writeFileSync(path.join(testRoot, "90_index", "records_digest.txt"), [
    "# Brain records_digest.txt",
    "rec_proj_agentforge_20260511_0001 | 밴딩AI HTML 산출물 | 밴딩AI는 HTML 산출물을 만들 수 있음 | domain/design,intent/retrieval | active | note | user_confirmed | 2026-05-11T00:00:00.000Z"
  ].join("\n") + "\n", "utf-8");
  writeJsonl(path.join(testRoot, "90_index", "records.jsonl"), []);
}

function runCli(args) {
  const cliPath = path.join(__dirname, "..", "src", "index.js");
  const child = spawn(process.execPath, [cliPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });

  return new Promise(resolve => {
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

describe("Smart Memory Learning Proposal", () => {
  beforeEach(setupRoot);
  afterEach(() => {
    if (testRoot) fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("Guard 차단 결과는 자동 적용 없는 learning proposal로 저장된다", () => {
    const brief = createMemoryBrief(testRoot, {
      project: "agentforge",
      goal: "신규 오픈소스를 분석해줘",
      userId: "ernham"
    });
    const draftText = "이 오픈소스를 활용해 HTML 산출물 기능을 밴딩AI에 추가하면 좋겠습니다.";
    const result = guardDraft(testRoot, { brief, draftText });
    const proposals = listSmartMemoryProposals(testRoot, { scopeId: "agentforge" });
    const consolidation = readConsolidationLog(testRoot);

    assert.equal(result.status, "revise_required");
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].schemaVersion, "smart-memory-learning-proposal/v1");
    assert.equal(proposals[0].eventType, "memory_prevented_error");
    assert.equal(proposals[0].status, "proposal");
    assert.ok(proposals[0].proposedChanges.some(change => change.changeType === "strengthen_inhibition"));
    assert.ok(proposals[0].evidence.guardReasons.includes("avoid_repeating_as_new"));
    assert.equal(JSON.stringify(proposals).includes(draftText), false);
    assert.ok(fs.existsSync(smartMemoryProposalsPath(testRoot)));
    assert.ok(consolidation.some(log => log.source === "smart_memory_learning"));
  });

  it("같은 Guard 결과 proposal은 proposalId 기준으로 idempotent하게 갱신된다", () => {
    const brief = createMemoryBrief(testRoot, {
      project: "agentforge",
      goal: "신규 오픈소스를 분석해줘"
    });
    const guardResult = {
      guardId: "guard_same",
      status: "revise_required",
      findings: [{
        failureType: "known_capability_as_new_suggestion",
        guardReasons: ["avoid_repeating_as_new"]
      }]
    };

    const first = upsertSmartMemoryLearningProposal(testRoot, {
      brief,
      guardResult,
      resultId: guardResult.guardId
    });
    const second = upsertSmartMemoryLearningProposal(testRoot, {
      brief,
      guardResult,
      resultId: guardResult.guardId
    });
    const proposals = listSmartMemoryProposals(testRoot, { scopeId: "agentforge" });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].hitCount, 2);
  });

  it("CLI smart-memory proposals는 저장된 proposal을 조회한다", async () => {
    const brief = createMemoryBrief(testRoot, {
      project: "agentforge",
      goal: "신규 오픈소스를 분석해줘"
    });
    guardDraft(testRoot, {
      brief,
      draftText: "이 오픈소스를 활용해 HTML 산출물 기능을 밴딩AI에 넣으면 유용합니다."
    });

    const cli = await runCli([
      "smart-memory", "proposals",
      "--scope", "agentforge",
      "--brain", testRoot
    ]);
    assert.equal(cli.code, 0, cli.stderr);
    const body = JSON.parse(cli.stdout);
    assert.equal(body.total, 1);
    assert.equal(body.proposals[0].status, "proposal");
    assert.equal(body.proposals[0].eventType, "memory_prevented_error");
  });

  it("approved Smart Memory proposal만 edge weight에 적용된다", () => {
    upsertEdges(testRoot, [{
      edgeId: "edge_apply_test",
      fromNodeId: "node_a",
      toNodeId: "node_b",
      relation: "supports",
      weight: 0.5,
      confidence: 0.5,
      provenance: ["test"],
      metadata: {}
    }]);
    const created = upsertSmartMemoryLearningProposal(testRoot, {
      scopeId: "agentforge",
      eventType: "memory_used_success",
      resultId: "result_apply_test",
      activation: {
        activatedNodeIds: ["node_a", "node_b"],
        activatedEdgeIds: ["edge_apply_test"],
        inhibitionSignals: [],
        reviewSignals: [],
        usedDepth: "D1"
      }
    });
    assert.equal(created.proposal.status, "proposal");
    assert.throws(() => applyApprovedSmartMemoryProposal(testRoot, {
      proposalId: created.proposal.proposalId
    }), /approved Smart Memory proposal/);

    const review = reviewSmartMemoryProposal(testRoot, {
      proposalId: created.proposal.proposalId,
      decision: "approved",
      reviewer: "unit-test",
      reason: "edge 강화 승인"
    });
    const applied = applyApprovedSmartMemoryProposal(testRoot, {
      proposalId: created.proposal.proposalId,
      appliedBy: "unit-test",
      reason: "approved proposal 적용"
    });
    const duplicate = applyApprovedSmartMemoryProposal(testRoot, {
      proposalId: created.proposal.proposalId,
      appliedBy: "unit-test"
    });
    const edge = readEdges(testRoot).find(item => item.edgeId === "edge_apply_test");
    const decisions = listSmartMemoryProposalDecisions(testRoot, { scopeId: "agentforge" });
    const applications = listSmartMemoryApplications(testRoot, { scopeId: "agentforge" });

    assert.equal(review.proposal.status, "approved");
    assert.equal(review.decision.decision, "approved");
    assert.equal(applied.applied, true);
    assert.equal(applied.proposal.status, "applied");
    assert.equal(applied.application.status, "applied");
    assert.equal(applied.application.appliedChanges[0].nextWeight, 0.52);
    assert.equal(edge.weight, 0.52);
    assert.equal(edge.confidence, 0.52);
    assert.ok(edge.provenance.includes(`smart-memory:${created.proposal.proposalId}`));
    assert.equal(duplicate.applied, false);
    assert.equal(duplicate.application.applicationId, applied.application.applicationId);
    assert.equal(decisions.length, 1);
    assert.equal(applications.length, 1);
  });

  it("CLI smart-memory review/apply는 approved proposal을 적용한다", async () => {
    upsertEdges(testRoot, [{
      edgeId: "edge_cli_apply",
      fromNodeId: "node_cli_a",
      toNodeId: "node_cli_b",
      relation: "supports",
      weight: 0.6,
      confidence: 0.6,
      provenance: ["test"],
      metadata: {}
    }]);
    const created = upsertSmartMemoryLearningProposal(testRoot, {
      scopeId: "agentforge",
      eventType: "memory_used_success",
      resultId: "result_cli_apply",
      activation: {
        activatedNodeIds: ["node_cli_a", "node_cli_b"],
        activatedEdgeIds: ["edge_cli_apply"],
        inhibitionSignals: [],
        reviewSignals: [],
        usedDepth: "D1"
      }
    });

    const review = await runCli([
      "smart-memory", "review",
      "--proposal", created.proposal.proposalId,
      "--decision", "approved",
      "--reviewer", "cli-test",
      "--reason", "승인",
      "--brain", testRoot
    ]);
    assert.equal(review.code, 0, review.stderr);
    const reviewBody = JSON.parse(review.stdout);
    assert.equal(reviewBody.proposal.status, "approved");

    const apply = await runCli([
      "smart-memory", "apply",
      "--proposal", created.proposal.proposalId,
      "--applied-by", "cli-test",
      "--reason", "적용",
      "--brain", testRoot
    ]);
    assert.equal(apply.code, 0, apply.stderr);
    const applyBody = JSON.parse(apply.stdout);
    const edge = readEdges(testRoot).find(item => item.edgeId === "edge_cli_apply");

    assert.equal(applyBody.applied, true);
    assert.equal(applyBody.application.appliedChanges[0].nextWeight, 0.62);
    assert.equal(edge.weight, 0.62);
  });

  it("inhibition proposal apply는 policy store에 반영되고 다음 Brief가 소비한다", async () => {
    const brief = createMemoryBrief(testRoot, {
      project: "agentforge",
      goal: "신규 오픈소스를 분석해줘"
    });
    const guard = guardDraft(testRoot, {
      brief,
      draftText: "이 오픈소스를 활용해 HTML 산출물 기능을 밴딩AI에 추가하면 좋겠습니다."
    });
    assert.equal(guard.status, "revise_required");
    const proposal = listSmartMemoryProposals(testRoot, { scopeId: "agentforge" })[0];
    reviewSmartMemoryProposal(testRoot, {
      proposalId: proposal.proposalId,
      decision: "approved",
      reviewer: "unit-test"
    });
    const applied = applyApprovedSmartMemoryProposal(testRoot, {
      proposalId: proposal.proposalId,
      appliedBy: "unit-test"
    });
    const policy = getSmartMemoryPolicyForScope(testRoot, "agentforge");
    const nextBrief = createMemoryBrief(testRoot, {
      project: "agentforge",
      goal: "다른 오픈소스를 분석해줘"
    });

    assert.equal(applied.applied, true);
    assert.ok(fs.existsSync(smartMemoryPolicyPath(testRoot)));
    assert.ok(policy.inhibitionSignals.some(signal => signal.signal === "avoid_repeating_existing_capability"));
    assert.ok(nextBrief.sections.smartMemory.policy.inhibitionSignals.some(signal => signal.signal === "avoid_repeating_existing_capability"));
    assert.equal(nextBrief.sections.smartMemory.answerPolicy.avoidRepeatingExistingCapability, true);
    assert.equal(nextBrief.sections.smartMemory.answerPolicy.policyApplied, true);
  });

  it("CLI smart-memory policy는 scope policy를 조회한다", async () => {
    const brief = createMemoryBrief(testRoot, {
      project: "agentforge",
      goal: "신규 오픈소스를 분석해줘"
    });
    guardDraft(testRoot, {
      brief,
      draftText: "이 오픈소스를 활용해 HTML 산출물을 넣으면 좋겠습니다."
    });
    const proposal = listSmartMemoryProposals(testRoot, { scopeId: "agentforge" })[0];
    reviewSmartMemoryProposal(testRoot, {
      proposalId: proposal.proposalId,
      decision: "approved",
      reviewer: "unit-test"
    });
    applyApprovedSmartMemoryProposal(testRoot, {
      proposalId: proposal.proposalId,
      appliedBy: "unit-test"
    });

    const cli = await runCli([
      "smart-memory", "policy",
      "--scope", "agentforge",
      "--brain", testRoot
    ]);
    assert.equal(cli.code, 0, cli.stderr);
    const body = JSON.parse(cli.stdout);
    assert.equal(body.policy.scopeId, "agentforge");
    assert.ok(body.policy.inhibitionSignals.some(signal => signal.signal === "avoid_repeating_existing_capability"));
  });
});
