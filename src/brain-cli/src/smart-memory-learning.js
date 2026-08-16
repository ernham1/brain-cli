"use strict";

const path = require("path");
const crypto = require("crypto");
const { ensureDir, isoNow, readJsonl, writeJsonl } = require("./utils");
const { appendConsolidationLog, memoryGraphDir, readEdges, writeEdges } = require("./memory-graph");
const { applySmartMemoryPolicyChanges } = require("./smart-memory-policy");

const SCHEMA_VERSION = "smart-memory-learning-proposal/v1";

function smartMemoryProposalsPath(brainRoot) {
  return path.join(memoryGraphDir(brainRoot), "smart-memory-proposals.jsonl");
}

function smartMemoryProposalDecisionsPath(brainRoot) {
  return path.join(memoryGraphDir(brainRoot), "smart-memory-proposal-decisions.jsonl");
}

function smartMemoryApplicationsPath(brainRoot) {
  return path.join(memoryGraphDir(brainRoot), "smart-memory-applications.jsonl");
}

function stableProposalId(scopeId, eventType, resultId, evidenceKey) {
  const digest = crypto
    .createHash("sha1")
    .update(`${scopeId}:${eventType}:${resultId}:${evidenceKey}`.toLowerCase())
    .digest("hex")
    .slice(0, 14);
  return `smp_${digest}`;
}

function stableDecisionId(proposalId, decision, reviewedAt) {
  const digest = crypto
    .createHash("sha1")
    .update(`${proposalId}:${decision}:${reviewedAt}`.toLowerCase())
    .digest("hex")
    .slice(0, 14);
  return `smd_${digest}`;
}

function stableApplicationId(proposalId) {
  const digest = crypto
    .createHash("sha1")
    .update(`smart-memory-application:${proposalId}`.toLowerCase())
    .digest("hex")
    .slice(0, 14);
  return `sma_${digest}`;
}

function readSmartMemoryProposals(brainRoot) {
  return readJsonl(smartMemoryProposalsPath(brainRoot));
}

function readSmartMemoryProposalDecisions(brainRoot) {
  return readJsonl(smartMemoryProposalDecisionsPath(brainRoot));
}

function readSmartMemoryApplications(brainRoot) {
  return readJsonl(smartMemoryApplicationsPath(brainRoot));
}

function listSmartMemoryProposals(brainRoot, options = {}) {
  const scopeId = options.scope || options.scopeId;
  const status = options.status;
  return readSmartMemoryProposals(brainRoot)
    .filter(proposal => !scopeId || proposal.scopeId === scopeId)
    .filter(proposal => !status || proposal.status === status);
}

function listSmartMemoryProposalDecisions(brainRoot, options = {}) {
  const scopeId = options.scope || options.scopeId;
  return readSmartMemoryProposalDecisions(brainRoot)
    .filter(decision => !scopeId || decision.scopeId === scopeId);
}

function listSmartMemoryApplications(brainRoot, options = {}) {
  const scopeId = options.scope || options.scopeId;
  return readSmartMemoryApplications(brainRoot)
    .filter(application => !scopeId || application.scopeId === scopeId);
}

