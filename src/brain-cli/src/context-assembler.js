"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ensureDir, isoNow } = require("./utils");
const { search } = require("./search");
const { loadActiveState } = require("./active-state");
const { getAllowedUserContext } = require("./user-ontology");
const { listFacts } = require("./fact-ledger");
const { retrieveDepth } = require("./depth-retriever");
const { filterMemoryItems, normalizeChannelMode } = require("./access-policy");
const { buildMemoryGraphBrief } = require("./memory-graph");
const { buildSmartMemorySection } = require("./smart-memory");
const { getSmartMemoryPolicyForScope } = require("./smart-memory-policy");

function briefIdFor(scopeId, goal) {
  const digest = crypto.createHash("sha1").update(`${scopeId}:${goal}:${Date.now()}`).digest("hex").slice(0, 10);
  return `brief_${digest}`;
}

function briefDir(brainRoot, scopeId) {
  return path.join(brainRoot, "44_usage", scopeId, "briefs");
}

function briefPath(brainRoot, scopeId, briefId) {
  return path.join(briefDir(brainRoot, scopeId), `${briefId}.json`);
}

function rootLabel(rootPath) {
  return path.basename(rootPath);
}

function existingPeerRoots(primaryRoot, peerRoots = []) {
  const seen = new Set([path.resolve(primaryRoot).toLowerCase()]);
  const roots = [];
  for (const root of peerRoots || []) {
    if (!root || !fs.existsSync(path.join(root, "90_index"))) continue;
    const resolved = path.resolve(root);
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(resolved);
  }
  return roots;
}

function mergeByKey(items, keyFn, preferPrimary = true) {
  const byKey = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    if (preferPrimary && existing._rootRole !== "primary" && item._rootRole === "primary") {
      byKey.set(key, item);
      continue;
    }
    if ((item.score || 0) > (existing.score || 0)) byKey.set(key, item);
  }
  return Array.from(byKey.values());
}

function collectActiveState(brainRoot, scopeId, peerRoots) {
  const states = [];
  for (const root of [brainRoot, ...peerRoots]) {
    try {
      const state = loadActiveState(root, scopeId, { createIfMissing: root === brainRoot });
      states.push({
        ...state,
        _root: root,
        _rootRole: root === brainRoot ? "primary" : "peer",
        _source: rootLabel(root)
      });
    } catch { /* peer Active State 실패는 primary 흐름을 막지 않는다 */ }
  }
  const base = states[0] || loadActiveState(brainRoot, scopeId);
  return {
    ...base,
    facts: mergeByKey(states.flatMap(state => (state.facts || []).map(item => ({
      ...item,
      _source: state._source,
      _rootRole: state._rootRole
    }))), item => item.id),
    decisions: mergeByKey(states.flatMap(state => (state.decisions || []).map(item => ({
      ...item,
      _source: state._source,
      _rootRole: state._rootRole
    }))), item => item.id || item.title),
    capabilities: mergeByKey(states.flatMap(state => (state.capabilities || []).map(item => ({
      ...item,
      _source: state._source,
      _rootRole: state._rootRole
    }))), item => item.id || item.title),
    guardHints: mergeByKey(states.flatMap(state => (state.guardHints || []).map(item => ({
      ...item,
      _source: state._source,
      _rootRole: state._rootRole
    }))), item => item.id || item.rule),
    sourceRefs: Array.from(new Set(states.flatMap(state => state.sourceRefs || []))),
    peerRoots: peerRoots.map(root => rootLabel(root))
  };
}

function collectFacts(brainRoot, scopeId, peerRoots) {
  const facts = [];
  for (const root of [brainRoot, ...peerRoots]) {
    try {
      facts.push(...listFacts(root, { scopeId }).map(fact => ({
        ...fact,
        _source: rootLabel(root),
        _rootRole: root === brainRoot ? "primary" : "peer"
      })));
    } catch { /* peer fact 실패는 primary 흐름을 막지 않는다 */ }
  }
  return mergeByKey(facts, fact => fact.factId);
}

