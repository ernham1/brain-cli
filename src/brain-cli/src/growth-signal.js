"use strict";

const path = require("path");
const crypto = require("crypto");
const { ensureDir, isoNow, readJsonl, writeJsonl } = require("./utils");
const { loadActiveState, saveActiveState } = require("./active-state");
const { appendConsolidationLog } = require("./memory-graph");

function growthSignalsPath(brainRoot) {
  return path.join(brainRoot, "47_growth", "signals.jsonl");
}

function growthCandidateDecisionsPath(brainRoot) {
  return path.join(brainRoot, "47_growth", "candidate-decisions.jsonl");
}

function growthRegressionCasesPath(brainRoot) {
  return path.join(brainRoot, "47_growth", "regression-cases.jsonl");
}

function growthRegressionResultsPath(brainRoot) {
  return path.join(brainRoot, "47_growth", "regression-results.jsonl");
}

function growthPromotionProposalsPath(brainRoot) {
  return path.join(brainRoot, "47_growth", "promotion-proposals.jsonl");
}

function growthPromotionProposalDecisionsPath(brainRoot) {
  return path.join(brainRoot, "47_growth", "promotion-proposal-decisions.jsonl");
}

function growthPromotionsPath(brainRoot) {
  return path.join(brainRoot, "47_growth", "promotions.jsonl");
}

function stableSignalId(scopeId, failureType, summary) {
  const digest = crypto
    .createHash("sha1")
    .update(`${scopeId}:${failureType}:${summary}`.toLowerCase())
    .digest("hex")
    .slice(0, 12);
  return `sig_${digest}`;
}

function regressionCaseId(signalId) {
  const digest = crypto
    .createHash("sha1")
    .update(`regression:${signalId}`)
    .digest("hex")
    .slice(0, 12);
  return `grc_${digest}`;
}

function regressionResultId(caseId, createdAt) {
  const digest = crypto
    .createHash("sha1")
    .update(`regression-result:${caseId}:${createdAt}`)
    .digest("hex")
    .slice(0, 12);
  return `grr_${digest}`;
}

function promotionProposalId(caseId) {
  const digest = crypto
    .createHash("sha1")
    .update(`promotion-proposal:${caseId}`)
    .digest("hex")
    .slice(0, 12);
  return `gpp_${digest}`;
}

function promotionProposalDecisionId(proposalId, decision, reviewedAt) {
  const digest = crypto
    .createHash("sha1")
    .update(`promotion-proposal-decision:${proposalId}:${decision}:${reviewedAt}`)
    .digest("hex")
    .slice(0, 12);
  return `gpd_${digest}`;
}

function promotionId(proposalId) {
  const digest = crypto
    .createHash("sha1")
    .update(`promotion:${proposalId}`)
    .digest("hex")
    .slice(0, 12);
  return `gpr_${digest}`;
}

function decisionId(signalId, decision, reviewedAt) {
  const digest = crypto
    .createHash("sha1")
    .update(`${signalId}:${decision}:${reviewedAt}`)
    .digest("hex")
    .slice(0, 12);
  return `gcd_${digest}`;
}

