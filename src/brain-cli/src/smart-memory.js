"use strict";

const DECISIONS = Object.freeze({
  USE_AS_CURRENT: "use_as_current",
  USE_AS_EVIDENCE: "use_as_evidence",
  USE_AS_BACKGROUND: "use_as_background",
  NEEDS_CONFIRMATION: "needs_confirmation",
  HOLD_DUE_CONFLICT: "hold_due_conflict",
  BLOCKED_BY_POLICY: "blocked_by_policy"
});

const DEPTH_RANK = Object.freeze({
  D0: 0,
  D1: 1,
  D2: 2,
  D3: 3,
  D4: 4
});

const INTENT_RULES = [
  {
    intent: "conflict_resolution",
    pattern: /충돌|상충|불일치|정합|정정|오류|deprecated|superseded|disputed|conflict|inconsistent/i,
    depth: "D4",
    riskLevel: "high"
  },
  {
    intent: "verification",
    pattern: /검증|근거|원문|인용|출처|라인|최신|최근|현재|확인|review|verify|evidence|citation|latest|recent|current|fresh|stale/i,
    depth: "D4",
    riskLevel: "medium"
  },
  {
    intent: "handoff",
    pattern: /핸드오프|인수인계|신규\s*세션|다음\s*세션|이어|작업\s*기록|handoff|next session/i,
    depth: "D3",
    riskLevel: "medium"
  },
  {
    intent: "implementation",
    pattern: /구현|수정|고쳐|만들|테스트|빌드|코드|진행|implement|fix|build|test/i,
    depth: "D3",
    riskLevel: "medium"
  },
  {
    intent: "planning",
    pattern: /설계|기획|계획|방향|판단|전략|지시서|design|plan|architecture/i,
    depth: "D2",
    riskLevel: "medium"
  }
];

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function depthMax(...depths) {
  return depths
    .filter(Boolean)
    .sort((a, b) => (DEPTH_RANK[b] || 0) - (DEPTH_RANK[a] || 0))[0] || "D1";
}

function classifySmartMemoryIntent(goal = "") {
  const text = normalizeText(goal);
  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(text)) {
      return {
        intent: rule.intent,
        riskLevel: rule.riskLevel,
        depthBudget: rule.depth,
        reasons: [`matched:${rule.intent}`]
      };
    }
  }

  return {
    intent: "quick_answer",
    riskLevel: "low",
    depthBudget: "D1",
    reasons: ["default:quick_answer"]
  };
}

function chooseSmartMemoryDepth(intentProfile, evidenceDigest = {}, memoryGraph = {}, obsidianSignals = {}) {
  const detector = evidenceDigest.detector || {};
  const selectedDepth = obsidianSignals.selectedDepth;
  const graphDepth = memoryGraph.usedDepth;
  const evidenceDepth = detector.hasRawEvidence || detector.recommendedUse?.requireCitation ? "D4" : null;

  if (intentProfile.intent === "quick_answer") {
    return {
      depthBudget: "D1",
      usedDepth: depthMax("D1", evidenceDepth),
      escalation: evidenceDepth ? "raw_evidence_present" : "none"
    };
  }

  return {
    depthBudget: intentProfile.depthBudget,
    usedDepth: depthMax(intentProfile.depthBudget, selectedDepth, graphDepth, evidenceDepth),
    escalation: evidenceDepth ? "raw_evidence_present" : "intent_budget"
  };
}

function sourceStatusFromReasons(reasons = []) {
  const statusReason = reasons.find(reason => String(reason).startsWith("status:"));
  return statusReason ? statusReason.slice("status:".length) : null;
}

function decisionForStatus(status) {
  if (status === "disputed") return DECISIONS.NEEDS_CONFIRMATION;
  if (status === "superseded" || status === "deprecated") return DECISIONS.HOLD_DUE_CONFLICT;
  return null;
}

function judgeSmartMemoryEvidence(record = {}, context = {}) {
  if (record.analyzer === "policy") {
    return {
      decision: DECISIONS.BLOCKED_BY_POLICY,
      reason: "access_policy_blocked",
      citationRequired: false
    };
  }

  const statusDecision = decisionForStatus(sourceStatusFromReasons(record.reasons));
  if (statusDecision) {
    return {
      decision: statusDecision,
      reason: `status:${sourceStatusFromReasons(record.reasons)}`,
      citationRequired: true
    };
  }

  if (record.confidence < 50) {
    return {
      decision: DECISIONS.NEEDS_CONFIRMATION,
      reason: "weak_evidence",
      citationRequired: true
    };
  }

  if (record.analyzer === "active_state") {
    return {
      decision: DECISIONS.USE_AS_CURRENT,
      reason: "active_state_current",
      citationRequired: false
    };
  }

  if (record.analyzer === "fact" && record.reasons?.includes("status:active")) {
    return {
      decision: DECISIONS.USE_AS_CURRENT,
      reason: "active_fact",
      citationRequired: false
    };
  }

  if (record.analyzer === "obsidian") {
    const hasRawRef = record.reasons?.includes("rawRef");
    const isDeep = record.reasons?.includes("D4");
    const needsEvidence = ["verification", "conflict_resolution"].includes(context.intent);
    return {
      decision: hasRawRef || isDeep || needsEvidence ? DECISIONS.USE_AS_EVIDENCE : DECISIONS.USE_AS_BACKGROUND,
      reason: hasRawRef ? "obsidian_raw_ref" : "obsidian_context",
      citationRequired: hasRawRef || isDeep || needsEvidence
    };
  }

  if (record.analyzer === "recall") {
    const strong = record.confidence >= 70;
    return {
      decision: strong ? DECISIONS.USE_AS_EVIDENCE : DECISIONS.USE_AS_BACKGROUND,
      reason: strong ? "strong_recall" : "recall_background",
      citationRequired: context.intent === "verification"
    };
  }

  return {
    decision: DECISIONS.USE_AS_BACKGROUND,
    reason: "default_background",
    citationRequired: false
  };
}

