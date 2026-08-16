"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { readJsonl, writeJsonl } = require("../src/utils");
const { loadActiveState, validateActiveState } = require("../src/active-state");
const { createMemoryBrief } = require("../src/context-assembler");
const { guardDraft } = require("../src/answer-guard");
const { readConsolidationLog } = require("../src/memory-graph");
const {
  applyApprovedGrowthPromotionProposal,
  createGrowthPromotionProposal,
  createGrowthRegressionCase,
  growthPromotionProposalsPath,
  growthRegressionCasesPath,
  listAgentForgePromotionExports,
  listProjectPromotionExports,
  listGrowthCandidateDecisions,
  listGrowthCandidates,
  listGrowthPromotionProposalDecisions,
  listGrowthPromotionProposals,
  listGrowthPromotions,
  listGrowthRegressionCases,
  listGrowthRegressionResults,
  listGrowthSignals,
  runGrowthRegressionCase,
  reviewGrowthCandidate,
  reviewGrowthPromotionProposal
} = require("../src/growth-signal");
const {
  consumeProjectPromotionExport,
  projectAdapterRegistryPath,
  projectPromotionConsumptionsPath
} = require("../src/project-promotion-consumer");
const { getAllowedUserContext } = require("../src/user-ontology");

let testRoot;

function setupRoot() {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-memory-kernel-"));
  fs.mkdirSync(path.join(testRoot, "90_index"), { recursive: true });
  fs.writeFileSync(path.join(testRoot, "90_index", "records_digest.txt"), [
    "# Brain records_digest.txt",
    "rec_proj_agentforge_20260511_0001 | 밴딩AI HTML 산출물 | 밴딩AI는 HTML 산출물을 만들 수 있음 | domain/design,intent/retrieval | active | note | user_confirmed | 2026-05-11T00:00:00.000Z"
  ].join("\n") + "\n", "utf-8");
  writeJsonl(path.join(testRoot, "90_index", "records.jsonl"), []);
}