function collectRecall(brainRoot, query, peerRoots) {
  const items = [];
  for (const root of [brainRoot, ...peerRoots]) {
    try {
      const result = search(root, query);
      items.push(...(result.candidates || []).map(candidate => ({
        ...candidate,
        _source: rootLabel(root),
        _rootRole: root === brainRoot ? "primary" : "peer"
      })));
    } catch { /* peer recall 실패는 primary 흐름을 막지 않는다 */ }
  }
  const candidates = mergeByKey(items, item => item.recordId)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, query.topK || 5);
  return { candidates, total: candidates.length };
}

function collectObsidianSignals(brainRoot, options, peerRoots) {
  const sections = [];
  const usedRefs = new Set();
  const roots = [brainRoot, ...peerRoots];
  let selectedDepth = null;

  for (const root of roots) {
    try {
      const result = retrieveDepth(root, options);
      if (!selectedDepth && result.selectedDepth) selectedDepth = result.selectedDepth;
      for (const section of result.sections || []) {
        sections.push({
          ...section,
          _source: rootLabel(root),
          _rootRole: root === brainRoot ? "primary" : "peer"
        });
      }
      for (const ref of result.usedRefs || []) usedRefs.add(ref);
    } catch { /* peer Obsidian retrieval 실패는 primary 흐름을 막지 않는다 */ }
  }

  const mergedSections = mergeByKey(sections, section =>
    section.depthEntryId || `${section.path}:${section.lineStart || section.line || ""}:${section.depth || ""}`
  )
    .sort((a, b) => (b.score || 0) - (a.score || 0) || String(a.depth || "").localeCompare(String(b.depth || "")))
    .slice(0, Number(options.topK || 5));

  return {
    goal: options.goal || "",
    requestedDepth: options.depth || "auto",
    selectedDepth: selectedDepth || retrieveDepth(brainRoot, { ...options, topK: 1 }).selectedDepth,
    sections: mergedSections,
    usedRefs: Array.from(usedRefs),
    roots: roots.map(root => rootLabel(root))
  };
}

function clampScore(score) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function evidenceBand(score) {
  if (score >= 85) return "overwhelming";
  if (score >= 70) return "strong";
  if (score >= 50) return "clear";
  if (score >= 30) return "weak";
  return "trace";
}

function rootBonus(item) {
  return item._rootRole === "primary" ? 5 : 0;
}

function buildEvidenceRecord(analyzer, ref, label, score, item, reasons = []) {
  const confidence = clampScore(score);
  return {
    analyzer,
    analyzerRole: analyzerRole(analyzer),
    ref,
    label,
    confidence,
    evidenceStrength: evidenceBand(confidence),
    source: item?._source,
    rootRole: item?._rootRole,
    reasons: reasons.filter(Boolean)
  };
}

function analyzerRole(analyzer) {
  const roles = {
    active_state: "current_state",
    fact: "fact_ledger",
    recall: "long_term_recall",
    obsidian: "source_document",
    policy: "access_policy"
  };
  return roles[analyzer] || "unknown";
}

function buildBandCounts(records) {
  const bands = {};
  for (const record of records) {
    bands[record.evidenceStrength] = (bands[record.evidenceStrength] || 0) + 1;
  }
  return bands;
}

const REVIEW_INTENT_PATTERN = /원문|라인|line|인용|출처|근거|검증|충돌|정합|최신|latest|recent|current|fresh|stale/i;
const FRESHNESS_INTENT_PATTERN = /최신|최신성|최근|현재|latest|recent|current|fresh|stale/i;