function judgeSmartMemoryNode(node = {}, context = {}) {
  const statusDecision = decisionForStatus(node.status);
  if (statusDecision) {
    return {
      decision: statusDecision,
      reason: `node_status:${node.status}`,
      citationRequired: true
    };
  }

  const nodeType = normalizeText(node.nodeType || node.metadata?.activeType);
  const isCurrentNode = nodeType.includes("capability") || nodeType.includes("fact") || nodeType.includes("decision");
  if (isCurrentNode && (!node.status || node.status === "active")) {
    return {
      decision: DECISIONS.USE_AS_CURRENT,
      reason: "graph_current_node",
      citationRequired: false
    };
  }

  const depth = node.metadata?.depth;
  const needsEvidence = ["verification", "conflict_resolution"].includes(context.intent);
  if (depth === "D4" || needsEvidence) {
    return {
      decision: DECISIONS.USE_AS_EVIDENCE,
      reason: depth === "D4" ? "graph_d4_node" : "intent_requires_evidence",
      citationRequired: true
    };
  }

  return {
    decision: DECISIONS.USE_AS_BACKGROUND,
    reason: "graph_background_node",
    citationRequired: false
  };
}

function decisionFromEvidence(record, context) {
  const judged = judgeSmartMemoryEvidence(record, context);
  return {
    ref: record.ref,
    source: record.analyzer,
    label: record.label,
    confidence: record.confidence,
    evidenceStrength: record.evidenceStrength,
    decision: judged.decision,
    reason: judged.reason,
    citationRequired: judged.citationRequired
  };
}

function decisionFromGraphNode(node, context) {
  const judged = judgeSmartMemoryNode(node, context);
  return {
    ref: node.nodeId || node.sourceRef,
    source: "memory_graph",
    label: node.title || node.summary || node.nodeId,
    confidence: node.activationScore,
    sourceRef: node.sourceRef,
    decision: judged.decision,
    reason: judged.reason,
    citationRequired: judged.citationRequired
  };
}