describe("Memory Kernel PoC modules", () => {
  beforeEach(() => setupRoot());
  afterEach(() => {
    if (testRoot) fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("agentforge Active State는 HTML capability와 출처를 가진다", () => {
    const state = loadActiveState(testRoot, "agentforge");
    const validation = validateActiveState(state);
    assert.equal(validation.passed, true);
    assert.ok(state.capabilities.some(c => c.title.includes("HTML")));
    assert.ok(fs.existsSync(path.join(testRoot, "41_active", "agentforge", "state.json")));
  });

  it("Memory Brief는 Active State, User Ontology, Recall을 구분한다", () => {
    const brief = createMemoryBrief(testRoot, {
      project: "agentforge",
      goal: "신규 오픈소스를 분석해줘",
      userId: "ernham",
      channel: "codex_local",
      topK: 5
    });
    assert.equal(brief.scopeId, "agentforge");
    assert.ok(brief.sections.activeState.capabilities.some(c => c.title.includes("HTML")));
    assert.equal(brief.sections.userOntology.roleAndWorkstyle.role, "기획자");
    assert.ok(Array.isArray(brief.sections.recall));
    assert.ok(Array.isArray(brief.sections.memoryGraph.activatedNodes));
    assert.ok(brief.sections.memoryGraph.activatedNodes.some(node => node.nodeType === "active_state" && node.title.includes("HTML")));
    assert.ok(brief.sections.memoryGraph.inhibitionSignals.some(signal => signal.signal === "avoid_repeating_existing_capability"));
    assert.equal(brief.sections.evidenceDigest.rubric, "ordinal_evidence_strength");
    assert.ok(brief.sections.evidenceDigest.records.some(r => r.analyzer === "active_state"));
    assert.ok(brief.sections.evidenceDigest.records.some(r => r.analyzer === "recall"));
    assert.equal(brief.sections.evidenceDigest.detector.status, "use_with_citations");
    assert.equal(brief.sections.evidenceDigest.detector.recommendedUse.avoidRepeatingAsNew, true);
    assert.ok(brief.sections.evidenceDigest.detector.analyzerCount >= 2);
    assert.ok(brief.sections.evidenceDigest.detector.highConfidenceAnalyzerCount >= 1);
    assert.ok(
      (brief.sections.evidenceDigest.bandCounts.strong || 0)
      + (brief.sections.evidenceDigest.bandCounts.overwhelming || 0) >= 1
    );
    assert.ok(brief.sections.evidenceDigest.records.every(r => r.analyzerRole));
  });

  it("Answer Guard는 기존 HTML 기능을 신규 제안하는 초안을 차단하고 성장 신호를 누적한다", () => {
    const brief = createMemoryBrief(testRoot, {
      project: "agentforge",
      goal: "신규 오픈소스를 분석해줘",
      userId: "ernham"
    });
    const draftText = "이 오픈소스를 활용해 HTML 산출물 기능을 밴딩AI에 추가하면 좋겠습니다.";
    const first = guardDraft(testRoot, { brief, draftText });
    const second = guardDraft(testRoot, { brief, draftText });
    const signals = listGrowthSignals(testRoot, "agentforge");

    assert.equal(first.status, "revise_required");
    assert.equal(second.status, "revise_required");
    assert.ok(first.findings[0].guardReasons.includes("avoid_repeating_as_new"));
    assert.ok(first.findings[0].guardReasons.includes("citation_required"));
    assert.equal(signals.length, 1);
    assert.equal(signals[0].hitCount, 2);
    assert.ok(signals[0].guardReasons.includes("avoid_repeating_as_new"));
    assert.ok(signals[0].guardReasons.includes("citation_required"));
    assert.equal(signals[0].detectorStatus, "use_with_citations");
    assert.ok(Array.isArray(signals[0].detectorReasons));
    assert.equal(signals[0].recommendedUse.avoidRepeatingAsNew, true);
    assert.equal(signals[0].promotionCandidate.status, "candidate");
    assert.equal(signals[0].promotionCandidate.candidateType, "capability_patch");
    assert.equal(signals[0].promotionCandidate.createdFrom, "answer_guard");
    assert.equal(JSON.stringify(signals).includes(draftText), false);

    const candidates = listGrowthCandidates(testRoot, "agentforge");
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].signalId, signals[0].signalId);
    assert.equal(candidates[0].promotionCandidate.candidateType, "capability_patch");
    assert.equal(listGrowthCandidates(testRoot, "other-scope").length, 0);
    assert.equal(JSON.stringify(candidates).includes(draftText), false);

    const review = reviewGrowthCandidate(testRoot, {
      signalId: candidates[0].signalId,
      decision: "approved",
      reviewer: "test",
      reason: "기존 capability 반복 제안 차단 후보 승인"
    });
    assert.equal(review.signal.promotionCandidate.status, "approved");
    assert.equal(review.signal.promotionCandidate.reviewedBy, "test");
    assert.equal(listGrowthCandidates(testRoot, "agentforge").length, 0);

    const decisions = listGrowthCandidateDecisions(testRoot, "agentforge");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decision, "approved");
    assert.equal(decisions[0].signalId, candidates[0].signalId);
    assert.equal(JSON.stringify(decisions).includes(draftText), false);
    assert.throws(() => reviewGrowthCandidate(testRoot, {
      signalId: candidates[0].signalId,
      decision: "dismissed"
    }), /이미 review된 candidate/);

    const regression = createGrowthRegressionCase(testRoot, {
      signalId: candidates[0].signalId,
      createdBy: "test",
      reason: "승인 후보 회귀 케이스 생성"
    });
    const duplicate = createGrowthRegressionCase(testRoot, {
      signalId: candidates[0].signalId,
      createdBy: "test"
    });

    assert.equal(regression.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.case.caseId, regression.case.caseId);
    assert.equal(regression.case.signalId, candidates[0].signalId);
    assert.equal(regression.case.candidateType, "capability_patch");
    assert.ok(regression.case.expectedGuardReasons.includes("avoid_repeating_as_new"));
    assert.equal(regression.case.sourceDecision.status, "approved");
    assert.equal(listGrowthRegressionCases(testRoot, "agentforge").length, 1);
    assert.equal(JSON.stringify(regression).includes(draftText), false);

    const run = runGrowthRegressionCase(testRoot, {
      caseId: regression.case.caseId,
      runner: "test",
      reason: "회귀 케이스 실행"
    });
    assert.equal(run.result.status, "passed");
    assert.equal(run.case.status, "executed_passed");
    assert.equal(run.case.lastRun.resultId, run.result.resultId);
    assert.equal(listGrowthRegressionResults(testRoot, "agentforge").length, 1);
    assert.equal(JSON.stringify(run).includes(draftText), false);

    const proposal = createGrowthPromotionProposal(testRoot, {
      caseId: regression.case.caseId,
      createdBy: "test",
      reason: "통과한 회귀 케이스를 promotion proposal로 전환"
    });
    const duplicateProposal = createGrowthPromotionProposal(testRoot, {
      caseId: regression.case.caseId,
      createdBy: "test"
    });

    assert.equal(proposal.created, true);
    assert.equal(duplicateProposal.created, false);
    assert.equal(duplicateProposal.proposal.proposalId, proposal.proposal.proposalId);
    assert.equal(proposal.proposal.caseId, regression.case.caseId);
    assert.equal(proposal.proposal.gate.lastResultId, run.result.resultId);
    assert.equal(proposal.proposal.status, "proposal");
    assert.equal(listGrowthPromotionProposals(testRoot, "agentforge").length, 1);
    assert.equal(JSON.stringify(proposal).includes(draftText), false);

    const proposalReview = reviewGrowthPromotionProposal(testRoot, {
      proposalId: proposal.proposal.proposalId,
      decision: "approved",
      reviewer: "test",
      reason: "proposal review 승인"
    });

    assert.equal(proposalReview.proposal.status, "approved");
    assert.equal(proposalReview.proposal.reviewedBy, "test");
    assert.equal(proposalReview.decision.decision, "approved");
    assert.equal(proposalReview.decision.proposalId, proposal.proposal.proposalId);
    assert.equal(listGrowthPromotionProposalDecisions(testRoot, "agentforge").length, 1);
    assert.equal(JSON.stringify(proposalReview).includes(draftText), false);
    assert.throws(() => reviewGrowthPromotionProposal(testRoot, {
      proposalId: proposal.proposal.proposalId,
      decision: "dismissed"
    }), /이미 review된 proposal/);

    const applied = applyApprovedGrowthPromotionProposal(testRoot, {
      proposalId: proposal.proposal.proposalId,
      appliedBy: "test",
      reason: "승인 proposal 적용"
    });
    const duplicateApply = applyApprovedGrowthPromotionProposal(testRoot, {
      proposalId: proposal.proposal.proposalId,
      appliedBy: "test"
    });
    const stateAfterApply = loadActiveState(testRoot, "agentforge");

    assert.equal(applied.applied, true);
    assert.equal(applied.proposal.status, "applied");
    assert.equal(applied.promotion.status, "applied");
    assert.equal(applied.promotion.appliedTargets[0].type, "active_state_capability");
    assert.equal(duplicateApply.applied, false);
    assert.equal(duplicateApply.promotion.promotionId, applied.promotion.promotionId);
    assert.equal(listGrowthPromotions(testRoot, "agentforge").length, 1);
    assert.ok(stateAfterApply.capabilities.some(capability => capability.sourceProposalId === proposal.proposal.proposalId));
    const projectExport = listProjectPromotionExports(testRoot, { scopeId: "agentforge" });
    const agentForgeAliasExport = listAgentForgePromotionExports(testRoot, { scopeId: "agentforge" });
    assert.equal(projectExport.adapter, "project");
    assert.equal(projectExport.schemaVersion, "project-promotion-export/v1");
    assert.equal(projectExport.total, 1);
    assert.equal(projectExport.promotions[0].status, "ready_for_project_consumer");
    assert.equal(projectExport.promotions[0].target.targetType, "capability_registry");
    assert.equal(projectExport.promotions[0].payload.capability.sourceProposalId, proposal.proposal.proposalId);
    assert.equal(agentForgeAliasExport.promotions[0].promotionId, projectExport.promotions[0].promotionId);
    assert.equal(JSON.stringify(projectExport).includes(draftText), false);
    assert.equal(JSON.stringify(applied).includes(draftText), false);
  });

  it("Answer Guard는 Detector가 놓친 반복 제안을 Memory Graph inhibition으로 차단한다", () => {
    const brief = createMemoryBrief(testRoot, {
      project: "agentforge",
      goal: "신규 오픈소스를 분석해줘",
      userId: "ernham"
    });
    brief.sections.activeState.capabilities = [];
    brief.sections.evidenceDigest.detector.recommendedUse.avoidRepeatingAsNew = false;

    const result = guardDraft(testRoot, {
      brief,
      draftText: "이 오픈소스를 활용해 HTML 산출물 기능을 밴딩AI에 넣으면 유용합니다."
    });

    assert.equal(result.status, "revise_required");
    assert.equal(result.findings[0].failureType, "known_capability_as_new_suggestion");
    assert.ok(result.findings[0].guardReasons.includes("memory_graph_inhibition"));
    assert.ok(result.findings[0].guardReasons.includes("avoid_repeating_as_new"));

    const consolidation = readConsolidationLog(testRoot);
    const guardLog = consolidation.find(log => log.source === "answer_guard");
    const growthLog = consolidation.find(log => log.source === "growth_signal");
    assert.equal(guardLog.eventType, "guard_result");
    assert.equal(growthLog.eventType, "growth_signal_upsert");
    assert.ok(guardLog.activation.activatedNodeIds.length > 0);
    assert.ok(growthLog.activation.inhibitionSignals.some(signal => signal.signal === "avoid_repeating_existing_capability"));
  });

  it("Regression case executor는 실패 case도 result log를 남긴다", () => {
    const casesPath = growthRegressionCasesPath(testRoot);
    fs.mkdirSync(path.dirname(casesPath), { recursive: true });
    writeJsonl(casesPath, [{
      caseId: "grc_invalid",
      signalId: "sig_invalid",
      scopeId: "agentforge",
      candidateType: "capability_patch",
      failureType: "known_capability_as_new_suggestion",
      sourceDecision: { status: "approved" },
      draftText: "저장되면 안 되는 원문"
    }]);

    const run = runGrowthRegressionCase(testRoot, {
      caseId: "grc_invalid",
      runner: "test"
    });

    assert.equal(run.result.status, "failed");
    assert.ok(run.result.failures.includes("missing_expected_assertions"));
    assert.ok(run.result.failures.includes("draft_text_must_not_be_stored"));
    assert.equal(run.case.status, "executed_failed");
    assert.equal(listGrowthRegressionResults(testRoot, "agentforge").length, 1);
    assert.equal(JSON.stringify(run.result).includes("저장되면 안 되는 원문"), false);
    assert.throws(() => createGrowthPromotionProposal(testRoot, {
      caseId: "grc_invalid"
    }), /passed regression case/);
  });

  it("Approved proposal writer는 approved가 아닌 proposal 적용을 거부한다", () => {
    const proposalsPath = growthPromotionProposalsPath(testRoot);
    fs.mkdirSync(path.dirname(proposalsPath), { recursive: true });
    writeJsonl(proposalsPath, [{
      proposalId: "gpp_needs_changes",
      caseId: "grc_needs_changes",
      signalId: "sig_needs_changes",
      scopeId: "agentforge",
      candidateType: "capability_patch",
      failureType: "known_capability_as_new_suggestion",
      title: "수정 필요 proposal",
      proposedChange: {
        targetType: "capability_patch",
        summary: "아직 적용하면 안 되는 proposal",
        evidenceRefs: ["test/non-approved-proposal"]
      },
      status: "needs_changes",
      createdFrom: "regression_case",
      createdAt: "2026-05-11T00:00:00.000Z"
    }]);

    assert.throws(() => applyApprovedGrowthPromotionProposal(testRoot, {
      proposalId: "gpp_needs_changes",
      appliedBy: "test"
    }), /approved proposal/);
    assert.equal(listGrowthPromotions(testRoot, "agentforge").length, 0);
  });

  it("Project Promotion Export는 특정 프로젝트 scope에 묶여 동작한다", () => {
    const promotionsPath = path.join(testRoot, "47_growth", "promotions.jsonl");
    fs.mkdirSync(path.dirname(promotionsPath), { recursive: true });
    writeJsonl(promotionsPath, [{
      promotionId: "gpr_clo_telegram",
      proposalId: "gpp_clo_telegram",
      caseId: "grc_clo_telegram",
      signalId: "sig_clo_telegram",
      scopeId: "clo-telegram",
      candidateType: "capability_patch",
      failureType: "known_capability_as_new_suggestion",
      title: "텔레그램 브릿지 capability export",
      proposedChange: {
        summary: "텔레그램 브릿지 작업 기억을 capability로 소비한다.",
        evidenceRefs: ["test/project-export"]
      },
      appliedTargets: [{
        type: "active_state_capability",
        scopeId: "clo-telegram",
        id: "clo-telegram.growth.gpp_clo_telegram.capability"
      }],
      status: "applied",
      appliedAt: "2026-05-11T00:00:00.000Z"
    }]);

    const projectExport = listProjectPromotionExports(testRoot, { scopeId: "clo-telegram" });
    const agentForgeAliasExport = listAgentForgePromotionExports(testRoot);

    assert.equal(projectExport.adapter, "project");
    assert.equal(projectExport.scopeId, "clo-telegram");
    assert.equal(projectExport.total, 1);
    assert.equal(projectExport.promotions[0].target.targetType, "capability_registry");
    assert.equal(projectExport.promotions[0].payload.capability.sourceProposalId, "gpp_clo_telegram");
    assert.equal(agentForgeAliasExport.total, 0);
    assert.throws(() => listProjectPromotionExports(testRoot), /scopeId/);
  });

  it("Project Promotion Consumer는 dry-run, 승인 apply, 중복 apply를 구분한다", () => {
    const promotionsPath = path.join(testRoot, "47_growth", "promotions.jsonl");
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-project-consumer-"));
    fs.mkdirSync(path.dirname(promotionsPath), { recursive: true });
    writeJsonl(promotionsPath, [{
      promotionId: "gpr_consumer",
      proposalId: "gpp_consumer",
      caseId: "grc_consumer",
      signalId: "sig_consumer",
      scopeId: "clo-telegram",
      candidateType: "capability_patch",
      failureType: "known_capability_as_new_suggestion",
      title: "프로젝트 Consumer capability",
      proposedChange: {
        summary: "프로젝트 Consumer가 capability를 소비한다.",
        evidenceRefs: ["test/project-consumer"]
      },
      appliedTargets: [{
        type: "active_state_capability",
        scopeId: "clo-telegram",
        id: "clo-telegram.growth.gpp_consumer.capability"
      }],
      status: "applied",
      appliedAt: "2026-05-11T00:00:00.000Z"
    }]);

    try {
      const dryRun = consumeProjectPromotionExport(testRoot, {
        scopeId: "clo-telegram",
        projectRoot,
        mode: "dry_run",
        promotionId: "gpr_consumer",
        requestedBy: "test"
      });

      assert.equal(dryRun.status, "preview_ready");
      assert.equal(dryRun.requiresApproval, true);
      assert.equal(dryRun.changes.length, 1);
      assert.equal(dryRun.changes[0].targetType, "capability_registry");
      assert.equal(fs.existsSync(path.join(projectRoot, ".brain-growth", "capabilities.jsonl")), false);
      assert.equal(readJsonl(projectPromotionConsumptionsPath(testRoot)).length, 1);
      assert.throws(() => consumeProjectPromotionExport(testRoot, {
        scopeId: "clo-telegram",
        projectRoot,
        mode: "apply",
        promotionId: "gpr_consumer"
      }), /approvalId/);

      const applied = consumeProjectPromotionExport(testRoot, {
        scopeId: "clo-telegram",
        projectRoot,
        mode: "apply",
        promotionId: "gpr_consumer",
        approvalId: "approval_consumer",
        requestedBy: "test"
      });
      const targetPath = path.join(projectRoot, ".brain-growth", "capabilities.jsonl");
      const targetRecords = readJsonl(targetPath);

      assert.equal(applied.status, "applied");
      assert.equal(applied.requiresApproval, false);
      assert.equal(targetRecords.length, 1);
      assert.equal(targetRecords[0].promotionId, "gpr_consumer");
      assert.equal(targetRecords[0].approvalId, "approval_consumer");

      const duplicate = consumeProjectPromotionExport(testRoot, {
        scopeId: "clo-telegram",
        projectRoot,
        mode: "apply",
        promotionId: "gpr_consumer",
        approvalId: "approval_consumer",
        requestedBy: "test"
      });
      assert.equal(duplicate.status, "already_consumed");
      assert.equal(readJsonl(targetPath).length, 1);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("Project Promotion Consumer는 scope 불일치와 draft payload를 차단한다", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-project-consumer-block-"));
    const packet = {
      adapter: "project",
      schemaVersion: "project-promotion-export/v1",
      scopeId: "clo-telegram",
      promotions: [{
        promotionId: "gpr_blocked",
        proposalId: "gpp_blocked",
        scopeId: "clo-telegram",
        candidateType: "capability_patch",
        status: "ready_for_project_consumer",
        target: {
          adapter: "project",
          targetType: "capability_registry",
          action: "upsert"
        },
        payload: {
          capability: {
            id: "clo-telegram.growth.gpr_blocked",
            summary: "차단 테스트"
          }
        },
        evidenceRefs: ["test/project-consumer-block"]
      }]
    };

    try {
      const mismatch = consumeProjectPromotionExport(testRoot, {
        scopeId: "other-project",
        projectRoot,
        mode: "dry_run",
        exportPacket: packet
      });
      assert.equal(mismatch.status, "blocked");
      assert.equal(mismatch.blocked[0].reason, "scope_mismatch");

      packet.promotions[0].payload.capability.draftText = "원문 초안은 저장하면 안 된다.";
      const draftBlocked = consumeProjectPromotionExport(testRoot, {
        scopeId: "clo-telegram",
        projectRoot,
        mode: "dry_run",
        exportPacket: packet
      });
      assert.equal(draftBlocked.status, "blocked");
      assert.equal(draftBlocked.blocked[0].reason, "draft_payload_not_allowed");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("Native Adapter Registry는 프로젝트별 json_array target을 사용한다", () => {
    const promotionsPath = path.join(testRoot, "47_growth", "promotions.jsonl");
    const registryPath = projectAdapterRegistryPath(testRoot);
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-native-adapter-"));
    fs.mkdirSync(path.dirname(promotionsPath), { recursive: true });
    writeJsonl(promotionsPath, [{
      promotionId: "gpr_native",
      proposalId: "gpp_native",
      caseId: "grc_native",
      signalId: "sig_native",
      scopeId: "clo-telegram",
      candidateType: "capability_patch",
      failureType: "known_capability_as_new_suggestion",
      title: "Native capability",
      proposedChange: {
        summary: "native capability registry에 반영한다.",
        evidenceRefs: ["test/native-adapter"]
      },
      appliedTargets: [{
        type: "active_state_capability",
        scopeId: "clo-telegram",
        id: "clo-telegram.growth.gpp_native.capability"
      }],
      status: "applied",
      appliedAt: "2026-05-11T00:00:00.000Z"
    }]);
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify({
      schemaVersion: "project-adapter-registry/v1",
      projects: {
        "clo-telegram": {
          targets: {
            capability_registry: {
              path: "native/capabilities.json",
              format: "json_array",
              mode: "upsert",
              key: "id"
            }
          }
        }
      }
    }, null, 2), "utf-8");

    try {
      const dryRun = consumeProjectPromotionExport(testRoot, {
        scopeId: "clo-telegram",
        projectRoot,
        mode: "dry_run",
        promotionId: "gpr_native",
        requestedBy: "test"
      });

      assert.equal(dryRun.status, "preview_ready");
      assert.equal(dryRun.changes[0].native, true);
      assert.equal(dryRun.changes[0].format, "json_array");
      assert.equal(dryRun.changes[0].relativePath, path.join("native", "capabilities.json"));
      assert.equal(fs.existsSync(path.join(projectRoot, "native", "capabilities.json")), false);

      const applied = consumeProjectPromotionExport(testRoot, {
        scopeId: "clo-telegram",
        projectRoot,
        mode: "apply",
        promotionId: "gpr_native",
        approvalId: "approval_native",
        requestedBy: "test"
      });
      const nativeRecords = JSON.parse(fs.readFileSync(path.join(projectRoot, "native", "capabilities.json"), "utf-8"));

      assert.equal(applied.status, "applied");
      assert.equal(nativeRecords.length, 1);
      assert.equal(nativeRecords[0].promotionId, "gpr_native");
      assert.equal(nativeRecords[0].approvalId, "approval_native");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("Native Adapter Registry는 markdown target과 projectRoot 밖 경로 차단을 지원한다", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-native-markdown-"));
    const packet = {
      adapter: "project",
      schemaVersion: "project-promotion-export/v1",
      scopeId: "agentforge",
      promotions: [{
        promotionId: "gpr_markdown",
        proposalId: "gpp_markdown",
        scopeId: "agentforge",
        candidateType: "playbook_patch",
        failureType: "direct_user_coding_instruction",
        title: "직접 실행 playbook",
        status: "ready_for_project_consumer",
        target: {
          adapter: "project",
          targetType: "playbook",
          action: "upsert"
        },
        payload: {
          playbook: {
            id: "agentforge.growth.gpr_markdown",
            rule: "에이전트가 직접 실행하고 증거를 보고한다.",
            appliesWhen: ["direct_user_coding_instruction"],
            sourceRefs: ["test/native-markdown"]
          }
        },
        evidenceRefs: ["test/native-markdown"]
      }]
    };

    try {
      const applied = consumeProjectPromotionExport(testRoot, {
        scopeId: "agentforge",
        projectRoot,
        mode: "apply",
        approvalId: "approval_markdown",
        exportPacket: packet,
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
        }
      });
      const markdown = fs.readFileSync(path.join(projectRoot, "docs", "playbook.md"), "utf-8");

      assert.equal(applied.status, "applied");
      assert.match(markdown, /brain-promotion:gpr_markdown/);
      assert.match(markdown, /직접 실행 playbook/);

      const outsidePacket = JSON.parse(JSON.stringify(packet));
      outsidePacket.promotions[0].promotionId = "gpr_markdown_outside";
      outsidePacket.promotions[0].proposalId = "gpp_markdown_outside";
      const outside = consumeProjectPromotionExport(testRoot, {
        scopeId: "agentforge",
        projectRoot,
        mode: "dry_run",
        exportPacket: outsidePacket,
        adapterRegistry: {
          schemaVersion: "project-adapter-registry/v1",
          projects: {
            agentforge: {
              targets: {
                playbook: {
                  path: "../outside.md",
                  format: "markdown"
                }
              }
            }
          }
        }
      });

      assert.equal(outside.status, "blocked");
      assert.match(outside.blocked[0].reason, /projectRoot 밖/);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("Native Adapter Registry는 TypeScript와 YAML managed block target을 쓴다", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-native-ts-yaml-"));
    const packet = {
      adapter: "project",
      schemaVersion: "project-promotion-export/v1",
      scopeId: "brain",
      promotions: [{
        promotionId: "gpr_ts_one",
        proposalId: "gpp_ts_one",
        scopeId: "brain",
        candidateType: "capability_patch",
        failureType: "known_capability_as_new_suggestion",
        title: "TS capability one",
        status: "ready_for_project_consumer",
        target: {
          adapter: "project",
          targetType: "capability_registry",
          action: "upsert"
        },
        payload: {
          capability: {
            id: "brain.growth.gpr_ts_one",
            summary: "TypeScript registry에 반영된다.",
            sourceRefs: ["test/native-ts"]
          }
        },
        evidenceRefs: ["test/native-ts"]
      }, {
        promotionId: "gpr_ts_two",
        proposalId: "gpp_ts_two",
        scopeId: "brain",
        candidateType: "capability_patch",
        failureType: "known_capability_as_new_suggestion",
        title: "TS capability two",
        status: "ready_for_project_consumer",
        target: {
          adapter: "project",
          targetType: "capability_registry",
          action: "upsert"
        },
        payload: {
          capability: {
            id: "brain.growth.gpr_ts_two",
            summary: "같은 TypeScript block에 누적된다.",
            sourceRefs: ["test/native-ts"]
          }
        },
        evidenceRefs: ["test/native-ts"]
      }, {
        promotionId: "gpr_yaml",
        proposalId: "gpp_yaml",
        scopeId: "brain",
        candidateType: "workflow_patch",
        failureType: "missing_workflow",
        title: "YAML workflow",
        status: "ready_for_project_consumer",
        target: {
          adapter: "project",
          targetType: "workflow",
          action: "upsert"
        },
        payload: {
          workflow: {
            id: "brain.growth.gpr_yaml",
            summary: "YAML workflow에 반영된다.",
            steps: ["prepare", "verify"]
          }
        },
        evidenceRefs: ["test/native-yaml"]
      }]
    };

    try {
      const dryRun = consumeProjectPromotionExport(testRoot, {
        scopeId: "brain",
        projectRoot,
        mode: "dry_run",
        exportPacket: packet,
        adapterRegistry: {
          schemaVersion: "project-adapter-registry/v1",
          projects: {
            brain: {
              targets: {
                capability_registry: {
                  path: "src/capabilities.ts",
                  format: "typescript",
                  exportName: "capabilities",
                  key: "id"
                },
                workflow: {
                  path: "config/workflows.yaml",
                  format: "yaml",
                  collectionKey: "workflows",
                  key: "id"
                }
              }
            }
          }
        }
      });

      assert.equal(dryRun.status, "preview_ready");
      assert.equal(dryRun.changes.length, 3);
      assert.equal(dryRun.changes[0].format, "typescript");
      assert.equal(dryRun.changes[0].exportName, "capabilities");
      assert.equal(dryRun.changes[2].format, "yaml");
      assert.equal(dryRun.changes[2].collectionKey, "workflows");
      assert.equal(fs.existsSync(path.join(projectRoot, "src", "capabilities.ts")), false);

      const applied = consumeProjectPromotionExport(testRoot, {
        scopeId: "brain",
        projectRoot,
        mode: "apply",
        approvalId: "approval_ts_yaml",
        exportPacket: packet,
        adapterRegistry: {
          schemaVersion: "project-adapter-registry/v1",
          projects: {
            brain: {
              targets: {
                capability_registry: {
                  path: "src/capabilities.ts",
                  format: "typescript",
                  exportName: "capabilities",
                  key: "id"
                },
                workflow: {
                  path: "config/workflows.yaml",
                  format: "yaml",
                  collectionKey: "workflows",
                  key: "id"
                }
              }
            }
          }
        }
      });
      const typescript = fs.readFileSync(path.join(projectRoot, "src", "capabilities.ts"), "utf-8");
      const yaml = fs.readFileSync(path.join(projectRoot, "config", "workflows.yaml"), "utf-8");

      assert.equal(applied.status, "applied");
      assert.match(typescript, /brain-promotion-managed:start capabilities/);
      assert.match(typescript, /export const capabilities = \[/);
      assert.match(typescript, /gpr_ts_one/);
      assert.match(typescript, /gpr_ts_two/);
      assert.match(yaml, /brain-promotion-managed:start workflows/);
      assert.match(yaml, /workflows:/);
      assert.match(yaml, /promotionId: gpr_yaml/);
      assert.match(yaml, /- prepare/);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("TypeScript native writer는 기존 수동 export 배열을 managed block으로 흡수한다", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-native-ts-adopt-"));
    const targetPath = path.join(projectRoot, "src", "capabilities.ts");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, [
      "export const capabilities = [",
      "  {",
      "    id: \"brain.manual.capability\",",
      "    summary: \"수동으로 작성된 capability\",",
      "    sourceRefs: [\"manual/source\"]",
      "  }",
      "];",
      ""
    ].join("\n"), "utf-8");
    const packet = {
      adapter: "project",
      schemaVersion: "project-promotion-export/v1",
      scopeId: "brain",
      promotions: [{
        promotionId: "gpr_ts_adopt",
        proposalId: "gpp_ts_adopt",
        scopeId: "brain",
        candidateType: "capability_patch",
        failureType: "known_capability_as_new_suggestion",
        title: "Adopted TS capability",
        status: "ready_for_project_consumer",
        target: {
          adapter: "project",
          targetType: "capability_registry",
          action: "upsert"
        },
        payload: {
          capability: {
            id: "brain.growth.gpr_ts_adopt",
            summary: "기존 배열에 병합되는 capability"
          }
        },
        evidenceRefs: ["test/native-ts-adopt"]
      }]
    };

    try {
      const applied = consumeProjectPromotionExport(testRoot, {
        scopeId: "brain",
        projectRoot,
        mode: "apply",
        approvalId: "approval_ts_adopt",
        exportPacket: packet,
        adapterRegistry: {
          schemaVersion: "project-adapter-registry/v1",
          projects: {
            brain: {
              targets: {
                capability_registry: {
                  path: "src/capabilities.ts",
                  format: "typescript",
                  exportName: "capabilities",
                  key: "id"
                }
              }
            }
          }
        }
      });
      const typescript = fs.readFileSync(targetPath, "utf-8");
      const exportCount = (typescript.match(/export const capabilities =/g) || []).length;

      assert.equal(applied.status, "applied");
      assert.equal(exportCount, 1);
      assert.match(typescript, /brain-promotion-managed:start capabilities/);
      assert.match(typescript, /brain\.manual\.capability/);
      assert.match(typescript, /brain\.growth\.gpr_ts_adopt/);
      assert.match(typescript, /manual\/source/);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("YAML native writer는 기존 수동 collection을 managed block으로 흡수한다", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-native-yaml-adopt-"));
    const targetPath = path.join(projectRoot, "config", "workflows.yaml");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, [
      "version: 1",
      "workflows:",
      "  - id: brain.manual.workflow",
      "    summary: 수동으로 작성된 workflow",
      "    steps:",
      "      - manual",
      "metadata:",
      "  owner: brain",
      ""
    ].join("\n"), "utf-8");
    const packet = {
      adapter: "project",
      schemaVersion: "project-promotion-export/v1",
      scopeId: "brain",
      promotions: [{
        promotionId: "gpr_yaml_adopt",
        proposalId: "gpp_yaml_adopt",
        scopeId: "brain",
        candidateType: "workflow_patch",
        failureType: "missing_workflow",
        title: "Adopted YAML workflow",
        status: "ready_for_project_consumer",
        target: {
          adapter: "project",
          targetType: "workflow",
          action: "upsert"
        },
        payload: {
          workflow: {
            id: "brain.growth.gpr_yaml_adopt",
            summary: "기존 collection에 병합되는 workflow",
            steps: ["prepare", "verify"]
          }
        },
        evidenceRefs: ["test/native-yaml-adopt"]
      }]
    };

    try {
      const applied = consumeProjectPromotionExport(testRoot, {
        scopeId: "brain",
        projectRoot,
        mode: "apply",
        approvalId: "approval_yaml_adopt",
        exportPacket: packet,
        adapterRegistry: {
          schemaVersion: "project-adapter-registry/v1",
          projects: {
            brain: {
              targets: {
                workflow: {
                  path: "config/workflows.yaml",
                  format: "yaml",
                  collectionKey: "workflows",
                  key: "id"
                }
              }
            }
          }
        }
      });
      const yaml = fs.readFileSync(targetPath, "utf-8");
      const workflowsCount = (yaml.match(/^workflows:/gm) || []).length;

      assert.equal(applied.status, "applied");
      assert.equal(workflowsCount, 1);
      assert.match(yaml, /brain-promotion-managed:start workflows/);
      assert.match(yaml, /brain\.manual\.workflow/);
      assert.match(yaml, /brain\.growth\.gpr_yaml_adopt/);
      assert.match(yaml, /- manual/);
      assert.match(yaml, /metadata:/);
      assert.match(yaml, /owner: brain/);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("Project Promotion Consumer는 apply pipeline verification을 강제한다", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-apply-pipeline-"));
    const packet = {
      adapter: "project",
      schemaVersion: "project-promotion-export/v1",
      scopeId: "brain",
      promotions: [{
        promotionId: "gpr_pipeline",
        proposalId: "gpp_pipeline",
        scopeId: "brain",
        candidateType: "capability_patch",
        failureType: "known_capability_as_new_suggestion",
        title: "Pipeline gated capability",
        status: "ready_for_project_consumer",
        target: {
          adapter: "project",
          targetType: "capability_registry",
          action: "upsert"
        },
        payload: {
          capability: {
            id: "brain.growth.gpr_pipeline",
            summary: "검증 통과 후 적용된다."
          }
        },
        evidenceRefs: ["test/apply-pipeline"]
      }]
    };
    const adapterRegistry = {
      schemaVersion: "project-adapter-registry/v1",
      projects: {
        brain: {
          applyPipeline: {
            required: true,
            requiredChecks: ["npm test"]
          },
          targets: {
            capability_registry: {
              path: "native/capabilities.json",
              format: "json_array",
              mode: "upsert",
              key: "id"
            }
          }
        }
      }
    };

    try {
      const missingVerification = consumeProjectPromotionExport(testRoot, {
        scopeId: "brain",
        projectRoot,
        mode: "apply",
        approvalId: "approval_pipeline",
        exportPacket: packet,
        adapterRegistry
      });

      assert.equal(missingVerification.status, "verification_required");
      assert.equal(missingVerification.requiresVerification, true);
      assert.equal(missingVerification.pipelineGate.status, "missing");
      assert.equal(fs.existsSync(path.join(projectRoot, "native", "capabilities.json")), false);

      const failedVerification = consumeProjectPromotionExport(testRoot, {
        scopeId: "brain",
        projectRoot,
        mode: "apply",
        approvalId: "approval_pipeline",
        exportPacket: packet,
        adapterRegistry,
        verification: {
          schemaVersion: "project-apply-verification/v1",
          checks: [{ name: "npm test", status: "failed", evidence: "1 fail" }]
        }
      });

      assert.equal(failedVerification.status, "verification_failed");
      assert.equal(failedVerification.pipelineGate.failedChecks[0], "npm test");
      assert.equal(fs.existsSync(path.join(projectRoot, "native", "capabilities.json")), false);

      const applied = consumeProjectPromotionExport(testRoot, {
        scopeId: "brain",
        projectRoot,
        mode: "apply",
        approvalId: "approval_pipeline",
        exportPacket: packet,
        adapterRegistry,
        verification: {
          schemaVersion: "project-apply-verification/v1",
          checks: [{ name: "npm test", command: "npm test", status: "passed", evidence: "595 pass / 0 fail" }]
        }
      });
      const targetRecords = JSON.parse(fs.readFileSync(path.join(projectRoot, "native", "capabilities.json"), "utf-8"));
      const consumptionRecords = readJsonl(projectPromotionConsumptionsPath(testRoot));

      assert.equal(applied.status, "applied");
      assert.equal(applied.pipelineGate.status, "passed");
      assert.equal(targetRecords.length, 1);
      assert.equal(targetRecords[0].promotionId, "gpr_pipeline");
      assert.equal(consumptionRecords[consumptionRecords.length - 1].pipelineGate.status, "passed");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("Project Promotion Consumer runner는 runChecks를 실행해 apply 여부를 결정한다", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-verification-runner-"));
    const packet = {
      adapter: "project",
      schemaVersion: "project-promotion-export/v1",
      scopeId: "brain",
      promotions: [{
        promotionId: "gpr_runner",
        proposalId: "gpp_runner",
        scopeId: "brain",
        candidateType: "capability_patch",
        failureType: "known_capability_as_new_suggestion",
        title: "Runner gated capability",
        status: "ready_for_project_consumer",
        target: {
          adapter: "project",
          targetType: "capability_registry",
          action: "upsert"
        },
        payload: {
          capability: {
            id: "brain.growth.gpr_runner",
            summary: "runner 통과 후 적용된다."
          }
        },
        evidenceRefs: ["test/verification-runner"]
      }]
    };

    try {
      const failed = consumeProjectPromotionExport(testRoot, {
        scopeId: "brain",
        projectRoot,
        mode: "apply",
        approvalId: "approval_runner",
        exportPacket: packet,
        runVerification: true,
        adapterRegistry: {
          schemaVersion: "project-adapter-registry/v1",
          projects: {
            brain: {
              applyPipeline: {
                required: true,
                requiredChecks: ["node smoke"],
                runChecks: [{
                  name: "node smoke",
                  command: process.execPath,
                  args: ["-e", "process.exit(1)"],
                  timeoutMs: 5000
                }]
              },
              targets: {
                capability_registry: {
                  path: "native/capabilities.json",
                  format: "json_array",
                  mode: "upsert",
                  key: "id"
                }
              }
            }
          }
        }
      });

      assert.equal(failed.status, "verification_failed");
      assert.equal(failed.pipelineGate.checks[0].name, "node smoke");
      assert.equal(failed.pipelineGate.checks[0].status, "failed");
      assert.equal(fs.existsSync(path.join(projectRoot, "native", "capabilities.json")), false);

      const applied = consumeProjectPromotionExport(testRoot, {
        scopeId: "brain",
        projectRoot,
        mode: "apply",
        approvalId: "approval_runner",
        exportPacket: packet,
        runVerification: true,
        adapterRegistry: {
          schemaVersion: "project-adapter-registry/v1",
          projects: {
            brain: {
              applyPipeline: {
                required: true,
                requiredChecks: ["node smoke"],
                runChecks: [{
                  name: "node smoke",
                  command: process.execPath,
                  args: ["-e", "process.exit(0)"],
                  timeoutMs: 5000
                }]
              },
              targets: {
                capability_registry: {
                  path: "native/capabilities.json",
                  format: "json_array",
                  mode: "upsert",
                  key: "id"
                }
              }
            }
          }
        }
      });
      const targetRecords = JSON.parse(fs.readFileSync(path.join(projectRoot, "native", "capabilities.json"), "utf-8"));

      assert.equal(applied.status, "applied");
      assert.equal(applied.pipelineGate.status, "passed");
      assert.equal(applied.pipelineGate.checks[0].status, "passed");
      assert.equal(targetRecords[0].promotionId, "gpr_runner");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("Project Promotion Consumer는 post-apply 검증 실패 시 target 파일을 복원한다", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-post-apply-runner-"));
    const targetPath = path.join(projectRoot, "native", "capabilities.json");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify([{
      id: "brain.existing",
      promotionId: "existing",
      summary: "기존 파일 내용"
    }], null, 2) + "\n", "utf-8");
    const originalContent = fs.readFileSync(targetPath, "utf-8");
    const packet = {
      adapter: "project",
      schemaVersion: "project-promotion-export/v1",
      scopeId: "brain",
      promotions: [{
        promotionId: "gpr_post_apply",
        proposalId: "gpp_post_apply",
        scopeId: "brain",
        candidateType: "capability_patch",
        failureType: "known_capability_as_new_suggestion",
        title: "Post apply gated capability",
        status: "ready_for_project_consumer",
        target: {
          adapter: "project",
          targetType: "capability_registry",
          action: "upsert"
        },
        payload: {
          capability: {
            id: "brain.growth.gpr_post_apply",
            summary: "post apply 검증 통과 후 유지된다."
          }
        },
        evidenceRefs: ["test/post-apply-runner"]
      }]
    };
    const registryWithPostCheck = exitCode => ({
      schemaVersion: "project-adapter-registry/v1",
      projects: {
        brain: {
          applyPipeline: {
            postApplyRequired: true,
            postApplyRequiredChecks: ["post smoke"],
            postApplyRunChecks: [{
              name: "post smoke",
              command: process.execPath,
              args: ["-e", `process.exit(${exitCode})`],
              timeoutMs: 5000
            }]
          },
          targets: {
            capability_registry: {
              path: "native/capabilities.json",
              format: "json_array",
              mode: "upsert",
              key: "id"
            }
          }
        }
      }
    });

    try {
      const missingRunPermission = consumeProjectPromotionExport(testRoot, {
        scopeId: "brain",
        projectRoot,
        mode: "apply",
        approvalId: "approval_post_apply",
        exportPacket: packet,
        adapterRegistry: registryWithPostCheck(0)
      });

      assert.equal(missingRunPermission.status, "post_verification_required");
      assert.equal(missingRunPermission.requiresPostApplyVerification, true);
      assert.equal(fs.readFileSync(targetPath, "utf-8"), originalContent);

      const failed = consumeProjectPromotionExport(testRoot, {
        scopeId: "brain",
        projectRoot,
        mode: "apply",
        approvalId: "approval_post_apply",
        exportPacket: packet,
        runVerification: true,
        adapterRegistry: registryWithPostCheck(1)
      });
      const failedLog = readJsonl(projectPromotionConsumptionsPath(testRoot)).at(-1);

      assert.equal(failed.status, "post_verification_failed");
      assert.equal(failed.postApplyGate.status, "failed");
      assert.equal(failed.rolledBackPaths[0], targetPath);
      assert.equal(fs.readFileSync(targetPath, "utf-8"), originalContent);
      assert.deepEqual(failedLog.changedPaths, []);
      assert.equal(failedLog.postApplyGate.status, "failed");
      assert.equal(failedLog.rolledBackPaths[0], targetPath);
      assert.equal(failed.remediationSignal.failureType, "post_apply_verification_failed");
      assert.equal(failed.remediationSignal.source, "project_promotion_consumer");
      assert.equal(failed.remediationSignal.promotionCandidate.status, "candidate");
      assert.equal(failed.remediationSignal.promotionCandidate.createdFrom, "project_promotion_consumer");
      assert.equal(failed.remediationSignal.recommendedUse.requireReview, true);
      assert.ok(failed.remediationSignal.evidenceRefs.includes("promotion:gpr_post_apply"));
      assert.ok(failed.remediationSignal.evidenceRefs.includes(`rolledBack:${path.join("native", "capabilities.json")}`));

      const remediationSignal = listGrowthSignals(testRoot, "brain")
        .find(signal => signal.failureType === "post_apply_verification_failed");
      assert.ok(remediationSignal);
      assert.equal(remediationSignal.promotionCandidate.candidateType, "playbook_patch");
      assert.ok(remediationSignal.detectorReasons.includes("verification_check_failed:post smoke"));
      assert.equal(listGrowthRegressionCases(testRoot, "brain").length, 0);
      assert.equal(listGrowthRegressionResults(testRoot, "brain").length, 0);
      assert.equal(listGrowthPromotionProposals(testRoot, "brain").length, 0);

      const remediationReview = reviewGrowthCandidate(testRoot, {
        signalId: remediationSignal.signalId,
        decision: "approved",
        reviewer: "test",
        reason: "post-apply 실패 재현 케이스 필요"
      });
      assert.equal(remediationReview.regressionCaseCreated, true);
      assert.equal(remediationReview.regressionExecuted, true);
      assert.equal(remediationReview.regressionCase.signalId, remediationSignal.signalId);
      assert.equal(remediationReview.regressionCase.status, "executed_passed");
      assert.equal(remediationReview.regressionCase.sourceDecision.status, "approved");
      assert.equal(remediationReview.regressionCase.createdBy, "test");
      assert.equal(remediationReview.regressionResult.status, "passed");
      assert.equal(remediationReview.regressionResult.runner, "growth_candidate_review");
      assert.equal(listGrowthRegressionResults(testRoot, "brain").length, 1);
      assert.equal(remediationReview.promotionProposalCreated, true);
      assert.equal(remediationReview.promotionProposal.caseId, remediationReview.regressionCase.caseId);
      assert.equal(remediationReview.promotionProposal.status, "proposal");
      assert.equal(remediationReview.promotionProposal.gate.lastRunStatus, "passed");

      const duplicateRegression = createGrowthRegressionCase(testRoot, {
        signalId: remediationSignal.signalId,
        createdBy: "test"
      });
      assert.equal(duplicateRegression.created, false);
      assert.equal(duplicateRegression.case.caseId, remediationReview.regressionCase.caseId);
      const duplicateProposal = createGrowthPromotionProposal(testRoot, {
        caseId: remediationReview.regressionCase.caseId,
        createdBy: "test"
      });
      assert.equal(duplicateProposal.created, false);
      assert.equal(duplicateProposal.proposal.proposalId, remediationReview.promotionProposal.proposalId);

      const applied = consumeProjectPromotionExport(testRoot, {
        scopeId: "brain",
        projectRoot,
        mode: "apply",
        approvalId: "approval_post_apply",
        exportPacket: packet,
        runVerification: true,
        adapterRegistry: registryWithPostCheck(0)
      });
      const targetRecords = JSON.parse(fs.readFileSync(targetPath, "utf-8"));

      assert.equal(applied.status, "applied");
      assert.equal(applied.postApplyGate.status, "passed");
      assert.equal(targetRecords.length, 2);
      assert.equal(targetRecords[1].promotionId, "gpr_post_apply");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("Answer Guard는 Detector의 review 요구를 판정 상태에 반영한다", () => {
    const brief = createMemoryBrief(testRoot, {
      project: "agentforge",
      goal: "근거가 약한 기억을 검토해줘",
      userId: "ernham"
    });
    brief.sections.evidenceDigest.detector.recommendedUse.requireReview = true;
    const result = guardDraft(testRoot, {
      brief,
      draftText: "기존 내용을 바탕으로 검토하겠습니다."
    });

    assert.equal(result.status, "review_recommended");
    assert.deepEqual(result.findings, []);
  });

  it("Answer Guard는 review/citation 기반 반복 finding을 playbook 후보로 남긴다", () => {
    const brief = createMemoryBrief(testRoot, {
      project: "agentforge",
      goal: "근거와 검토가 필요한 답변을 확인해줘",
      userId: "ernham"
    });
    brief.sections.evidenceDigest.detector.recommendedUse.requireReview = true;
    brief.sections.evidenceDigest.detector.reasons.push("manual_review_required");

    const draftText = "이사님이 터미널에서 npm test 실행하세요.";
    const first = guardDraft(testRoot, { brief, draftText });
    const second = guardDraft(testRoot, { brief, draftText });
    const signal = listGrowthSignals(testRoot, "agentforge")
      .find(item => item.failureType === "direct_user_coding_instruction");

    assert.equal(first.status, "revise_required");
    assert.equal(second.status, "revise_required");
    assert.ok(signal);
    assert.equal(signal.hitCount, 2);
    assert.ok(signal.guardReasons.includes("review_required"));
    assert.ok(signal.guardReasons.includes("citation_required"));
    assert.ok(signal.detectorReasons.includes("manual_review_required"));
    assert.equal(signal.recommendedUse.requireReview, true);
    assert.equal(signal.promotionCandidate.status, "candidate");
    assert.equal(signal.promotionCandidate.candidateType, "playbook_patch");
    assert.equal(JSON.stringify(signal).includes(draftText), false);

    const candidates = listGrowthCandidates(testRoot, "agentforge");
    const candidate = candidates.find(item => item.failureType === "direct_user_coding_instruction");
    assert.ok(candidate);
    assert.equal(candidate.promotionCandidate.candidateType, "playbook_patch");
    assert.ok(candidate.guardReasons.includes("review_required"));
    assert.equal(JSON.stringify(candidate).includes(draftText), false);
    assert.throws(() => createGrowthRegressionCase(testRoot, {
      signalId: candidate.signalId
    }), /approved candidate/);

    const review = reviewGrowthCandidate(testRoot, {
      signalId: candidate.signalId,
      decision: "approved",
      reviewer: "test"
    });
    assert.equal(review.regressionCase, null);
    assert.equal(review.regressionCaseCreated, false);
    assert.equal(review.regressionResult, null);
    assert.equal(review.regressionExecuted, false);
    assert.equal(review.promotionProposal, null);
    assert.equal(review.promotionProposalCreated, false);
    const regression = createGrowthRegressionCase(testRoot, {
      signalId: candidate.signalId,
      createdBy: "test"
    });
    runGrowthRegressionCase(testRoot, {
      caseId: regression.case.caseId,
      runner: "test"
    });
    const proposal = createGrowthPromotionProposal(testRoot, {
      caseId: regression.case.caseId,
      createdBy: "test"
    });
    reviewGrowthPromotionProposal(testRoot, {
      proposalId: proposal.proposal.proposalId,
      decision: "approved",
      reviewer: "test"
    });
    const applied = applyApprovedGrowthPromotionProposal(testRoot, {
      proposalId: proposal.proposal.proposalId,
      appliedBy: "test"
    });
    const stateAfterApply = loadActiveState(testRoot, "agentforge");

    assert.equal(applied.promotion.appliedTargets[0].type, "active_state_guard_hint");
    assert.ok(stateAfterApply.guardHints.some(hint => hint.sourceProposalId === proposal.proposal.proposalId));
    const projectExport = listProjectPromotionExports(testRoot, {
      scopeId: "agentforge",
      candidateType: "playbook_patch"
    });
    assert.equal(projectExport.total, 1);
    assert.equal(projectExport.promotions[0].target.targetType, "playbook");
    assert.ok(projectExport.promotions[0].payload.playbook.appliesWhen.includes("direct_user_coding_instruction"));
    assert.equal(JSON.stringify(applied).includes(draftText), false);
  });

  it("User Ontology는 그룹 채널에서 private_context를 제외한다", () => {
    const context = getAllowedUserContext(testRoot, {
      userId: "ernham",
      channel: "telegram_group",
      channelMode: "group"
    });
    assert.equal(context.roleAndWorkstyle.name, "고광웅");
    assert.ok(context.omitted.includes("private_context"));
    assert.deepEqual(context.sensitive, []);
  });
});
