"use strict";

const fs = require("fs");
const path = require("path");
const { ensureDir, isoNow } = require("./utils");
const { memoryGraphDir } = require("./memory-graph");

const POLICY_SCHEMA_VERSION = "smart-memory-policy/v1";
const DEFAULT_POLICY_DELTA = 0.05;

function smartMemoryPolicyPath(brainRoot) {
  return path.join(memoryGraphDir(brainRoot), "smart-memory-policy.json");
}

function defaultPolicy() {
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    scopes: {},
    updatedAt: null
  };
}

function readSmartMemoryPolicy(brainRoot) {
  const filePath = smartMemoryPolicyPath(brainRoot);
  if (!fs.existsSync(filePath)) return defaultPolicy();
  return {
    ...defaultPolicy(),
    ...JSON.parse(fs.readFileSync(filePath, "utf-8"))
  };
}

function writeSmartMemoryPolicy(brainRoot, policy) {
  const filePath = smartMemoryPolicyPath(brainRoot);
  ensureDir(path.dirname(filePath));
  const next = {
    ...defaultPolicy(),
    ...policy,
    schemaVersion: POLICY_SCHEMA_VERSION,
    updatedAt: isoNow()
  };
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

function defaultScopePolicy(scopeId) {
  return {
    scopeId,
    inhibitionSignals: [],
    reviewRequirements: [],
    scopeReviewRequirement: null,
    updatedAt: null
  };
}

function getSmartMemoryPolicyForScope(brainRoot, scopeId) {
  const policy = readSmartMemoryPolicy(brainRoot);
  const scopePolicy = policy.scopes?.[scopeId] || defaultScopePolicy(scopeId);
  return {
    ...defaultScopePolicy(scopeId),
    ...scopePolicy,
    inhibitionSignals: scopePolicy.inhibitionSignals || [],
    reviewRequirements: scopePolicy.reviewRequirements || [],
    scopeReviewRequirement: scopePolicy.scopeReviewRequirement || null
  };
}

function clampStrength(value) {
  return Number(Math.min(1, Math.max(0, value)).toFixed(4));
}

function changeDelta(change) {
  const delta = Number(change?.delta || 0);
  if (delta !== 0) return delta;
  return DEFAULT_POLICY_DELTA;
}

function mergeSourceProposalIds(existing = [], proposalId) {
  return Array.from(new Set([...existing, proposalId].filter(Boolean)));
}

function upsertInhibitionSignal(scopePolicy, change, proposal, appliedAt) {
  const signal = change.targetRef || change.reason || "unknown_inhibition";
  const index = scopePolicy.inhibitionSignals.findIndex(item => item.signal === signal);
  const previous = index >= 0 ? scopePolicy.inhibitionSignals[index] : {
    signal,
    strength: 0.5,
    status: "active",
    sourceProposalIds: [],
    createdAt: appliedAt
  };
  const next = {
    ...previous,
    strength: clampStrength(Number(previous.strength || 0) + changeDelta(change)),
    status: "active",
    reason: change.reason || previous.reason || "",
    sourceProposalIds: mergeSourceProposalIds(previous.sourceProposalIds, proposal.proposalId),
    updatedAt: appliedAt
  };
  if (index >= 0) scopePolicy.inhibitionSignals[index] = next;
  else scopePolicy.inhibitionSignals.push(next);
  return {
    ...change,
    status: "policy_applied",
    policyTarget: "inhibition_signal",
    previousStrength: previous.strength,
    nextStrength: next.strength
  };
}

function upsertReviewRequirement(scopePolicy, change, proposal, appliedAt) {
  const ref = change.targetRef || "unknown_ref";
  const index = scopePolicy.reviewRequirements.findIndex(item => item.ref === ref);
  const previous = index >= 0 ? scopePolicy.reviewRequirements[index] : {
    ref,
    strength: 0.5,
    status: "active",
    sourceProposalIds: [],
    createdAt: appliedAt
  };
  const next = {
    ...previous,
    strength: clampStrength(Number(previous.strength || 0) + Math.abs(changeDelta(change))),
    status: "active",
    reason: change.reason || previous.reason || "",
    sourceProposalIds: mergeSourceProposalIds(previous.sourceProposalIds, proposal.proposalId),
    updatedAt: appliedAt
  };
  if (index >= 0) scopePolicy.reviewRequirements[index] = next;
  else scopePolicy.reviewRequirements.push(next);
  return {
    ...change,
    status: "policy_applied",
    policyTarget: "review_requirement",
    previousStrength: previous.strength,
    nextStrength: next.strength
  };
}

function upsertScopeReviewRequirement(scopePolicy, change, proposal, appliedAt) {
  const previous = scopePolicy.scopeReviewRequirement || {
    strength: 0.5,
    status: "active",
    sourceProposalIds: [],
    createdAt: appliedAt
  };
  const next = {
    ...previous,
    strength: clampStrength(Number(previous.strength || 0) + Math.abs(changeDelta(change))),
    status: "active",
    reason: change.reason || previous.reason || "",
    sourceProposalIds: mergeSourceProposalIds(previous.sourceProposalIds, proposal.proposalId),
    updatedAt: appliedAt
  };
  scopePolicy.scopeReviewRequirement = next;
  return {
    ...change,
    status: "policy_applied",
    policyTarget: "scope_review_requirement",
    previousStrength: previous.strength,
    nextStrength: next.strength
  };
}

function applySmartMemoryPolicyChanges(brainRoot, proposal, changes = [], appliedAt = isoNow()) {
  const policy = readSmartMemoryPolicy(brainRoot);
  const scopeId = proposal.scopeId || "unknown";
  const scopePolicy = {
    ...defaultScopePolicy(scopeId),
    ...(policy.scopes?.[scopeId] || {})
  };
  scopePolicy.inhibitionSignals = [...(scopePolicy.inhibitionSignals || [])];
  scopePolicy.reviewRequirements = [...(scopePolicy.reviewRequirements || [])];

  const appliedChanges = [];
  const unsupportedChanges = [];

  for (const change of changes) {
    if (change.targetType === "inhibition_signal") {
      appliedChanges.push(upsertInhibitionSignal(scopePolicy, change, proposal, appliedAt));
      continue;
    }
    if (change.targetType === "memory_ref") {
      appliedChanges.push(upsertReviewRequirement(scopePolicy, change, proposal, appliedAt));
      continue;
    }
    if (change.targetType === "smart_memory_policy") {
      appliedChanges.push(upsertScopeReviewRequirement(scopePolicy, change, proposal, appliedAt));
      continue;
    }
    unsupportedChanges.push({
      ...change,
      status: "logged_only",
      reason: "unsupported_policy_target_type"
    });
  }

  if (appliedChanges.length > 0) {
    scopePolicy.updatedAt = appliedAt;
    policy.scopes = {
      ...(policy.scopes || {}),
      [scopeId]: scopePolicy
    };
    writeSmartMemoryPolicy(brainRoot, policy);
  }

  return {
    appliedChanges,
    unsupportedChanges,
    scopePolicy
  };
}

module.exports = {
  POLICY_SCHEMA_VERSION,
  smartMemoryPolicyPath,
  readSmartMemoryPolicy,
  writeSmartMemoryPolicy,
  getSmartMemoryPolicyForScope,
  applySmartMemoryPolicyChanges
};