function uniqueArray(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function mergeArray(existing, incoming) {
  return uniqueArray([...(existing || []), ...(incoming || [])]);
}

function clonePlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function candidateTypeFor(signal) {
  if (signal.failureType === "known_capability_as_new_suggestion") return "capability_patch";
  const guardReasons = new Set(signal.guardReasons || []);
  if (guardReasons.has("review_required") || guardReasons.has("citation_required")) return "playbook_patch";
  return null;
}

function buildPromotionCandidate(record, signal, hitCount) {
  if (hitCount < 2) return record.promotionCandidate || signal.promotionCandidate || null;
  const candidateType = candidateTypeFor(signal);
  if (!candidateType) return record.promotionCandidate || signal.promotionCandidate || null;
  const existing = record.promotionCandidate || {};
  return {
    candidateType: existing.candidateType || candidateType,
    status: existing.status || "candidate",
    reason: existing.reason || signal.summary || signal.failureType,
    evidenceRefs: mergeArray(existing.evidenceRefs, signal.evidenceRefs),
    createdFrom: existing.createdFrom || "answer_guard"
  };
}

function upsertGrowthSignal(brainRoot, signal) {
  const filePath = growthSignalsPath(brainRoot);
  ensureDir(path.dirname(filePath));
  const records = readJsonl(filePath);
  const now = isoNow();
  const summary = signal.summary || signal.failureType || "unknown";
  const signalId = signal.signalId || stableSignalId(signal.scopeId || "unknown", signal.failureType || "unknown", summary);
  const index = records.findIndex(r => r.signalId === signalId);

  const base = index >= 0
    ? records[index]
    : {
        signalId,
        scopeId: signal.scopeId || "unknown",
        source: signal.source || "answer_guard",
        failureType: signal.failureType || "unknown",
        summary,
        hitCount: 0,
        status: signal.status || "candidate",
        createdAt: now
      };
  const hitCount = (base.hitCount || 0) + 1;
  const next = {
    ...base,
    source: signal.source || base.source || "answer_guard",
    failureType: signal.failureType || base.failureType || "unknown",
    summary,
    evidenceRefs: mergeArray(base.evidenceRefs, signal.evidenceRefs),
    guardReasons: mergeArray(base.guardReasons, signal.guardReasons),
    detectorStatus: signal.detectorStatus || base.detectorStatus || null,
    detectorReasons: mergeArray(base.detectorReasons, signal.detectorReasons),
    recommendedUse: Object.keys(signal.recommendedUse || {}).length > 0
      ? clonePlainObject(signal.recommendedUse)
      : clonePlainObject(base.recommendedUse),
    suggestedFix: signal.suggestedFix || base.suggestedFix,
    hitCount,
    status: signal.status || base.status || "candidate",
    updatedAt: now
  };
  const promotionCandidate = buildPromotionCandidate(next, signal, hitCount);
  if (promotionCandidate) next.promotionCandidate = promotionCandidate;

  if (index >= 0) {
    records[index] = next;
  } else {
    records.push(next);
  }

  writeJsonl(filePath, records);
  if (signal.activation) {
    appendConsolidationLog(brainRoot, {
      scopeId: next.scopeId,
      source: "growth_signal",
      eventType: "growth_signal_upsert",
      resultId: next.signalId,
      status: next.status,
      failureType: next.failureType,
      hitCount: next.hitCount,
      activation: signal.activation,
      metadata: {
        source: next.source
      }
    });
  }
  return records.find(r => r.signalId === signalId);
}

function listGrowthSignals(brainRoot, scopeId) {
  const records = readJsonl(growthSignalsPath(brainRoot));
  return scopeId ? records.filter(r => r.scopeId === scopeId) : records;
}

function listGrowthCandidates(brainRoot, scopeId) {
  return listGrowthSignals(brainRoot, scopeId)
    .filter(signal => signal.promotionCandidate?.status === "candidate")
    .map(signal => ({
      signalId: signal.signalId,
      scopeId: signal.scopeId,
      source: signal.source,
      failureType: signal.failureType,
      summary: signal.summary,
      hitCount: signal.hitCount || 0,
      evidenceRefs: signal.promotionCandidate.evidenceRefs || signal.evidenceRefs || [],
      guardReasons: signal.guardReasons || [],
      detectorStatus: signal.detectorStatus || null,
      detectorReasons: signal.detectorReasons || [],
      recommendedUse: clonePlainObject(signal.recommendedUse),
      suggestedFix: signal.suggestedFix,
      promotionCandidate: clonePlainObject(signal.promotionCandidate),
      updatedAt: signal.updatedAt,
      createdAt: signal.createdAt
    }));
}

function shouldAutoCreateRemediationRegressionCase(signal, decision) {
  return decision === "approved" &&
    signal.source === "project_promotion_consumer" &&
    signal.failureType === "post_apply_verification_failed";
}

function reviewGrowthCandidate(brainRoot, review) {
  const decision = review?.decision;
  if (decision !== "approved" && decision !== "dismissed") {
    throw new Error("decision은 approved 또는 dismissed만 허용됩니다.");
  }
  if (!review.signalId) throw new Error("signalId가 필요합니다.");

  const filePath = growthSignalsPath(brainRoot);
  const records = readJsonl(filePath);
  const index = records.findIndex(signal => signal.signalId === review.signalId);
  if (index < 0) throw new Error(`Growth signal을 찾을 수 없습니다: ${review.signalId}`);

  const signal = records[index];
  if (!signal.promotionCandidate) {
    throw new Error(`promotionCandidate가 없는 signal입니다: ${review.signalId}`);
  }
  if (signal.promotionCandidate.status !== "candidate") {
    throw new Error(`이미 review된 candidate입니다: ${review.signalId}`);
  }

  const reviewedAt = isoNow();
  const reviewer = review.reviewer || "unknown";
  const reason = review.reason || "";
  const promotionCandidate = {
    ...signal.promotionCandidate,
    status: decision,
    reviewedAt,
    reviewedBy: reviewer,
    reviewReason: reason
  };
  const nextSignal = {
    ...signal,
    promotionCandidate,
    updatedAt: reviewedAt
  };
  records[index] = nextSignal;
  writeJsonl(filePath, records);

  const decisionRecord = {
    decisionId: decisionId(signal.signalId, decision, reviewedAt),
    signalId: signal.signalId,
    scopeId: signal.scopeId,
    failureType: signal.failureType,
    candidateType: promotionCandidate.candidateType,
    decision,
    reviewer,
    reason,
    evidenceRefs: promotionCandidate.evidenceRefs || signal.evidenceRefs || [],
    createdFrom: "growth_candidate_review",
    createdAt: reviewedAt
  };
  const decisionsPath = growthCandidateDecisionsPath(brainRoot);
  ensureDir(path.dirname(decisionsPath));
  const decisions = readJsonl(decisionsPath);
  decisions.push(decisionRecord);
  writeJsonl(decisionsPath, decisions);

  const autoRegression = shouldAutoCreateRemediationRegressionCase(nextSignal, decision)
    ? createGrowthRegressionCase(brainRoot, {
      signalId: nextSignal.signalId,
      createdBy: reviewer,
      reason: reason || "approved post-apply remediation candidate"
    })
    : null;
  const autoRegressionRun = autoRegression
    ? runGrowthRegressionCase(brainRoot, {
      caseId: autoRegression.case.caseId,
      runner: "growth_candidate_review",
      reason: reason || "approved post-apply remediation candidate"
    })
    : null;
  const autoPromotionProposal = autoRegressionRun?.result?.status === "passed"
    ? createGrowthPromotionProposal(brainRoot, {
      caseId: autoRegressionRun.case.caseId,
      createdBy: reviewer,
      reason: reason || "passed post-apply remediation regression"
    })
    : null;

  return {
    signal: nextSignal,
    decision: decisionRecord,
    regressionCase: autoRegressionRun?.case || autoRegression?.case || null,
    regressionCaseCreated: autoRegression?.created || false,
    regressionResult: autoRegressionRun?.result || null,
    regressionExecuted: !!autoRegressionRun,
    promotionProposal: autoPromotionProposal?.proposal || null,
    promotionProposalCreated: autoPromotionProposal?.created || false
  };
}

function listGrowthCandidateDecisions(brainRoot, scopeId) {
  const decisions = readJsonl(growthCandidateDecisionsPath(brainRoot));
  return scopeId ? decisions.filter(decision => decision.scopeId === scopeId) : decisions;
}

function listGrowthRegressionCases(brainRoot, scopeId) {
  const cases = readJsonl(growthRegressionCasesPath(brainRoot));
  return scopeId ? cases.filter(item => item.scopeId === scopeId) : cases;
}

function createGrowthRegressionCase(brainRoot, request) {
  if (!request?.signalId) throw new Error("signalId가 필요합니다.");
  const signal = readJsonl(growthSignalsPath(brainRoot)).find(item => item.signalId === request.signalId);
  if (!signal) throw new Error(`Growth signal을 찾을 수 없습니다: ${request.signalId}`);
  if (!signal.promotionCandidate) {
    throw new Error(`promotionCandidate가 없는 signal입니다: ${request.signalId}`);
  }
  if (signal.promotionCandidate.status !== "approved") {
    throw new Error("approved candidate만 regression case로 만들 수 있습니다.");
  }

  const filePath = growthRegressionCasesPath(brainRoot);
  ensureDir(path.dirname(filePath));
  const cases = readJsonl(filePath);
  const existing = cases.find(item => item.signalId === signal.signalId);
  if (existing) {
    return {
      case: existing,
      created: false
    };
  }

  const createdAt = isoNow();
  const regressionCase = {
    caseId: regressionCaseId(signal.signalId),
    signalId: signal.signalId,
    scopeId: signal.scopeId,
    candidateType: signal.promotionCandidate.candidateType,
    failureType: signal.failureType,
    title: signal.summary || signal.failureType,
    expectedGuardReasons: signal.guardReasons || [],
    expectedDetectorReasons: signal.detectorReasons || [],
    expectedRecommendedUse: clonePlainObject(signal.recommendedUse),
    expectedFix: signal.suggestedFix || signal.promotionCandidate.reason,
    evidenceRefs: signal.promotionCandidate.evidenceRefs || signal.evidenceRefs || [],
    sourceDecision: {
      status: signal.promotionCandidate.status,
      reviewedAt: signal.promotionCandidate.reviewedAt,
      reviewedBy: signal.promotionCandidate.reviewedBy,
      reviewReason: signal.promotionCandidate.reviewReason
    },
    createdFrom: "growth_candidate",
    createdBy: request.createdBy || "unknown",
    reason: request.reason || "",
    status: "pending_execution",
    createdAt
  };
  cases.push(regressionCase);
  writeJsonl(filePath, cases);
  return {
    case: regressionCase,
    created: true
  };
}

function hasNonEmptyObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

function evaluateRegressionCaseContract(regressionCase) {
  const failures = [];
  if (!regressionCase.signalId) failures.push("missing_signal_id");
  if (!regressionCase.scopeId) failures.push("missing_scope_id");
  if (!regressionCase.candidateType) failures.push("missing_candidate_type");
  if (!regressionCase.failureType) failures.push("missing_failure_type");
  if (regressionCase.sourceDecision?.status !== "approved") failures.push("source_decision_not_approved");

  const hasExpectedGuardReasons = Array.isArray(regressionCase.expectedGuardReasons) && regressionCase.expectedGuardReasons.length > 0;
  const hasExpectedDetectorReasons = Array.isArray(regressionCase.expectedDetectorReasons) && regressionCase.expectedDetectorReasons.length > 0;
  const hasExpectedRecommendedUse = hasNonEmptyObject(regressionCase.expectedRecommendedUse);
  if (!hasExpectedGuardReasons && !hasExpectedDetectorReasons && !hasExpectedRecommendedUse) {
    failures.push("missing_expected_assertions");
  }

  if (
    Object.prototype.hasOwnProperty.call(regressionCase, "draftText") ||
    Object.prototype.hasOwnProperty.call(regressionCase, "draft") ||
    Object.prototype.hasOwnProperty.call(regressionCase, "draftContent")
  ) {
    failures.push("draft_text_must_not_be_stored");
  }

  return {
    status: failures.length === 0 ? "passed" : "failed",
    failures
  };
}

function runGrowthRegressionCase(brainRoot, request) {
  if (!request?.caseId) throw new Error("caseId가 필요합니다.");

  const casesPath = growthRegressionCasesPath(brainRoot);
  const cases = readJsonl(casesPath);
  const index = cases.findIndex(item => item.caseId === request.caseId);
  if (index < 0) throw new Error(`Regression case를 찾을 수 없습니다: ${request.caseId}`);

  const regressionCase = cases[index];
  const evaluated = evaluateRegressionCaseContract(regressionCase);
  const createdAt = isoNow();
  const result = {
    resultId: regressionResultId(regressionCase.caseId, createdAt),
    caseId: regressionCase.caseId,
    signalId: regressionCase.signalId,
    scopeId: regressionCase.scopeId,
    candidateType: regressionCase.candidateType,
    failureType: regressionCase.failureType,
    status: evaluated.status,
    failures: evaluated.failures,
    checkedAssertions: {
      guardReasons: regressionCase.expectedGuardReasons || [],
      detectorReasons: regressionCase.expectedDetectorReasons || [],
      recommendedUse: clonePlainObject(regressionCase.expectedRecommendedUse)
    },
    runner: request.runner || "unknown",
    reason: request.reason || "",
    createdFrom: "growth_regression_case",
    createdAt
  };

  const resultsPath = growthRegressionResultsPath(brainRoot);
  ensureDir(path.dirname(resultsPath));
  const results = readJsonl(resultsPath);
  results.push(result);
  writeJsonl(resultsPath, results);

  const nextCase = {
    ...regressionCase,
    status: evaluated.status === "passed" ? "executed_passed" : "executed_failed",
    lastRun: {
      resultId: result.resultId,
      status: result.status,
      failures: result.failures,
      runner: result.runner,
      reason: result.reason,
      createdAt: result.createdAt
    }
  };
  cases[index] = nextCase;
  ensureDir(path.dirname(casesPath));
  writeJsonl(casesPath, cases);

  return {
    case: nextCase,
    result
  };
}

function listGrowthRegressionResults(brainRoot, scopeId) {
  const results = readJsonl(growthRegressionResultsPath(brainRoot));
  return scopeId ? results.filter(result => result.scopeId === scopeId) : results;
}

function listGrowthPromotionProposals(brainRoot, scopeId) {
  const proposals = readJsonl(growthPromotionProposalsPath(brainRoot));
  return scopeId ? proposals.filter(proposal => proposal.scopeId === scopeId) : proposals;
}

function createGrowthPromotionProposal(brainRoot, request) {
  if (!request?.caseId) throw new Error("caseId가 필요합니다.");

  const regressionCase = readJsonl(growthRegressionCasesPath(brainRoot)).find(item => item.caseId === request.caseId);
  if (!regressionCase) throw new Error(`Regression case를 찾을 수 없습니다: ${request.caseId}`);
  if (regressionCase.status !== "executed_passed" || regressionCase.lastRun?.status !== "passed") {
    throw new Error("passed regression case만 promotion proposal로 만들 수 있습니다.");
  }

  const filePath = growthPromotionProposalsPath(brainRoot);
  ensureDir(path.dirname(filePath));
  const proposals = readJsonl(filePath);
  const existing = proposals.find(item => item.caseId === regressionCase.caseId);
  if (existing) {
    return {
      proposal: existing,
      created: false
    };
  }

  const createdAt = isoNow();
  const proposal = {
    proposalId: promotionProposalId(regressionCase.caseId),
    caseId: regressionCase.caseId,
    signalId: regressionCase.signalId,
    scopeId: regressionCase.scopeId,
    candidateType: regressionCase.candidateType,
    failureType: regressionCase.failureType,
    title: regressionCase.title || regressionCase.failureType,
    proposedChange: {
      targetType: regressionCase.candidateType,
      summary: regressionCase.expectedFix || regressionCase.title || regressionCase.failureType,
      expectedGuardReasons: regressionCase.expectedGuardReasons || [],
      expectedDetectorReasons: regressionCase.expectedDetectorReasons || [],
      expectedRecommendedUse: clonePlainObject(regressionCase.expectedRecommendedUse),
      evidenceRefs: regressionCase.evidenceRefs || []
    },
    gate: {
      regressionStatus: regressionCase.status,
      lastResultId: regressionCase.lastRun?.resultId,
      lastRunStatus: regressionCase.lastRun?.status,
      lastRunAt: regressionCase.lastRun?.createdAt
    },
    sourceDecision: clonePlainObject(regressionCase.sourceDecision),
    status: "proposal",
    createdFrom: "regression_case",
    createdBy: request.createdBy || "unknown",
    reason: request.reason || "",
    createdAt
  };
  proposals.push(proposal);
  writeJsonl(filePath, proposals);
  return {
    proposal,
    created: true
  };
}

function reviewGrowthPromotionProposal(brainRoot, review) {
  const allowedDecisions = new Set(["approved", "dismissed", "needs_changes"]);
  const decision = review?.decision;
  if (!allowedDecisions.has(decision)) {
    throw new Error("decision은 approved, dismissed, needs_changes만 허용됩니다.");
  }
  if (!review.proposalId) throw new Error("proposalId가 필요합니다.");

  const proposalsPath = growthPromotionProposalsPath(brainRoot);
  const proposals = readJsonl(proposalsPath);
  const index = proposals.findIndex(proposal => proposal.proposalId === review.proposalId);
  if (index < 0) throw new Error(`Promotion proposal을 찾을 수 없습니다: ${review.proposalId}`);

  const proposal = proposals[index];
  if (proposal.status !== "proposal") {
    throw new Error(`이미 review된 proposal입니다: ${review.proposalId}`);
  }

  const reviewedAt = isoNow();
  const reviewer = review.reviewer || "unknown";
  const reason = review.reason || "";
  const nextProposal = {
    ...proposal,
    status: decision,
    reviewedAt,
    reviewedBy: reviewer,
    reviewReason: reason,
    updatedAt: reviewedAt
  };
  proposals[index] = nextProposal;
  ensureDir(path.dirname(proposalsPath));
  writeJsonl(proposalsPath, proposals);

  const decisionRecord = {
    decisionId: promotionProposalDecisionId(proposal.proposalId, decision, reviewedAt),
    proposalId: proposal.proposalId,
    caseId: proposal.caseId,
    signalId: proposal.signalId,
    scopeId: proposal.scopeId,
    candidateType: proposal.candidateType,
    failureType: proposal.failureType,
    decision,
    reviewer,
    reason,
    gate: clonePlainObject(proposal.gate),
    proposedChange: clonePlainObject(proposal.proposedChange),
    createdFrom: "promotion_proposal_review",
    createdAt: reviewedAt
  };
  const decisionsPath = growthPromotionProposalDecisionsPath(brainRoot);
  ensureDir(path.dirname(decisionsPath));
  const decisions = readJsonl(decisionsPath);
  decisions.push(decisionRecord);
  writeJsonl(decisionsPath, decisions);

  return {
    proposal: nextProposal,
    decision: decisionRecord
  };
}

function listGrowthPromotionProposalDecisions(brainRoot, scopeId) {
  const decisions = readJsonl(growthPromotionProposalDecisionsPath(brainRoot));
  return scopeId ? decisions.filter(decision => decision.scopeId === scopeId) : decisions;
}

function sourceRefsForProposal(proposal, promotionIdValue) {
  return uniqueArray([
    ...(proposal.proposedChange?.evidenceRefs || []),
    proposal.proposalId,
    promotionIdValue
  ]);
}

function upsertActiveStatePromotionTarget(brainRoot, proposal, promotionIdValue, appliedAt) {
  const state = loadActiveState(brainRoot, proposal.scopeId);
  const refs = sourceRefsForProposal(proposal, promotionIdValue);
  const summary = proposal.proposedChange?.summary || proposal.title || proposal.failureType;

  if (proposal.candidateType === "capability_patch") {
    const capabilityId = `${proposal.scopeId}.growth.${proposal.proposalId}.capability`;
    const capability = {
      id: capabilityId,
      title: proposal.title || "Growth promotion capability",
      summary,
      status: "active",
      sourceRefs: refs,
      sourceProposalId: proposal.proposalId,
      promotionId: promotionIdValue,
      updatedAt: appliedAt
    };
    const index = state.capabilities.findIndex(item => item.id === capabilityId);
    if (index >= 0) state.capabilities[index] = capability;
    else state.capabilities.push(capability);
    state.sourceRefs = mergeArray(state.sourceRefs, refs);
    saveActiveState(brainRoot, state);
    return {
      type: "active_state_capability",
      scopeId: proposal.scopeId,
      id: capabilityId,
      path: `41_active/${proposal.scopeId}/state.json`
    };
  }

  if (proposal.candidateType === "playbook_patch") {
    const hintId = `${proposal.scopeId}.growth.${proposal.proposalId}.guard`;
    const guardHint = {
      id: hintId,
      rule: summary,
      appliesWhen: uniqueArray([
        proposal.failureType,
        ...(proposal.proposedChange?.expectedGuardReasons || []),
        ...(proposal.proposedChange?.expectedDetectorReasons || [])
      ]),
      sourceRefs: refs,
      sourceProposalId: proposal.proposalId,
      promotionId: promotionIdValue,
      updatedAt: appliedAt
    };
    const index = state.guardHints.findIndex(item => item.id === hintId);
    if (index >= 0) state.guardHints[index] = guardHint;
    else state.guardHints.push(guardHint);
    state.sourceRefs = mergeArray(state.sourceRefs, refs);
    saveActiveState(brainRoot, state);
    return {
      type: "active_state_guard_hint",
      scopeId: proposal.scopeId,
      id: hintId,
      path: `41_active/${proposal.scopeId}/state.json`
    };
  }

  return {
    type: "promotion_log_only",
    scopeId: proposal.scopeId,
    reason: "unsupported_candidate_type"
  };
}

function listGrowthPromotions(brainRoot, scopeId) {
  const promotions = readJsonl(growthPromotionsPath(brainRoot));
  return scopeId ? promotions.filter(promotion => promotion.scopeId === scopeId) : promotions;
}

function projectTargetForPromotion(promotion) {
  if (promotion.candidateType === "capability_patch") {
    return {
      adapter: "project",
      targetType: "capability_registry",
      action: "upsert"
    };
  }
  if (promotion.candidateType === "playbook_patch") {
    return {
      adapter: "project",
      targetType: "playbook",
      action: "upsert"
    };
  }
  if (promotion.candidateType === "workflow_patch") {
    return {
      adapter: "project",
      targetType: "workflow",
      action: "upsert"
    };
  }
  return {
    adapter: "project",
    targetType: "workflow_backlog",
    action: "review"
  };
}

function buildProjectPromotionPayload(promotion) {
  const refs = sourceRefsForProposal(promotion, promotion.promotionId);
  const summary = promotion.proposedChange?.summary || promotion.title || promotion.failureType;
  const base = {
    id: `${promotion.scopeId}.growth.${promotion.promotionId}`,
    title: promotion.title || summary,
    summary,
    sourceRefs: refs,
    sourceProposalId: promotion.proposalId,
    promotionId: promotion.promotionId,
    appliedAt: promotion.appliedAt
  };

  if (promotion.candidateType === "capability_patch") {
    return {
      capability: {
        ...base,
        status: "active",
        sourceActiveStateTarget: (promotion.appliedTargets || []).find(target => target.type === "active_state_capability") || null
      }
    };
  }

  if (promotion.candidateType === "playbook_patch") {
    return {
      playbook: {
        ...base,
        rule: summary,
        appliesWhen: uniqueArray([
          promotion.failureType,
          ...(promotion.proposedChange?.expectedGuardReasons || []),
          ...(promotion.proposedChange?.expectedDetectorReasons || [])
        ]),
        sourceActiveStateTarget: (promotion.appliedTargets || []).find(target => target.type === "active_state_guard_hint") || null
      }
    };
  }

  return {
    workflow: {
      ...base,
      candidateType: promotion.candidateType || "unknown",
      reason: "unsupported_candidate_type_requires_project_review"
    }
  };
}

function buildProjectPromotionExport(promotion) {
  const refs = sourceRefsForProposal(promotion, promotion.promotionId);
  return {
    promotionId: promotion.promotionId,
    proposalId: promotion.proposalId,
    caseId: promotion.caseId,
    signalId: promotion.signalId,
    scopeId: promotion.scopeId,
    candidateType: promotion.candidateType,
    failureType: promotion.failureType,
    title: promotion.title,
    status: "ready_for_project_consumer",
    target: projectTargetForPromotion(promotion),
    payload: buildProjectPromotionPayload(promotion),
    evidenceRefs: refs,
    appliedTargets: promotion.appliedTargets || [],
    appliedAt: promotion.appliedAt
  };
}

function listProjectPromotionExports(brainRoot, options = {}) {
  const scopeId = options.scope || options.scopeId;
  if (!scopeId) throw new Error("scopeId가 필요합니다.");
  let promotions = listGrowthPromotions(brainRoot, scopeId).filter(promotion => promotion.status === "applied");
  if (options.candidateType) {
    promotions = promotions.filter(promotion => promotion.candidateType === options.candidateType);
  }
  const exports = promotions.map(buildProjectPromotionExport);
  return {
    adapter: "project",
    schemaVersion: "project-promotion-export/v1",
    scopeId,
    generatedAt: isoNow(),
    promotions: exports,
    total: exports.length
  };
}

function listAgentForgePromotionExports(brainRoot, options = {}) {
  return listProjectPromotionExports(brainRoot, {
    ...options,
    scopeId: options.scope || options.scopeId || "agentforge"
  });
}

function applyApprovedGrowthPromotionProposal(brainRoot, request) {
  if (!request?.proposalId) throw new Error("proposalId가 필요합니다.");

  const proposalsPath = growthPromotionProposalsPath(brainRoot);
  const proposals = readJsonl(proposalsPath);
  const proposalIndex = proposals.findIndex(proposal => proposal.proposalId === request.proposalId);
  if (proposalIndex < 0) throw new Error(`Promotion proposal을 찾을 수 없습니다: ${request.proposalId}`);
  const proposal = proposals[proposalIndex];

  const promotionsPath = growthPromotionsPath(brainRoot);
  ensureDir(path.dirname(promotionsPath));
  const promotions = readJsonl(promotionsPath);
  const existing = promotions.find(promotion => promotion.proposalId === proposal.proposalId);
  if (existing) {
    return {
      promotion: existing,
      proposal,
      applied: false
    };
  }

  if (proposal.status !== "approved") {
    throw new Error("approved proposal만 적용할 수 있습니다.");
  }

  const appliedAt = isoNow();
  const promotionIdValue = promotionId(proposal.proposalId);
  const appliedTargets = [upsertActiveStatePromotionTarget(brainRoot, proposal, promotionIdValue, appliedAt)];
  const promotion = {
    promotionId: promotionIdValue,
    proposalId: proposal.proposalId,
    caseId: proposal.caseId,
    signalId: proposal.signalId,
    scopeId: proposal.scopeId,
    candidateType: proposal.candidateType,
    failureType: proposal.failureType,
    title: proposal.title,
    proposedChange: clonePlainObject(proposal.proposedChange),
    appliedTargets,
    status: "applied",
    createdFrom: "promotion_proposal",
    appliedBy: request.appliedBy || "unknown",
    reason: request.reason || "",
    appliedAt
  };
  promotions.push(promotion);
  writeJsonl(promotionsPath, promotions);

  const nextProposal = {
    ...proposal,
    status: "applied",
    promotionId: promotionIdValue,
    appliedAt,
    appliedBy: promotion.appliedBy,
    applicationReason: promotion.reason,
    updatedAt: appliedAt
  };
  proposals[proposalIndex] = nextProposal;
  writeJsonl(proposalsPath, proposals);

  return {
    promotion,
    proposal: nextProposal,
    applied: true
  };
}

module.exports = {
  growthSignalsPath,
  growthCandidateDecisionsPath,
  growthRegressionCasesPath,
  growthRegressionResultsPath,
  growthPromotionProposalsPath,
  growthPromotionProposalDecisionsPath,
  growthPromotionsPath,
  upsertGrowthSignal,
  listGrowthSignals,
  listGrowthCandidates,
  reviewGrowthCandidate,
  listGrowthCandidateDecisions,
  createGrowthRegressionCase,
  listGrowthRegressionCases,
  runGrowthRegressionCase,
  listGrowthRegressionResults,
  createGrowthPromotionProposal,
  listGrowthPromotionProposals,
  reviewGrowthPromotionProposal,
  listGrowthPromotionProposalDecisions,
  applyApprovedGrowthPromotionProposal,
  listGrowthPromotions,
  listProjectPromotionExports,
  listAgentForgePromotionExports,
  stableSignalId
};