function normalizeComparable(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function textIncludesComparable(text, value) {
  const normalizedValue = normalizeComparable(value);
  return normalizedValue.length > 0 && normalizeComparable(text).includes(normalizedValue);
}

function factAxisKey(fact) {
  return [
    normalizeComparable(fact.scopeId),
    normalizeComparable(fact.subject),
    normalizeComparable(fact.predicate)
  ].join("::");
}

function obsidianSectionText(section) {
  return [
    section.heading,
    section.summary,
    section.rawRef,
    section.path
  ].filter(Boolean).join(" ");
}

function sectionMentionsFactAxis(sectionText, facts) {
  return facts.some(fact =>
    textIncludesComparable(sectionText, fact.subject) ||
    textIncludesComparable(sectionText, fact.predicate) ||
    textIncludesComparable(sectionText, fact.object)
  );
}

function buildFactReviewSignals(facts = [], obsidianSignals = {}, goal = "") {
  const d4Sections = (obsidianSignals.sections || []).filter(section => section.depth === "D4" && section.rawRef);
  const signals = {
    requireReview: false,
    reasons: []
  };
  if (d4Sections.length === 0 || !REVIEW_INTENT_PATTERN.test(String(goal || ""))) return signals;

  const reasonSet = new Set();
  const factsByAxis = new Map();
  for (const fact of facts || []) {
    const key = factAxisKey(fact);
    if (!factsByAxis.has(key)) factsByAxis.set(key, []);
    factsByAxis.get(key).push(fact);
  }

  let matchedFactAxis = false;
  for (const axisFacts of factsByAxis.values()) {
    const matchedSections = d4Sections.filter(section => sectionMentionsFactAxis(obsidianSectionText(section), axisFacts));
    if (matchedSections.length === 0) continue;
    matchedFactAxis = true;

    const activeFacts = axisFacts.filter(fact => fact.status === "active" || !fact.status);
    const disputedFacts = axisFacts.filter(fact => fact.status === "disputed");
    const supersededFacts = axisFacts.filter(fact => fact.status === "superseded");
    const objectCount = new Set(axisFacts.map(fact => normalizeComparable(fact.object)).filter(Boolean)).size;

    if (disputedFacts.length > 0) reasonSet.add("disputed_fact_present");
    if (supersededFacts.length > 0) reasonSet.add("superseded_fact_present");
    if (objectCount > 1) reasonSet.add("fact_axis_multiple_objects");

    for (const activeFact of activeFacts) {
      const challengingFacts = axisFacts.filter(fact =>
        fact.factId !== activeFact.factId &&
        normalizeComparable(fact.object) !== normalizeComparable(activeFact.object)
      );
      for (const section of matchedSections) {
        const sectionText = obsidianSectionText(section);
        const rawSupportsDifferentObject = challengingFacts.some(fact => textIncludesComparable(sectionText, fact.object));
        const rawSupportsActiveObject = textIncludesComparable(sectionText, activeFact.object);
        if (rawSupportsDifferentObject && !rawSupportsActiveObject) {
          reasonSet.add("fact_obsidian_conflict");
        }
      }
    }
  }

  if (matchedFactAxis && FRESHNESS_INTENT_PATTERN.test(String(goal || ""))) {
    reasonSet.add("freshness_review_required");
  }

  signals.reasons = Array.from(reasonSet);
  signals.requireReview = signals.reasons.length > 0;
  return signals;
}

function buildDetectorProfile(records, byAnalyzer, reviewSignals = {}) {
  const usableRecords = records.filter(record => record.analyzer !== "policy");
  const highConfidenceRecords = usableRecords.filter(record => record.confidence >= 70);
  const analyzers = Object.keys(byAnalyzer).filter(analyzer => analyzer !== "policy");
  const highConfidenceAnalyzers = new Set(highConfidenceRecords.map(record => record.analyzer));
  const hasPolicyBlocks = (byAnalyzer.policy || 0) > 0;
  const hasRawEvidence = usableRecords.some(record => record.reasons.includes("rawRef"));
  const hasWeakOnly = usableRecords.length > 0 && highConfidenceRecords.length === 0;

  let agreementLevel = "none";
  if (highConfidenceAnalyzers.size >= 3) agreementLevel = "multi_analyzer_strong";
  else if (highConfidenceAnalyzers.size === 2) agreementLevel = "two_analyzer_support";
  else if (highConfidenceAnalyzers.size === 1) agreementLevel = "single_analyzer_support";
  else if (usableRecords.length > 0) agreementLevel = "trace_only";

  const detectorConfidence = clampScore(
    highConfidenceRecords.reduce((max, record) => Math.max(max, record.confidence), 0)
    + Math.min(15, Math.max(0, highConfidenceAnalyzers.size - 1) * 7)
    - (hasPolicyBlocks ? 20 : 0)
    - (hasWeakOnly ? 15 : 0)
  );

  let status = "insufficient_evidence";
  if (hasPolicyBlocks && usableRecords.length === 0) {
    status = "blocked";
  } else if (detectorConfidence >= 85 && highConfidenceAnalyzers.size >= 2) {
    status = "use_as_primary_context";
  } else if (detectorConfidence >= 65) {
    status = "use_with_citations";
  } else if (usableRecords.length > 0) {
    status = "review_before_use";
  }

  if (reviewSignals.requireReview && status !== "blocked") {
    status = "review_before_use";
  }

  const recommendedUse = {
    useForAnswer: ["use_as_primary_context", "use_with_citations"].includes(status),
    requireCitation: hasRawEvidence || status === "use_with_citations",
    requireReview: status === "review_before_use" || hasPolicyBlocks || Boolean(reviewSignals.requireReview),
    avoidRepeatingAsNew: highConfidenceRecords.some(record =>
      record.analyzer === "active_state" ||
      (record.analyzer === "fact" && record.reasons.includes("status:active"))
    )
  };

  const reasons = [];
  if (highConfidenceAnalyzers.size > 1) reasons.push("cross-analyzer agreement");
  if (hasRawEvidence) reasons.push("raw source evidence available");
  if (hasPolicyBlocks) reasons.push("access policy blocks some refs");
  if (hasWeakOnly) reasons.push("only weak or trace evidence");
  if (usableRecords.length === 0) reasons.push("no usable evidence");
  for (const reason of reviewSignals.reasons || []) reasons.push(reason);

  return {
    status,
    detectorConfidence,
    agreementLevel,
    analyzerCount: analyzers.length,
    highConfidenceAnalyzerCount: highConfidenceAnalyzers.size,
    hasPolicyBlocks,
    hasRawEvidence,
    recommendedUse,
    reasons
  };
}

function buildEvidenceDigest({ activeState, facts, recall, obsidianSignals, blockedRefs, goal }) {
  const records = [];

  for (const capability of activeState.capabilities || []) {
    records.push(buildEvidenceRecord(
      "active_state",
      capability.id || capability.title,
      capability.title || capability.id || "capability",
      78 + rootBonus(capability) + Math.min(10, (capability.sourceRefs || []).length * 3),
      capability,
      ["active capability", (capability.sourceRefs || []).length > 0 ? "has sourceRefs" : ""]
    ));
  }

  for (const decision of activeState.decisions || []) {
    records.push(buildEvidenceRecord(
      "active_state",
      decision.id || decision.title,
      decision.title || decision.id || "decision",
      74 + rootBonus(decision),
      decision,
      ["active decision"]
    ));
  }

  for (const fact of facts || []) {
    const sourceBoost = fact.sourceType === "user_confirmed" ? 15 : 0;
    const status = fact.status || "active";
    const statusPenalty = status === "active" ? 0 : status === "disputed" ? -35 : -40;
    const confidence = typeof fact.confidence === "number" ? fact.confidence * 100 : 72;
    records.push(buildEvidenceRecord(
      "fact",
      fact.factId,
      `${fact.subject || ""} ${fact.predicate || ""} ${fact.object || ""}`.trim(),
      confidence + sourceBoost + statusPenalty + rootBonus(fact),
      fact,
      [fact.sourceType, `status:${status}`, (fact.sourceRefs || []).length > 0 ? "has sourceRefs" : ""]
    ));
  }

  for (const item of recall || []) {
    const sourceBoost = item.sourceType === "user_confirmed" ? 15 : 0;
    const statusBoost = item.status === "active" || !item.status ? 5 : 0;
    records.push(buildEvidenceRecord(
      "recall",
      item.recordId,
      item.title || item.recordId,
      35 + Math.min(35, (item.score || 0) * 8) + sourceBoost + statusBoost + rootBonus(item),
      item,
      [`search score ${item.score || 0}`, item.sourceType]
    ));
  }

  for (const section of obsidianSignals.sections || []) {
    const depthBoost = section.depth === "D4" ? 20 : section.depth === "D3" ? 15 : section.depth === "D2" ? 10 : 0;
    records.push(buildEvidenceRecord(
      "obsidian",
      section.depthEntryId,
      section.heading || section.rawRef || section.path,
      40 + Math.min(25, (section.score || 0) * 8) + depthBoost + rootBonus(section),
      section,
      [section.depth, section.rawRef ? "rawRef" : ""]
    ));
  }

  for (const ref of blockedRefs || []) {
    records.push({
      analyzer: "policy",
      analyzerRole: analyzerRole("policy"),
      ref,
      label: ref,
      confidence: 100,
      evidenceStrength: "blocked",
      reasons: ["blocked by access policy"]
    });
  }

  const sorted = records.sort((a, b) => b.confidence - a.confidence || String(a.ref).localeCompare(String(b.ref)));
  const byAnalyzer = {};
  for (const record of sorted) {
    byAnalyzer[record.analyzer] = (byAnalyzer[record.analyzer] || 0) + 1;
  }
  const bandCounts = buildBandCounts(sorted);
  const reviewSignals = buildFactReviewSignals(facts, obsidianSignals, goal);
  const detector = buildDetectorProfile(sorted, byAnalyzer, reviewSignals);

  return {
    rubric: "ordinal_evidence_strength",
    records: sorted.slice(0, 20),
    byAnalyzer,
    bandCounts,
    detector,
    strongestRefs: sorted.slice(0, 5).map(record => record.ref),
    weakRefs: sorted.filter(record => record.confidence < 50).slice(0, 5).map(record => record.ref)
  };
}

function createMemoryBrief(brainRoot, options = {}) {
  const scopeId = options.project || options.scopeId;
  if (!scopeId) throw new Error("--project 또는 scopeId가 필요합니다.");
  const goal = options.goal || "";
  const peerRoots = existingPeerRoots(brainRoot, options.peerRoots);
  const activeState = collectActiveState(brainRoot, scopeId, peerRoots);
  const channelMode = normalizeChannelMode(options.channelMode || options.channel || "codex_local");
  const userContext = getAllowedUserContext(brainRoot, {
    userId: options.userId || "ernham",
    channel: options.channel || "codex_local",
    channelMode
  });
  const recall = collectRecall(brainRoot, {
    currentGoal: goal,
    goal,
    scopeType: options.scopeType || "project",
    scopeId,
    topK: options.topK || 5
  }, peerRoots);

  const facts = collectFacts(brainRoot, scopeId, peerRoots);
  const obsidianSignals = options.includeObsidian === false
    ? { sections: [], usedRefs: [] }
    : collectObsidianSignals(brainRoot, {
      scopeId,
      goal,
      depth: options.depth || "auto",
      topK: options.depthTopK || 5
    }, peerRoots);

  const recallItems = (recall.candidates || []).map(item => ({
    ...item,
    ref: item.recordId,
    visibility: item.visibility || "project",
    content: `${item.title || ""} ${item.summary || ""}`
  }));
  const factItems = facts.map(fact => ({
    ...fact,
    ref: fact.factId,
    visibility: fact.visibility || "project",
    content: `${fact.subject} ${fact.predicate} ${fact.object}`
  }));
  const obsidianItems = (obsidianSignals.sections || []).map(section => ({
    ...section,
    ref: section.depthEntryId,
    visibility: section.visibility || "project",
    content: `${section.heading || ""} ${section.summary || ""}`
  }));

  const recallFiltered = filterMemoryItems(brainRoot, recallItems, {
    channelMode,
    conversationId: options.conversationId
  });
  const factFiltered = filterMemoryItems(brainRoot, factItems, {
    channelMode,
    conversationId: options.conversationId
  });
  const obsidianFiltered = filterMemoryItems(brainRoot, obsidianItems, {
    channelMode,
    conversationId: options.conversationId
  });

  const usedRefs = new Set();
  for (const ref of activeState.sourceRefs || []) usedRefs.add(ref);
  for (const capability of activeState.capabilities || []) {
    for (const ref of capability.sourceRefs || []) usedRefs.add(ref);
  }
  for (const fact of factFiltered.allowed) usedRefs.add(fact.factId);
  for (const item of recallFiltered.allowed) usedRefs.add(item.recordId);
  for (const ref of obsidianSignals.usedRefs || []) usedRefs.add(ref);

  const blockedRefs = [
    ...recallFiltered.blockedRefs,
    ...factFiltered.blockedRefs,
    ...obsidianFiltered.blockedRefs
  ];
  const evidenceDigest = buildEvidenceDigest({
    activeState,
    facts: factFiltered.allowed,
    recall: recallFiltered.allowed,
    obsidianSignals: {
      ...obsidianSignals,
      sections: obsidianFiltered.allowed
    },
    blockedRefs,
    goal
  });
  const memoryGraph = buildMemoryGraphBrief(brainRoot, {
    scopeId,
    goal,
    topK: options.graphTopK || 8
  });
  const smartMemoryPolicy = getSmartMemoryPolicyForScope(brainRoot, scopeId);
  const filteredObsidianSignals = {
    ...obsidianSignals,
    sections: obsidianFiltered.allowed
  };
  const smartMemory = buildSmartMemorySection({
    scopeId,
    goal,
    channelMode,
    evidenceDigest,
    memoryGraph,
    obsidianSignals: filteredObsidianSignals,
    blockedRefs,
    policy: smartMemoryPolicy
  });

  const brief = {
    briefId: briefIdFor(scopeId, goal),
    scopeId,
    goal,
    createdAt: isoNow(),
    sections: {
      activeState,
      facts: factFiltered.allowed,
      userOntology: userContext,
      recall: recallFiltered.allowed,
      obsidianSignals: filteredObsidianSignals,
      memoryGraph,
      evidenceDigest,
      smartMemory
    },
    usedRefs: Array.from(usedRefs),
    blockedRefs,
    warnings: []
  };

  if (peerRoots.length > 0) {
    brief.roots = {
      primary: rootLabel(brainRoot),
      peers: peerRoots.map(root => rootLabel(root))
    };
  }

  if ((activeState.capabilities || []).length === 0) {
    brief.warnings.push("active_state_empty");
  }
  if ((recall.candidates || []).length === 0) {
    brief.warnings.push("recall_empty");
  }

  ensureDir(briefDir(brainRoot, scopeId));
  fs.writeFileSync(briefPath(brainRoot, scopeId, brief.briefId), JSON.stringify(brief, null, 2), "utf-8");
  return brief;
}

function loadMemoryBrief(brainRoot, briefIdOrPath) {
  if (fs.existsSync(briefIdOrPath)) {
    return JSON.parse(fs.readFileSync(briefIdOrPath, "utf-8"));
  }

  const usageRoot = path.join(brainRoot, "44_usage");
  if (!fs.existsSync(usageRoot)) {
    throw new Error(`Brief를 찾을 수 없습니다: ${briefIdOrPath}`);
  }

  const stack = [usageRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.name === `${briefIdOrPath}.json`) {
        return JSON.parse(fs.readFileSync(fullPath, "utf-8"));
      }
    }
  }

  throw new Error(`Brief를 찾을 수 없습니다: ${briefIdOrPath}`);
}

module.exports = {
  createMemoryBrief,
  loadMemoryBrief,
  briefPath,
  briefDir,
  existingPeerRoots,
  collectFacts,
  collectRecall,
  collectObsidianSignals,
  collectActiveState,
  buildEvidenceDigest
};
