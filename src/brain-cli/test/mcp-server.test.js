"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { setInterval, clearInterval } = require("timers");
const { writeJsonl } = require("../src/utils");
const { upsertFact } = require("../src/fact-ledger");
const { upsertGrowthSignal } = require("../src/growth-signal");
const {
  TOOLS,
  resolveMcpBrainRoot,
  brainRecall,
  brainBrief,
  brainGuard,
  brainPolicyCheck,
  brainSmartMemoryApplyProposal,
  brainSmartMemoryEvaluate,
  brainSmartMemoryEvaluationCases,
  brainSmartMemoryPolicy,
  brainSmartMemoryProposals,
  brainSmartMemoryReviewProposal,
  brainGrowthCandidates,
  brainGrowthReviewCandidate,
  brainGrowthCreateRegressionCase,
  brainGrowthRunRegressionCase,
  brainGrowthCreatePromotionProposal,
  brainGrowthReviewPromotionProposal,
  brainGrowthApplyPromotionProposal,
  brainGrowthProjectPromotionExports,
  brainGrowthConsumeProjectPromotionExport,
  brainGrowthAgentForgePromotionExports
} = require("../src/mcp-server");

let testRoot;

function setupRoot() {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-mcp-server-"));
  fs.mkdirSync(path.join(testRoot, "90_index"), { recursive: true });
  fs.writeFileSync(path.join(testRoot, "90_index", "manifest.json"), JSON.stringify({ files: [] }), "utf-8");
  fs.writeFileSync(path.join(testRoot, "90_index", "records_digest.txt"), [
    "rec_proj_agentforge_20260511_0001 | 밴딩AI HTML 산출물 | 밴딩AI는 HTML 산출물을 지원한다 | domain/dev,intent/retrieval | active | project_state | user_confirmed | 2026-05-11T00:00:00.000Z"
  ].join("\n") + "\n", "utf-8");
  writeJsonl(path.join(testRoot, "90_index", "records.jsonl"), []);
  upsertFact(testRoot, {
    scopeId: "agentforge",
    subject: "AgentForge",
    predicate: "supports",
    object: "HTML artifact generation",
    sourceRefs: ["test/mcp"],
    sourceType: "user_confirmed"
  });
  process.env.BRAIN_ROOT = testRoot;
}

function seedGrowthCandidate(scopeId = "agentforge") {
  const signal = {
    scopeId,
    source: "answer_guard",
    failureType: "direct_user_coding_instruction",
    summary: "사용자에게 직접 코딩 실행을 지시함",
    evidenceRefs: ["test/mcp-growth"],
    guardReasons: ["review_required", "citation_required"],
    detectorStatus: "review_before_use",
    detectorReasons: ["manual_review_required"],
    recommendedUse: { requireReview: true, requireCitation: true },
    suggestedFix: "에이전트가 직접 실행하고 증거를 보고한다."
  };
  upsertGrowthSignal(testRoot, signal);
  upsertGrowthSignal(testRoot, signal);
}

function deterministicRegressionCaseId(signalId) {
  return `grc_${crypto.createHash("sha1").update(`regression:${signalId}`).digest("hex").slice(0, 12)}`;
}

function deterministicPromotionProposalId(caseId) {
  return `gpp_${crypto.createHash("sha1").update(`promotion-proposal:${caseId}`).digest("hex").slice(0, 12)}`;
}

function deterministicPromotionId(proposalId) {
  return `gpr_${crypto.createHash("sha1").update(`promotion:${proposalId}`).digest("hex").slice(0, 12)}`;
}