function uniqueDecisions(decisions) {
  const seen = new Set();
  const unique = [];
  for (const decision of decisions) {
    const key = `${decision.source}:${decision.ref}:${decision.decision}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(decision);
  }
  return unique;
}

function activePolicySignals(policy = {}) {
  const activeInhibitions = (policy.inhibitionSignals || []).filter(signal =>
    signal.status !== "inactive" && Number(signal.strength || 0) > 0
  );
  const activeReviewRequirements = (policy.reviewRequirements || []).filter(requirement =>
    requirement.status !== "inactive" && Number(requirement.strength || 0) > 0
  );
  const scopeReviewRequirement = policy.scopeReviewRequirement?.status !== "inactive" &&
    Number(policy.scopeReviewRequirement?.strength || 0) > 0
    ? policy.scopeReviewRequirement
    : null;
  return {
    activeInhibitions,
    activeReviewRequirements,
    scopeReviewRequirement
  };
}

function buildAnswerPolicy(decisions, intentProfile, depthProfile, evidenceDigest = {}, memoryGraph = {}, blockedRefs = [], policy = {}) {
  const detectorUse = evidenceDigest.detector?.recommendedUse || {};
  const policySignals = activePolicySignals(policy);
  const graphInhibitsRepeating = (memoryGraph.inhibitionSignals || []).some(signal =>
    signal.signal === "avoid_repeating_existing_capability"
  );
  const policyInhibitsRepeating = policySignals.activeInhibitions.some(signal =>
    signal.signal === "avoid_repeating_existing_capability"
  );
  const policyRequiresReview = Boolean(policySignals.scopeReviewRequirement) ||
    decisions.some(decision => policySignals.activeReviewRequirements.some(requirement => requirement.ref === decision.ref));
  const hasCurrent = decisions.some(decision => decision.decision === DECISIONS.USE_AS_CURRENT);
  const hasEvidence = decisions.some(decision => decision.decision === DECISIONS.USE_AS_EVIDENCE);
  const hasConfirmationNeed = decisions.some(decision => decision.decision === DECISIONS.NEEDS_CONFIRMATION);
  const hasHeldConflict = decisions.some(decision => decision.decision === DECISIONS.HOLD_DUE_CONFLICT);
  const hasBlocked = blockedRefs.length > 0 || decisions.some(decision => decision.decision === DECISIONS.BLOCKED_BY_POLICY);
  const requiresCitation = detectorUse.requireCitation ||
    depthProfile.usedDepth === "D4" ||
    decisions.some(decision => decision.citationRequired);

  return {
    canAssertCurrentFact: hasCurrent && !hasHeldConflict && !hasBlocked,
    shouldUseEvidence: hasEvidence || detectorUse.useForAnswer === true,
    requiresCitation,
    requiresUserConfirmation: detectorUse.requireReview || hasConfirmationNeed || hasHeldConflict || policyRequiresReview,
    avoidRepeatingExistingCapability: detectorUse.avoidRepeatingAsNew || graphInhibitsRepeating || policyInhibitsRepeating,
    blockedByPolicy: hasBlocked,
    policyApplied: policySignals.activeInhibitions.length > 0 ||
      policySignals.activeReviewRequirements.length > 0 ||
      Boolean(policySignals.scopeReviewRequirement),
    policyReasons: [
      ...policySignals.activeInhibitions.map(signal => `inhibition:${signal.signal}`),
      ...policySignals.activeReviewRequirements.map(requirement => `review:${requirement.ref}`),
      policySignals.scopeReviewRequirement ? "scope_review_requirement" : null
    ].filter(Boolean),
    groundingMode: hasHeldConflict || hasConfirmationNeed
      ? "review_before_answer"
      : policyRequiresReview
        ? "review_before_answer"
      : hasCurrent
        ? "current_fact_first"
        : requiresCitation
          ? "evidence_first"
          : "background_context",
    intent: intentProfile.intent,
    riskLevel: intentProfile.riskLevel
  };
}

function buildDecisionCounts(decisions) {
  return decisions.reduce((counts, decision) => {
    counts[decision.decision] = (counts[decision.decision] || 0) + 1;
    return counts;
  }, {});
}

function buildSmartMemorySection({
  scopeId,
  goal,
  channelMode,
  evidenceDigest = {},
  memoryGraph = {},
  obsidianSignals = {},
  blockedRefs = [],
  policy = {}
} = {}) {
  const intentProfile = classifySmartMemoryIntent(goal);
  const depthProfile = chooseSmartMemoryDepth(intentProfile, evidenceDigest, memoryGraph, obsidianSignals);
  const context = {
    intent: intentProfile.intent,
    riskLevel: intentProfile.riskLevel
  };
  const evidenceDecisions = (evidenceDigest.records || [])
    .slice(0, 12)
    .map(record => decisionFromEvidence(record, context));
  const graphDecisions = (memoryGraph.activatedNodes || [])
    .slice(0, 8)
    .map(node => decisionFromGraphNode(node, context));
  const policyDecisions = blockedRefs.map(ref => ({
    ref,
    source: "access_policy",
    label: ref,
    confidence: 100,
    decision: DECISIONS.BLOCKED_BY_POLICY,
    reason: "blocked_ref",
    citationRequired: false
  }));
  const decisions = uniqueDecisions([...evidenceDecisions, ...graphDecisions, ...policyDecisions]).slice(0, 20);
  const answerPolicy = buildAnswerPolicy(decisions, intentProfile, depthProfile, evidenceDigest, memoryGraph, blockedRefs, policy);
  const policySignals = activePolicySignals(policy);

  return {
    schemaVersion: "smart-memory/v1",
    scopeId,
    goal,
    channelMode,
    intent: intentProfile.intent,
    riskLevel: intentProfile.riskLevel,
    intentReasons: intentProfile.reasons,
    depth: depthProfile,
    decisions,
    decisionCounts: buildDecisionCounts(decisions),
    answerPolicy,
    policy: {
      schemaVersion: policy.schemaVersion || "smart-memory-policy/v1",
      scopeId: policy.scopeId || scopeId,
      inhibitionSignals: policySignals.activeInhibitions,
      reviewRequirements: policySignals.activeReviewRequirements,
      scopeReviewRequirement: policySignals.scopeReviewRequirement
    },
    sourceSections: {
      evidenceRecords: evidenceDigest.records?.length || 0,
      graphNodes: memoryGraph.activatedNodes?.length || 0,
      obsidianSections: obsidianSignals.sections?.length || 0,
      blockedRefs: blockedRefs.length
    }
  };
}

module.exports = {
  DECISIONS,
  classifySmartMemoryIntent,
  chooseSmartMemoryDepth,
  judgeSmartMemoryEvidence,
  judgeSmartMemoryNode,
  buildSmartMemorySection
};