function uniqueArray(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function clonePlainObject(value) {
  if (!value || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

function findingTypes(result = {}) {
  return uniqueArray((result.findings || []).map(finding => finding.failureType));
}

function guardReasons(result = {}) {
  return uniqueArray((result.findings || []).flatMap(finding => finding.guardReasons || []));
}

function proposalEventType(request = {}) {
  if (request.eventType) return request.eventType;
  if (request.guardResult?.status === "revise_required") return "memory_prevented_error";
  if (request.guardResult?.status === "review_recommended") return "memory_used_corrected";
  return "memory_used_success";
}

function buildProposedChanges(eventType, activation = {}, smartMemory = {}, guardResult = {}) {
  const changes = [];
  const activatedEdgeIds = activation.activatedEdgeIds || [];
  const inhibitionSignals = activation.inhibitionSignals || [];
  const decisions = smartMemory.decisions || [];

  if (eventType === "memory_prevented_error") {
    for (const signal of inhibitionSignals) {
      changes.push({
        changeType: "strengthen_inhibition",
        targetType: "inhibition_signal",
        targetRef: signal.ref || signal.signal,
        delta: 0.05,
        reason: signal.signal || "guard_prevented_error"
      });
    }
    for (const edgeId of activatedEdgeIds.slice(0, 12)) {
      changes.push({
        changeType: "strengthen_activated_edge",
        targetType: "memory_graph_edge",
        targetRef: edgeId,
        delta: 0.03,
        reason: "edge_participated_in_prevention"
      });
    }
  }

  if (eventType === "memory_used_success") {
    for (const edgeId of activatedEdgeIds.slice(0, 12)) {
      changes.push({
        changeType: "strengthen_activated_edge",
        targetType: "memory_graph_edge",
        targetRef: edgeId,
        delta: 0.02,
        reason: "memory_helped_success"
      });
    }
  }

  if (eventType === "memory_used_corrected") {
    for (const edgeId of activatedEdgeIds.slice(0, 12)) {
      changes.push({
        changeType: "weaken_activated_edge",
        targetType: "memory_graph_edge",
        targetRef: edgeId,
        delta: -0.04,
        reason: "memory_required_correction"
      });
    }
  }

  if (smartMemory.answerPolicy?.requiresUserConfirmation) {
    for (const decision of decisions.filter(item => item.decision === "needs_confirmation" || item.decision === "hold_due_conflict").slice(0, 6)) {
      changes.push({
        changeType: "increase_review_requirement",
        targetType: "memory_ref",
        targetRef: decision.ref,
        delta: 0,
        reason: decision.reason || "smart_memory_requires_confirmation"
      });
    }
  }

  if (guardResult.status === "review_recommended" && changes.length === 0) {
    changes.push({
      changeType: "increase_review_requirement",
      targetType: "smart_memory_policy",
      targetRef: smartMemory.schemaVersion || "smart-memory/v1",
      delta: 0,
      reason: "guard_review_recommended"
    });
  }

  return changes;
}

function evidenceKeyFor(request = {}, eventType, changes) {
  return [
    request.resultId || request.guardResult?.guardId || "manual",
    eventType,
    changes.map(change => `${change.changeType}:${change.targetRef}`).join(",")
  ].join("|");
}

function upsertSmartMemoryLearningProposal(brainRoot, request = {}) {
  const brief = request.brief || {};
  const smartMemory = brief.sections?.smartMemory || {};
  const memoryGraph = brief.sections?.memoryGraph || {};
  const activation = request.activation || {
    activatedNodeIds: (memoryGraph.activatedNodes || []).map(node => node.nodeId),
    activatedEdgeIds: (memoryGraph.activatedEdges || []).map(edge => edge.edgeId),
    inhibitionSignals: memoryGraph.inhibitionSignals || [],
    reviewSignals: memoryGraph.reviewSignals || [],
    usedDepth: memoryGraph.usedDepth || null
  };
  const eventType = proposalEventType(request);
  const proposedChanges = buildProposedChanges(eventType, activation, smartMemory, request.guardResult || {});
  if (proposedChanges.length === 0 && request.createIfEmpty !== true) {
    return {
      proposal: null,
      created: false,
      skipped: "no_proposed_changes"
    };
  }

  const now = isoNow();
  const scopeId = request.scopeId || brief.scopeId || smartMemory.scopeId || "unknown";
  const resultId = request.resultId || request.guardResult?.guardId || null;
  const evidenceKey = evidenceKeyFor(request, eventType, proposedChanges);
  const proposalId = request.proposalId || stableProposalId(scopeId, eventType, resultId, evidenceKey);
  const filePath = smartMemoryProposalsPath(brainRoot);
  ensureDir(path.dirname(filePath));
  const proposals = readJsonl(filePath);
  const index = proposals.findIndex(proposal => proposal.proposalId === proposalId);
  const base = index >= 0 ? proposals[index] : {
    proposalId,
    schemaVersion: SCHEMA_VERSION,
    scopeId,
    eventType,
    status: "proposal",
    hitCount: 0,
    createdAt: now
  };
  const next = {
    ...base,
    schemaVersion: SCHEMA_VERSION,
    scopeId,
    eventType,
    status: base.status || "proposal",
    source: request.source || "smart_memory_learning",
    resultId,
    briefId: brief.briefId || request.briefId || null,
    proposedChanges,
    evidence: {
      findingTypes: findingTypes(request.guardResult),
      guardReasons: guardReasons(request.guardResult),
      answerPolicy: clonePlainObject(smartMemory.answerPolicy || {}),
      activatedNodeIds: uniqueArray(activation.activatedNodeIds),
      activatedEdgeIds: uniqueArray(activation.activatedEdgeIds),
      inhibitionSignals: clonePlainObject(activation.inhibitionSignals || []),
      reviewSignals: clonePlainObject(activation.reviewSignals || []),
      usedDepth: activation.usedDepth || smartMemory.depth?.usedDepth || null
    },
    createdBy: request.createdBy || base.createdBy || "Codex",
    reason: request.reason || base.reason || "",
    hitCount: (base.hitCount || 0) + 1,
    updatedAt: now
  };

  if (index >= 0) proposals[index] = next;
  else proposals.push(next);
  writeJsonl(filePath, proposals);

  appendConsolidationLog(brainRoot, {
    scopeId: next.scopeId,
    source: "smart_memory_learning",
    eventType: "learning_proposal_upsert",
    resultId: next.proposalId,
    status: next.status,
    activation,
    metadata: {
      sourceEventType: next.eventType,
      proposedChangeTypes: uniqueArray(next.proposedChanges.map(change => change.changeType))
    }
  });

  return {
    proposal: next,
    created: index < 0,
    skipped: null
  };
}

function activationFromProposal(proposal = {}) {
  const evidence = proposal.evidence || {};
  return {
    activatedNodeIds: uniqueArray(evidence.activatedNodeIds),
    activatedEdgeIds: uniqueArray(evidence.activatedEdgeIds),
    inhibitionSignals: clonePlainObject(evidence.inhibitionSignals || []),
    reviewSignals: clonePlainObject(evidence.reviewSignals || []),
    usedDepth: evidence.usedDepth || null
  };
}

function replaceProposal(brainRoot, proposalId, updater) {
  const filePath = smartMemoryProposalsPath(brainRoot);
  const proposals = readJsonl(filePath);
  const index = proposals.findIndex(proposal => proposal.proposalId === proposalId);
  if (index < 0) throw new Error(`Smart Memory proposal을 찾을 수 없습니다: ${proposalId}`);
  const next = updater(proposals[index]);
  proposals[index] = next;
  ensureDir(path.dirname(filePath));
  writeJsonl(filePath, proposals);
  return next;
}

function reviewSmartMemoryProposal(brainRoot, review = {}) {
  const allowedDecisions = new Set(["approved", "dismissed", "needs_changes"]);
  const decision = review.decision;
  if (!allowedDecisions.has(decision)) {
    throw new Error("decision은 approved, dismissed, needs_changes만 허용됩니다.");
  }
  if (!review.proposalId) throw new Error("proposalId가 필요합니다.");

  let originalProposal;
  const reviewedAt = isoNow();
  const reviewer = review.reviewer || "unknown";
  const reason = review.reason || "";
  const nextProposal = replaceProposal(brainRoot, review.proposalId, proposal => {
    originalProposal = proposal;
    if (proposal.status !== "proposal") {
      throw new Error(`이미 review된 Smart Memory proposal입니다: ${review.proposalId}`);
    }
    return {
      ...proposal,
      status: decision,
      reviewedAt,
      reviewedBy: reviewer,
      reviewReason: reason,
      updatedAt: reviewedAt
    };
  });

  const decisionRecord = {
    decisionId: stableDecisionId(nextProposal.proposalId, decision, reviewedAt),
    proposalId: nextProposal.proposalId,
    scopeId: nextProposal.scopeId,
    eventType: nextProposal.eventType,
    decision,
    reviewer,
    reason,
    proposedChanges: clonePlainObject(originalProposal.proposedChanges || []),
    evidence: clonePlainObject(originalProposal.evidence || {}),
    createdFrom: "smart_memory_proposal_review",
    createdAt: reviewedAt
  };
  const decisionsPath = smartMemoryProposalDecisionsPath(brainRoot);
  ensureDir(path.dirname(decisionsPath));
  const decisions = readJsonl(decisionsPath);
  decisions.push(decisionRecord);
  writeJsonl(decisionsPath, decisions);

  appendConsolidationLog(brainRoot, {
    scopeId: nextProposal.scopeId,
    source: "smart_memory_learning",
    eventType: "learning_proposal_review",
    resultId: nextProposal.proposalId,
    status: decision,
    activation: activationFromProposal(nextProposal),
    metadata: {
      decisionId: decisionRecord.decisionId,
      reviewer
    }
  });

  return {
    proposal: nextProposal,
    decision: decisionRecord
  };
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundedWeight(value) {
  return Number(value.toFixed(4));
}

function applyProposalChanges(brainRoot, proposal, appliedAt) {
  const edges = readEdges(brainRoot);
  const byId = new Map(edges.map(edge => [edge.edgeId, edge]));
  const appliedChanges = [];
  const loggedOnlyChanges = [];
  const policyChanges = [];
  let changed = false;

  for (const change of proposal.proposedChanges || []) {
    if (change.targetType !== "memory_graph_edge") {
      policyChanges.push(change);
      continue;
    }

    const edge = byId.get(change.targetRef);
    if (!edge) {
      loggedOnlyChanges.push({
        ...clonePlainObject(change),
        status: "target_missing",
        reason: "edge_not_found"
      });
      continue;
    }

    const previousWeight = Number(edge.weight || 0);
    const delta = Number(change.delta || 0);
    const nextWeight = roundedWeight(clampNumber(previousWeight + delta, -1, 1));
    const nextEdge = {
      ...edge,
      weight: nextWeight,
      confidence: roundedWeight(clampNumber(nextWeight, 0, 1)),
      provenance: uniqueArray([...(edge.provenance || []), `smart-memory:${proposal.proposalId}`]),
      lastActivatedAt: appliedAt,
      metadata: {
        ...(edge.metadata || {}),
        lastSmartMemoryProposalId: proposal.proposalId,
        lastSmartMemoryAppliedAt: appliedAt
      },
      updatedAt: appliedAt
    };
    byId.set(edge.edgeId, nextEdge);
    changed = true;
    appliedChanges.push({
      ...clonePlainObject(change),
      status: "applied",
      previousWeight,
      delta,
      nextWeight
    });
  }

  if (changed) {
    writeEdges(brainRoot, Array.from(byId.values()).sort((a, b) => String(a.edgeId).localeCompare(String(b.edgeId))));
  }

  const policyResult = applySmartMemoryPolicyChanges(brainRoot, proposal, policyChanges, appliedAt);

  return {
    appliedChanges: [...appliedChanges, ...policyResult.appliedChanges],
    loggedOnlyChanges: [...loggedOnlyChanges, ...policyResult.unsupportedChanges],
    policy: policyResult.appliedChanges.length > 0 ? {
      appliedChangeCount: policyResult.appliedChanges.length,
      scopeId: proposal.scopeId
    } : null
  };
}

function applyApprovedSmartMemoryProposal(brainRoot, request = {}) {
  if (!request.proposalId) throw new Error("proposalId가 필요합니다.");

  const proposalsPath = smartMemoryProposalsPath(brainRoot);
  const proposals = readJsonl(proposalsPath);
  const proposalIndex = proposals.findIndex(proposal => proposal.proposalId === request.proposalId);
  if (proposalIndex < 0) throw new Error(`Smart Memory proposal을 찾을 수 없습니다: ${request.proposalId}`);
  const proposal = proposals[proposalIndex];

  const applicationsPath = smartMemoryApplicationsPath(brainRoot);
  ensureDir(path.dirname(applicationsPath));
  const applications = readJsonl(applicationsPath);
  const existing = applications.find(application => application.proposalId === proposal.proposalId);
  if (existing) {
    return {
      application: existing,
      proposal,
      applied: false
    };
  }

  if (proposal.status !== "approved") {
    throw new Error("approved Smart Memory proposal만 적용할 수 있습니다.");
  }

  const appliedAt = isoNow();
  const applicationId = stableApplicationId(proposal.proposalId);
  const changeResult = applyProposalChanges(brainRoot, proposal, appliedAt);
  const status = changeResult.appliedChanges.length > 0 ? "applied" : "applied_log_only";
  const application = {
    applicationId,
    proposalId: proposal.proposalId,
    scopeId: proposal.scopeId,
    eventType: proposal.eventType,
    status,
    appliedChanges: changeResult.appliedChanges,
    loggedOnlyChanges: changeResult.loggedOnlyChanges,
    policy: changeResult.policy,
    appliedBy: request.appliedBy || "unknown",
    reason: request.reason || "",
    createdFrom: "smart_memory_learning_proposal",
    appliedAt
  };
  applications.push(application);
  writeJsonl(applicationsPath, applications);

  const nextProposal = {
    ...proposal,
    status: "applied",
    applicationId,
    applicationStatus: status,
    appliedAt,
    appliedBy: application.appliedBy,
    applicationReason: application.reason,
    updatedAt: appliedAt
  };
  proposals[proposalIndex] = nextProposal;
  writeJsonl(proposalsPath, proposals);

  appendConsolidationLog(brainRoot, {
    scopeId: nextProposal.scopeId,
    source: "smart_memory_learning",
    eventType: "learning_proposal_apply",
    resultId: application.applicationId,
    status: application.status,
    activation: activationFromProposal(nextProposal),
    metadata: {
      proposalId: nextProposal.proposalId,
      appliedChangeCount: application.appliedChanges.length,
      loggedOnlyChangeCount: application.loggedOnlyChanges.length
    }
  });

  return {
    application,
    proposal: nextProposal,
    applied: true
  };
}

module.exports = {
  SCHEMA_VERSION,
  smartMemoryProposalsPath,
  smartMemoryProposalDecisionsPath,
  smartMemoryApplicationsPath,
  readSmartMemoryProposals,
  readSmartMemoryProposalDecisions,
  readSmartMemoryApplications,
  listSmartMemoryProposals,
  listSmartMemoryProposalDecisions,
  listSmartMemoryApplications,
  upsertSmartMemoryLearningProposal,
  reviewSmartMemoryProposal,
  applyApprovedSmartMemoryProposal
};