describe("Brain MCP stdio server", () => {
  beforeEach(setupRoot);
  afterEach(() => {
    delete process.env.BRAIN_ROOT;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("Memory Kernel 도구 목록을 제공한다", () => {
    const names = TOOLS.map(tool => tool.name);
    assert.ok(names.includes("brain_recall"));
    assert.ok(names.includes("brain_write"));
    assert.ok(names.includes("generate_image"));
    assert.ok(names.includes("image_generation_status"));
    assert.ok(names.includes("brain_brief"));
    assert.ok(names.includes("brain_guard"));
    assert.ok(names.includes("brain_policy_check"));
    assert.ok(names.includes("brain_smart_memory_proposals"));
    assert.ok(names.includes("brain_smart_memory_review_proposal"));
    assert.ok(names.includes("brain_smart_memory_apply_proposal"));
    assert.ok(names.includes("brain_smart_memory_policy"));
    assert.ok(names.includes("brain_smart_memory_evaluation_cases"));
    assert.ok(names.includes("brain_smart_memory_evaluate"));
    assert.ok(names.includes("brain_growth_candidates"));
    assert.ok(names.includes("brain_growth_review_candidate"));
    assert.ok(names.includes("brain_growth_create_regression_case"));
    assert.ok(names.includes("brain_growth_run_regression_case"));
    assert.ok(names.includes("brain_growth_create_promotion_proposal"));
    assert.ok(names.includes("brain_growth_review_promotion_proposal"));
    assert.ok(names.includes("brain_growth_apply_promotion_proposal"));
    assert.ok(names.includes("brain_growth_project_promotion_exports"));
    assert.ok(names.includes("brain_growth_consume_project_promotion_export"));
    assert.ok(names.includes("brain_growth_agentforge_promotion_exports"));
  });

  it("manifest가 없는 NeuralfluxBrain을 건너뛰고 사용 가능한 Brain 루트를 선택한다", () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "brain-mcp-home-"));
    const incompleteRoot = path.join(fakeHome, "NeuralfluxBrain");
    const usableRoot = path.join(fakeHome, "Brain");
    fs.mkdirSync(path.join(incompleteRoot, "90_index"), { recursive: true });
    fs.mkdirSync(path.join(usableRoot, "90_index"), { recursive: true });
    fs.writeFileSync(path.join(usableRoot, "90_index", "manifest.json"), JSON.stringify({ files: [] }), "utf-8");

    const previousBrainRoot = process.env.BRAIN_ROOT;
    const originalHomedir = os.homedir;
    delete process.env.BRAIN_ROOT;
    os.homedir = () => fakeHome;
    try {
      assert.equal(resolveMcpBrainRoot(), usableRoot);
    } finally {
      os.homedir = originalHomedir;
      if (previousBrainRoot === undefined) delete process.env.BRAIN_ROOT;
      else process.env.BRAIN_ROOT = previousBrainRoot;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
  it("brain_recall은 관련 기억을 텍스트로 반환한다", () => {
    const text = brainRecall({ goal: "밴딩AI HTML 산출물", topK: 3 });
    assert.match(text, /밴딩AI HTML 산출물/);
    assert.match(text, /rec_proj_agentforge_20260511_0001/);
  });

  it("brain_brief와 brain_guard는 HTML 신규 제안을 차단한다", () => {
    const brief = brainBrief({
      project: "agentforge",
      goal: "밴딩AI에 HTML 산출물을 넣으면 좋을까?",
      channelMode: "desktop_claude"
    });
    const guard = brainGuard({
      brief,
      draftText: "오픈소스를 활용해 HTML 산출물을 밴딩AI에 추가하면 좋겠습니다."
    });

    assert.ok(brief.sections.facts.some(fact => fact.object === "HTML artifact generation"));
    assert.equal(brief.sections.evidenceDigest.detector.recommendedUse.avoidRepeatingAsNew, true);
    assert.equal(brief.sections.smartMemory.schemaVersion, "smart-memory/v1");
    assert.equal(brief.sections.smartMemory.answerPolicy.avoidRepeatingExistingCapability, true);
    assert.equal(guard.status, "revise_required");
    const proposals = brainSmartMemoryProposals({ scope: "agentforge" });
    assert.equal(proposals.total, 1);
    assert.equal(proposals.proposals[0].schemaVersion, "smart-memory-learning-proposal/v1");
    assert.equal(proposals.proposals[0].eventType, "memory_prevented_error");
    const review = brainSmartMemoryReviewProposal({
      proposalId: proposals.proposals[0].proposalId,
      decision: "approved",
      reviewer: "mcp-test",
      reason: "Smart Memory proposal 승인"
    });
    const apply = brainSmartMemoryApplyProposal({
      proposalId: proposals.proposals[0].proposalId,
      appliedBy: "mcp-test",
      reason: "approved proposal 적용"
    });
    const duplicate = brainSmartMemoryApplyProposal({
      proposalId: proposals.proposals[0].proposalId,
      appliedBy: "mcp-test"
    });
    assert.equal(review.proposal.status, "approved");
    assert.equal(review.decision.reviewer, "mcp-test");
    assert.equal(apply.applied, true);
    assert.equal(apply.proposal.status, "applied");
    assert.match(apply.application.status, /^applied/);
    assert.ok(apply.application.policy);
    assert.equal(duplicate.applied, false);
    assert.equal(duplicate.application.applicationId, apply.application.applicationId);
    const policy = brainSmartMemoryPolicy({ scope: "agentforge" });
    assert.equal(policy.policy.scopeId, "agentforge");
    assert.ok(policy.policy.inhibitionSignals.some(signal => signal.signal === "avoid_repeating_existing_capability"));

    const evaluation = brainSmartMemoryEvaluate({ scope: "agentforge", seedDefaults: true });
    assert.equal(evaluation.status, "passed");
    assert.equal(evaluation.total, 2);
    const cases = brainSmartMemoryEvaluationCases({ scope: "agentforge" });
    assert.equal(cases.total, 2);
  });

  it("brain_policy_check는 visibility 차단을 반환한다", () => {
    const result = brainPolicyCheck({
      channelMode: "telegram_multi_agent",
      visibility: "private_user_contextual"
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "visibility_blocked");
  });

  it("brain_growth_candidates는 promotionCandidate 목록을 반환한다", () => {
    seedGrowthCandidate();
    seedGrowthCandidate("other-scope");
    const result = brainGrowthCandidates({ scope: "agentforge" });

    assert.equal(result.total, 1);
    assert.equal(result.candidates[0].scopeId, "agentforge");
    assert.equal(result.candidates[0].promotionCandidate.status, "candidate");
    assert.equal(result.candidates[0].promotionCandidate.candidateType, "playbook_patch");
  });

  it("brain_growth_review_candidate는 candidate를 review하고 목록에서 제외한다", () => {
    seedGrowthCandidate();
    const before = brainGrowthCandidates({ scope: "agentforge" });
    const result = brainGrowthReviewCandidate({
      signalId: before.candidates[0].signalId,
      decision: "dismissed",
      reviewer: "mcp-test",
      reason: "검토 후 반려"
    });
    const after = brainGrowthCandidates({ scope: "agentforge" });

    assert.equal(result.signal.promotionCandidate.status, "dismissed");
    assert.equal(result.decision.decision, "dismissed");
    assert.equal(result.decision.reviewer, "mcp-test");
    assert.equal(after.total, 0);
  });

  it("brain_growth_create_regression_case는 approved candidate에서 회귀 케이스를 만든다", () => {
    seedGrowthCandidate();
    const before = brainGrowthCandidates({ scope: "agentforge" });
    brainGrowthReviewCandidate({
      signalId: before.candidates[0].signalId,
      decision: "approved",
      reviewer: "mcp-test"
    });
    const result = brainGrowthCreateRegressionCase({
      signalId: before.candidates[0].signalId,
      createdBy: "mcp-test",
      reason: "회귀 케이스 생성"
    });
    const duplicate = brainGrowthCreateRegressionCase({
      signalId: before.candidates[0].signalId,
      createdBy: "mcp-test"
    });

    assert.equal(result.created, true);
    assert.equal(result.case.signalId, before.candidates[0].signalId);
    assert.equal(result.case.candidateType, "playbook_patch");
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.case.caseId, result.case.caseId);
  });

  it("brain_growth_run_regression_case는 회귀 케이스 실행 결과를 남긴다", () => {
    seedGrowthCandidate();
    const before = brainGrowthCandidates({ scope: "agentforge" });
    brainGrowthReviewCandidate({
      signalId: before.candidates[0].signalId,
      decision: "approved",
      reviewer: "mcp-test"
    });
    const regression = brainGrowthCreateRegressionCase({
      signalId: before.candidates[0].signalId,
      createdBy: "mcp-test"
    });
    const result = brainGrowthRunRegressionCase({
      caseId: regression.case.caseId,
      runner: "mcp-test",
      reason: "회귀 케이스 실행"
    });

    assert.equal(result.result.status, "passed");
    assert.equal(result.case.status, "executed_passed");
    assert.equal(result.case.lastRun.resultId, result.result.resultId);
  });

  it("brain_growth_create_promotion_proposal은 passed regression case에서 proposal을 만든다", () => {
    seedGrowthCandidate();
    const before = brainGrowthCandidates({ scope: "agentforge" });
    brainGrowthReviewCandidate({
      signalId: before.candidates[0].signalId,
      decision: "approved",
      reviewer: "mcp-test"
    });
    const regression = brainGrowthCreateRegressionCase({
      signalId: before.candidates[0].signalId,
      createdBy: "mcp-test"
    });
    const run = brainGrowthRunRegressionCase({
      caseId: regression.case.caseId,
      runner: "mcp-test"
    });
    const result = brainGrowthCreatePromotionProposal({
      caseId: regression.case.caseId,
      createdBy: "mcp-test",
      reason: "promotion proposal 생성"
    });
    const duplicate = brainGrowthCreatePromotionProposal({
      caseId: regression.case.caseId,
      createdBy: "mcp-test"
    });

    assert.equal(result.created, true);
    assert.equal(result.proposal.caseId, regression.case.caseId);
    assert.equal(result.proposal.gate.lastResultId, run.result.resultId);
    assert.equal(result.proposal.status, "proposal");
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.proposal.proposalId, result.proposal.proposalId);
  });

  it("brain_growth_review_promotion_proposal은 proposal review decision을 남긴다", () => {
    seedGrowthCandidate();
    const before = brainGrowthCandidates({ scope: "agentforge" });
    brainGrowthReviewCandidate({
      signalId: before.candidates[0].signalId,
      decision: "approved",
      reviewer: "mcp-test"
    });
    const regression = brainGrowthCreateRegressionCase({
      signalId: before.candidates[0].signalId,
      createdBy: "mcp-test"
    });
    brainGrowthRunRegressionCase({
      caseId: regression.case.caseId,
      runner: "mcp-test"
    });
    const proposal = brainGrowthCreatePromotionProposal({
      caseId: regression.case.caseId,
      createdBy: "mcp-test"
    });
    const result = brainGrowthReviewPromotionProposal({
      proposalId: proposal.proposal.proposalId,
      decision: "dismissed",
      reviewer: "mcp-test",
      reason: "검토 후 반려"
    });

    assert.equal(result.proposal.status, "dismissed");
    assert.equal(result.decision.decision, "dismissed");
    assert.equal(result.decision.reviewer, "mcp-test");
    assert.throws(() => brainGrowthReviewPromotionProposal({
      proposalId: proposal.proposal.proposalId,
      decision: "approved"
    }), /이미 review된 proposal/);
  });

  it("brain_growth_apply_promotion_proposal은 approved proposal을 적용한다", () => {
    seedGrowthCandidate();
    const before = brainGrowthCandidates({ scope: "agentforge" });
    brainGrowthReviewCandidate({
      signalId: before.candidates[0].signalId,
      decision: "approved",
      reviewer: "mcp-test"
    });
    const regression = brainGrowthCreateRegressionCase({
      signalId: before.candidates[0].signalId,
      createdBy: "mcp-test"
    });
    brainGrowthRunRegressionCase({
      caseId: regression.case.caseId,
      runner: "mcp-test"
    });
    const proposal = brainGrowthCreatePromotionProposal({
      caseId: regression.case.caseId,
      createdBy: "mcp-test"
    });
    brainGrowthReviewPromotionProposal({
      proposalId: proposal.proposal.proposalId,
      decision: "approved",
      reviewer: "mcp-test"
    });
    const result = brainGrowthApplyPromotionProposal({
      proposalId: proposal.proposal.proposalId,
      appliedBy: "mcp-test",
      reason: "approved proposal 적용"
    });
    const duplicate = brainGrowthApplyPromotionProposal({
      proposalId: proposal.proposal.proposalId,
      appliedBy: "mcp-test"
    });

    assert.equal(result.applied, true);
    assert.equal(result.proposal.status, "applied");
    assert.equal(result.promotion.status, "applied");
    assert.equal(result.promotion.appliedTargets[0].type, "active_state_guard_hint");
    assert.equal(duplicate.applied, false);
    assert.equal(duplicate.promotion.promotionId, result.promotion.promotionId);
    const exports = brainGrowthProjectPromotionExports({ scope: "agentforge" });
    const aliasExports = brainGrowthAgentForgePromotionExports({ scope: "agentforge" });
    assert.equal(exports.total, 1);
    assert.equal(exports.adapter, "project");
    assert.equal(exports.promotions[0].target.targetType, "playbook");
    assert.equal(exports.promotions[0].payload.playbook.sourceProposalId, proposal.proposal.proposalId);
    assert.equal(aliasExports.promotions[0].promotionId, exports.promotions[0].promotionId);

    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-mcp-consumer-"));
    try {
      const preview = brainGrowthConsumeProjectPromotionExport({
        scope: "agentforge",
        projectRoot,
        mode: "dry_run",
        promotionId: exports.promotions[0].promotionId,
        adapterRegistry: {
          schemaVersion: "project-adapter-registry/v1",
          projects: {
            agentforge: {
              targets: {
                playbook: {
                  path: "docs/playbook.md",
                  format: "markdown",
                  mode: "append_section"
                }
              }
            }
          }
        },
        requestedBy: "mcp-test"
      });
      assert.equal(preview.status, "preview_ready");
      assert.equal(preview.changes[0].targetType, "playbook");
      assert.equal(preview.changes[0].format, "markdown");
      assert.equal(preview.changes[0].relativePath, path.join("docs", "playbook.md"));
      assert.equal(fs.existsSync(path.join(projectRoot, "docs", "playbook.md")), false);

      const appliedConsumer = brainGrowthConsumeProjectPromotionExport({
        scope: "agentforge",
        projectRoot,
        mode: "apply",
        promotionId: exports.promotions[0].promotionId,
        approvalId: "approval_mcp_consumer",
        adapterRegistry: {
          schemaVersion: "project-adapter-registry/v1",
          projects: {
            agentforge: {
              targets: {
                playbook: {
                  path: "docs/playbook.md",
                  format: "markdown",
                  mode: "append_section"
                }
              }
            }
          }
        },
        requestedBy: "mcp-test"
      });
      assert.equal(appliedConsumer.status, "applied");
      assert.match(fs.readFileSync(path.join(projectRoot, "docs", "playbook.md"), "utf-8"), /brain-promotion:/);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("stdio JSON-RPC initialize/list/call을 처리한다", async () => {
    const serverPath = path.join(__dirname, "..", "src", "mcp-server.js");
    const rpcProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-mcp-rpc-consumer-"));
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, BRAIN_ROOT: testRoot },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    const responses = [];
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", chunk => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        responses.push(JSON.parse(line));
      }
    });

    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "brain_recall",
        arguments: { goal: "밴딩AI HTML 산출물", topK: 3 }
      }
    }) + "\n");
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "brain_brief",
        arguments: {
          project: "agentforge",
          goal: "밴딩AI에 HTML 산출물을 넣으면 좋을까?",
          channelMode: "desktop_claude"
        }
      }
    }) + "\n");
    seedGrowthCandidate();
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "brain_growth_candidates",
        arguments: { scope: "agentforge" }
      }
    }) + "\n");
    const signalId = brainGrowthCandidates({ scope: "agentforge" }).candidates[0].signalId;
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "brain_growth_review_candidate",
        arguments: {
          signalId,
          decision: "approved",
          reviewer: "jsonrpc-test",
          reason: "검토 승인"
        }
      }
    }) + "\n");
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "brain_growth_create_regression_case",
        arguments: {
          signalId,
          createdBy: "jsonrpc-test",
          reason: "회귀 케이스 생성"
        }
      }
    }) + "\n");
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "brain_growth_run_regression_case",
        arguments: {
          caseId: deterministicRegressionCaseId(signalId),
          runner: "jsonrpc-test",
          reason: "회귀 케이스 실행"
        }
      }
    }) + "\n");
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "brain_growth_create_promotion_proposal",
        arguments: {
          caseId: deterministicRegressionCaseId(signalId),
          createdBy: "jsonrpc-test",
          reason: "promotion proposal 생성"
        }
      }
    }) + "\n");
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "brain_growth_review_promotion_proposal",
        arguments: {
          proposalId: deterministicPromotionProposalId(deterministicRegressionCaseId(signalId)),
          decision: "approved",
          reviewer: "jsonrpc-test",
          reason: "promotion proposal 승인"
        }
      }
    }) + "\n");
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "brain_growth_apply_promotion_proposal",
        arguments: {
          proposalId: deterministicPromotionProposalId(deterministicRegressionCaseId(signalId)),
          appliedBy: "jsonrpc-test",
          reason: "approved proposal 적용"
        }
      }
    }) + "\n");
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "brain_growth_project_promotion_exports",
        arguments: { scope: "agentforge" }
      }
    }) + "\n");
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: {
        name: "brain_growth_agentforge_promotion_exports",
        arguments: { scope: "agentforge" }
      }
    }) + "\n");
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: {
        name: "brain_growth_consume_project_promotion_export",
        arguments: {
          scope: "agentforge",
          projectRoot: rpcProjectRoot,
          mode: "dry_run",
          promotionId: deterministicPromotionId(deterministicPromotionProposalId(deterministicRegressionCaseId(signalId))),
          requestedBy: "jsonrpc-test"
        }
      }
    }) + "\n");

    try {
      await new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
          const received = new Set(responses.map(message => message.id));
          if ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].every(id => received.has(id))) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - startedAt > 15000) {
            clearInterval(timer);
            reject(new Error(`MCP 응답 대기 시간 초과: ${Array.from(received).join(",")}`));
          }
        }, 25);
      });
    } finally {
      child.kill();
    }

    assert.equal(responses.find(message => message.id === 1).result.serverInfo.name, "brain-memory-kernel");
    assert.ok(responses.find(message => message.id === 2).result.tools.some(tool => tool.name === "brain_brief"));
    assert.match(responses.find(message => message.id === 3).result.content[0].text, /밴딩AI HTML 산출물/);
    const briefText = responses.find(message => message.id === 4).result.content[0].text;
    const brief = JSON.parse(briefText);
    assert.equal(brief.sections.evidenceDigest.detector.recommendedUse.avoidRepeatingAsNew, true);
    const candidatesText = responses.find(message => message.id === 5).result.content[0].text;
    const candidates = JSON.parse(candidatesText);
    assert.equal(candidates.total, 1);
    assert.equal(candidates.candidates[0].promotionCandidate.candidateType, "playbook_patch");
    const reviewText = responses.find(message => message.id === 6).result.content[0].text;
    const review = JSON.parse(reviewText);
    assert.equal(review.signal.promotionCandidate.status, "approved");
    assert.equal(review.decision.reviewer, "jsonrpc-test");
    const regressionText = responses.find(message => message.id === 7).result.content[0].text;
    const regression = JSON.parse(regressionText);
    assert.equal(regression.created, true);
    assert.equal(regression.case.signalId, signalId);
    assert.equal(regression.case.sourceDecision.status, "approved");
    const runText = responses.find(message => message.id === 8).result.content[0].text;
    const run = JSON.parse(runText);
    assert.equal(run.result.status, "passed");
    assert.equal(run.case.status, "executed_passed");
    const proposalText = responses.find(message => message.id === 9).result.content[0].text;
    const proposal = JSON.parse(proposalText);
    assert.equal(proposal.created, true);
    assert.equal(proposal.proposal.caseId, deterministicRegressionCaseId(signalId));
    assert.equal(proposal.proposal.status, "proposal");
    const proposalReviewText = responses.find(message => message.id === 10).result.content[0].text;
    const proposalReview = JSON.parse(proposalReviewText);
    assert.equal(proposalReview.proposal.status, "approved");
    assert.equal(proposalReview.decision.proposalId, deterministicPromotionProposalId(deterministicRegressionCaseId(signalId)));
    const applyText = responses.find(message => message.id === 11).result.content[0].text;
    const apply = JSON.parse(applyText);
    assert.equal(apply.applied, true);
    assert.equal(apply.proposal.status, "applied");
    assert.equal(apply.promotion.proposalId, deterministicPromotionProposalId(deterministicRegressionCaseId(signalId)));
    const exportText = responses.find(message => message.id === 12).result.content[0].text;
    const exports = JSON.parse(exportText);
    assert.equal(exports.total, 1);
    assert.equal(exports.adapter, "project");
    assert.equal(exports.promotions[0].target.targetType, "playbook");
    const aliasExportText = responses.find(message => message.id === 13).result.content[0].text;
    const aliasExports = JSON.parse(aliasExportText);
    assert.equal(aliasExports.promotions[0].promotionId, exports.promotions[0].promotionId);
    const consumerText = responses.find(message => message.id === 14).result.content[0].text;
    const consumer = JSON.parse(consumerText);
    assert.equal(consumer.status, "preview_ready");
    assert.equal(consumer.changes[0].targetType, "playbook");
    assert.equal(fs.existsSync(path.join(rpcProjectRoot, ".brain-growth", "playbooks.jsonl")), false);
    fs.rmSync(rpcProjectRoot, { recursive: true, force: true });
  });
});
