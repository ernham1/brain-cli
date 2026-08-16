"use strict";

const path = require("path");
const crypto = require("crypto");
const { ensureDir, isoNow, normalizeTokens, readJsonl, writeJsonl } = require("./utils");
const { readSources } = require("./obsidian-connector");
const { depthIndexPath } = require("./depth-retriever");
const { listFacts } = require("./fact-ledger");
const { loadActiveState } = require("./active-state");
const { DEFAULT_RELATION_STRENGTH } = require("./ontology-relations");

const DEPTH_ORDER = ["D0", "D1", "D2", "D3", "D4"];

function memoryGraphDir(brainRoot) {
  return path.join(brainRoot, "49_memory_graph");
}

function nodesPath(brainRoot) {
  return path.join(memoryGraphDir(brainRoot), "nodes.jsonl");
}

function edgesPath(brainRoot) {
  return path.join(memoryGraphDir(brainRoot), "edges.jsonl");
}

function activationsPath(brainRoot) {
  return path.join(memoryGraphDir(brainRoot), "activations.jsonl");
}

function consolidationLogPath(brainRoot) {
  return path.join(memoryGraphDir(brainRoot), "consolidation-log.jsonl");
}

function graphPolicyPath(brainRoot) {
  return path.join(memoryGraphDir(brainRoot), "graph-policy.json");
}

function stableId(prefix, parts) {
  const seed = parts.map(part => String(part || "")).join("|").toLowerCase();
  return `${prefix}_${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 16)}`;
}

function nodeIdFor(nodeType, sourceRef) {
  return stableId("node", [nodeType, sourceRef]);
}

function edgeIdFor(fromNodeId, toNodeId, relation) {
  return stableId("edge", [fromNodeId, relation, toNodeId]);
}

function readNodes(brainRoot) {
  return readJsonl(nodesPath(brainRoot));
}

function writeNodes(brainRoot, nodes) {
  ensureDir(memoryGraphDir(brainRoot));
  writeJsonl(nodesPath(brainRoot), nodes);
  return nodes;
}

function readEdges(brainRoot) {
  return readJsonl(edgesPath(brainRoot));
}

function writeEdges(brainRoot, edges) {
  ensureDir(memoryGraphDir(brainRoot));
  writeJsonl(edgesPath(brainRoot), edges);
  return edges;
}

function readConsolidationLog(brainRoot) {
  return readJsonl(consolidationLogPath(brainRoot));
}

function readActivationLog(brainRoot) {
  return readJsonl(activationsPath(brainRoot));
}

function appendActivationLog(brainRoot, entry) {
  ensureDir(memoryGraphDir(brainRoot));
  const records = readActivationLog(brainRoot);
  const now = isoNow();
  const record = {
    activationId: entry.activationId || stableId("activation", [
      entry.scopeId,
      entry.goal,
      now,
      records.length
    ]),
    scopeId: entry.scopeId || "unknown",
    goal: entry.goal || "",
    activatedNodeIds: Array.from(new Set(entry.activatedNodeIds || [])).filter(Boolean),
    activatedEdgeIds: Array.from(new Set(entry.activatedEdgeIds || [])).filter(Boolean),
    inhibitionSignals: cloneSignalList(entry.inhibitionSignals),
    reviewSignals: cloneSignalList(entry.reviewSignals),
    usedDepth: entry.usedDepth || null,
    createdAt: now
  };
  records.push(record);
  writeJsonl(activationsPath(brainRoot), records);
  return record;
}

function appendConsolidationLog(brainRoot, entry) {
  ensureDir(memoryGraphDir(brainRoot));
  const records = readConsolidationLog(brainRoot);
  const now = isoNow();
  const record = {
    logId: entry.logId || stableId("consolidation", [
      entry.scopeId,
      entry.source,
      entry.eventType,
      entry.resultId,
      now,
      records.length
    ]),
    scopeId: entry.scopeId || "unknown",
    source: entry.source || "unknown",
    eventType: entry.eventType || "event",
    resultId: entry.resultId || null,
    status: entry.status || null,
    failureType: entry.failureType || null,
    hitCount: entry.hitCount || null,
    activation: normalizeActivationSnapshot(entry.activation),
    metadata: entry.metadata || {},
    createdAt: now
  };
  records.push(record);
  writeJsonl(consolidationLogPath(brainRoot), records);
  return record;
}

function activationSnapshotFromMemoryGraph(memoryGraph) {
  const section = memoryGraph || {};
  return normalizeActivationSnapshot({
    activatedNodeIds: (section.activatedNodes || []).map(node => node.nodeId),
    activatedEdgeIds: (section.activatedEdges || []).map(edge => edge.edgeId),
    inhibitionSignals: section.inhibitionSignals || [],
    reviewSignals: section.reviewSignals || [],
    usedDepth: section.usedDepth || null
  });
}

function normalizeActivationSnapshot(activation = {}) {
  return {
    activatedNodeIds: Array.from(new Set(activation.activatedNodeIds || [])).filter(Boolean),
    activatedEdgeIds: Array.from(new Set(activation.activatedEdgeIds || [])).filter(Boolean),
    inhibitionSignals: cloneSignalList(activation.inhibitionSignals),
    reviewSignals: cloneSignalList(activation.reviewSignals),
    usedDepth: activation.usedDepth || null
  };
}

function cloneSignalList(signals) {
  return Array.isArray(signals)
    ? signals.map(signal => ({ ...signal }))
    : [];
}

function upsertNodes(brainRoot, incomingNodes) {
  const byId = new Map(readNodes(brainRoot).map(node => [node.nodeId, node]));
  const now = isoNow();
  for (const node of incomingNodes) {
    const previous = byId.get(node.nodeId);
    byId.set(node.nodeId, {
      ...previous,
      ...node,
      createdAt: previous?.createdAt || node.createdAt || now,
      updatedAt: now
    });
  }
  return writeNodes(brainRoot, Array.from(byId.values()).sort(compareById("nodeId")));
}

function upsertEdges(brainRoot, incomingEdges) {
  const byId = new Map(readEdges(brainRoot).map(edge => [edge.edgeId, edge]));
  const now = isoNow();
  for (const edge of incomingEdges) {
    const previous = byId.get(edge.edgeId);
    byId.set(edge.edgeId, {
      ...previous,
      ...edge,
      createdAt: previous?.createdAt || edge.createdAt || now,
      updatedAt: now
    });
  }
  return writeEdges(brainRoot, Array.from(byId.values()).sort(compareById("edgeId")));
}

function compareById(key) {
  return (a, b) => String(a[key]).localeCompare(String(b[key]));
}

function ensureGraphPolicy(brainRoot) {
  ensureDir(memoryGraphDir(brainRoot));
  const filePath = graphPolicyPath(brainRoot);
  if (!require("fs").existsSync(filePath)) {
    require("fs").writeFileSync(filePath, JSON.stringify(defaultGraphPolicy(), null, 2), "utf-8");
  }
  return filePath;
}

function defaultGraphPolicy() {
  return {
    version: 1,
    defaultWeights: {
      supports: 0.7,
      derived_from: 0.65,
      promoted_to: 0.8,
      contains: 0.6,
      same_scope: 0.4,
      contradicts: -0.8,
      requires_confirmation: -0.5,
      inputs_from: 0.75,
      outputs_to: 0.8,
      depends_on: 0.75,
      verifies: 0.75,
      reviewed_by: 0.7,
      supersedes: 0.85,
      similar_to: 0.45,
      belongs_to: 0.55,
      used_for: 0.65,
      blocked_by: -0.8,
      related_to: 0.35
    },
    blockedNodeTypes: [],
    blockedSourceRefs: [],
    maxDepthByChannelMode: {},
    createdAt: isoNow()
  };
}

function loadGraphPolicy(brainRoot) {
  ensureGraphPolicy(brainRoot);
  const saved = require("fs").existsSync(graphPolicyPath(brainRoot))
    ? JSON.parse(require("fs").readFileSync(graphPolicyPath(brainRoot), "utf-8"))
    : {};
  return {
    ...defaultGraphPolicy(),
    ...saved,
    defaultWeights: {
      ...defaultGraphPolicy().defaultWeights,
      ...(saved.defaultWeights || {})
    },
    blockedNodeTypes: saved.blockedNodeTypes || [],
    blockedSourceRefs: saved.blockedSourceRefs || [],
    maxDepthByChannelMode: saved.maxDepthByChannelMode || {}
  };
}

function seedGraphFromSources(brainRoot, options = {}) {
  const scopeId = options.scopeId || options.project;
  if (!scopeId) throw new Error("Memory Graph seed에는 scopeId 또는 project가 필요합니다.");

  ensureGraphPolicy(brainRoot);
  const nodes = [];
  const edges = [];

  const sources = readSources(brainRoot).filter(source => sourceMatchesScope(source, scopeId));
  const sourcesById = new Map(sources.map(source => [source.sourceId, source]));
  for (const source of sources) {
    nodes.push(nodeFromObsidianSource(source, scopeId));
  }
  for (const entry of readJsonl(depthIndexPath(brainRoot)).filter(entry => depthEntryMatchesScope(entry, scopeId))) {
    nodes.push(nodeFromDepthEntry(entry, sourcesById.get(entry.sourceId), scopeId));
  }

  const facts = listFacts(brainRoot, { scopeId });
  for (const fact of facts) nodes.push(nodeFromFact(fact));

  const activeState = loadActiveState(brainRoot, scopeId, { createIfMissing: false });
  for (const fact of activeState.facts || []) nodes.push(nodeFromActiveState(scopeId, "fact", fact));
  for (const capability of activeState.capabilities || []) nodes.push(nodeFromActiveState(scopeId, "capability", capability));
  for (const decision of activeState.decisions || []) nodes.push(nodeFromActiveState(scopeId, "decision", decision));
  for (const guardHint of activeState.guardHints || []) nodes.push(nodeFromGuardRule(scopeId, guardHint));

  edges.push(...buildSourceRefEdges(nodes));
  edges.push(...buildDepthContainmentEdges(nodes));
  edges.push(...buildPromotionEdges(nodes));
  edges.push(...buildGuardRuleEdges(nodes));
  edges.push(...buildOntologyRelationEdges(nodes));

  const writtenNodes = upsertNodes(brainRoot, nodes);
  const writtenEdges = upsertEdges(brainRoot, edges);

  return {
    scopeId,
    nodes: writtenNodes,
    edges: writtenEdges,
    seededNodes: nodes.length,
    seededEdges: edges.length
  };
}

function buildMemoryGraphBrief(brainRoot, options = {}) {
  const scopeId = options.scopeId || options.project;
  if (!scopeId) throw new Error("Memory Graph Brief에는 scopeId 또는 project가 필요합니다.");
  const goal = options.goal || "";
  const topK = Number(options.topK || 8);
  const policy = loadGraphPolicy(brainRoot);
  const seeded = seedGraphFromSources(brainRoot, { scopeId });
  const filtered = filterGraphByPolicy(seeded, policy, options);
  const goalTokens = normalizeTokens(goal);
  const scoredNodes = filtered.nodes
    .filter(node => nodeMatchesScope(node, scopeId))
    .map(node => ({
      node,
      activationScore: scoreNode(node, goalTokens)
    }))
    .filter(item => item.activationScore > 0 || item.node.nodeType === "active_state")
    .sort(compareScoredNodes)
    .slice(0, topK);
  const expandedScoredNodes = expandScoredNodesByRelations(filtered, scoredNodes, topK);
  const activeNodeIds = new Set(expandedScoredNodes.map(item => item.node.nodeId));
  const activatedEdges = filtered.edges
    .filter(edge => activeNodeIds.has(edge.fromNodeId) && activeNodeIds.has(edge.toNodeId))
    .slice(0, topK)
    .map(edge => formatEdgeForBrief(edge));
  const activatedNodes = expandedScoredNodes.map(item => formatNodeForBrief(item.node, item.activationScore));
  const inhibitionSignals = buildInhibitionSignals(expandedScoredNodes, goalTokens, activatedEdges);
  const reviewSignals = buildReviewSignals(activatedEdges);
  const usedDepth = chooseUsedDepth(activatedNodes);

  const section = {
    seed: { scopeId, goal },
    activatedNodes,
    activatedEdges,
    inhibitionSignals,
    reviewSignals,
    usedDepth,
    graphRefs: {
      nodesPath: nodesPath(brainRoot),
      edgesPath: edgesPath(brainRoot),
      activationsPath: activationsPath(brainRoot)
    }
  };
  if (options.logActivation !== false) {
    appendActivationLog(brainRoot, {
      scopeId,
      goal,
      activatedNodeIds: activatedNodes.map(node => node.nodeId),
      activatedEdgeIds: activatedEdges.map(edge => edge.edgeId),
      inhibitionSignals,
      reviewSignals,
      usedDepth
    });
  }
  return section;
}

function sourceMatchesScope(source, scopeId) {
  return !scopeId || (source.scopeHints || []).includes(scopeId);
}

function nodeMatchesScope(node, scopeId) {
  return !scopeId || node.scopeId === scopeId || (node.metadata?.scopeHints || []).includes(scopeId);
}

function depthEntryMatchesScope(entry, scopeId) {
  return !scopeId || (entry.scopeHints || []).includes(scopeId) || String(entry.path || "").toLowerCase().includes(String(scopeId).toLowerCase());
}

function filterGraphByPolicy(graph, policy, options = {}) {
  const maxDepth = policy.maxDepthByChannelMode?.[options.channelMode];
  const allowedDepthSet = maxDepth ? new Set(DEPTH_ORDER.slice(0, DEPTH_ORDER.indexOf(maxDepth) + 1)) : null;
  const nodes = graph.nodes.filter(node => !isNodeBlocked(node, policy, allowedDepthSet));
  const nodeIds = new Set(nodes.map(node => node.nodeId));
  const edges = graph.edges.filter(edge => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId));
  return { ...graph, nodes, edges };
}

function isNodeBlocked(node, policy, allowedDepthSet) {
  if ((policy.blockedNodeTypes || []).includes(node.nodeType)) return true;
  const sourceRefs = nodeSourceRefs(node);
  if (sourceRefs.some(ref => (policy.blockedSourceRefs || []).includes(ref))) return true;
  if (allowedDepthSet && node.metadata?.depth && !allowedDepthSet.has(node.metadata.depth)) return true;
  return false;
}

function scoreNode(node, goalTokens) {
  if (goalTokens.length === 0) return node.nodeType === "active_state" ? 0.2 : 0;
  const textTokens = new Set(normalizeTokens(tokenizableNodeText(node)));
  let matches = 0;
  for (const token of goalTokens) {
    if (textTokens.has(token)) matches++;
  }
  const textScore = matches / goalTokens.length;
  const authorityScore = textScore > 0 ? authorityBoost(node.authority) : 0;
  const typeScore = node.nodeType === "active_state" ? 0.2 : node.nodeType === "fact" ? 0.15 : 0;
  return Number(Math.min(1, textScore + authorityScore + typeScore).toFixed(4));
}

function tokenizableNodeText(node) {
  return [
    node.title,
    node.summary,
    node.sourceRef,
    node.metadata?.canonicalId,
    node.metadata?.sourceId,
    node.metadata?.memoryNodeType,
    ...(node.metadata?.relations || []).flatMap(relation => [relation.target, relation.type])
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/[._/#\\:-]+/g, " ");
}

function expandScoredNodesByRelations(graph, scoredNodes, topK) {
  const byNodeId = new Map(graph.nodes.map(node => [node.nodeId, node]));
  const scoreByNodeId = new Map(scoredNodes.map(item => [item.node.nodeId, item]));
  const seedIds = new Set(scoreByNodeId.keys());

  for (const edge of graph.edges) {
    const fromSeed = seedIds.has(edge.fromNodeId);
    const toSeed = seedIds.has(edge.toNodeId);
    if (!fromSeed && !toSeed) continue;
    if (["contains", "derived_from"].includes(edge.relation)) continue;

    const sourceItem = fromSeed ? scoreByNodeId.get(edge.fromNodeId) : scoreByNodeId.get(edge.toNodeId);
    const targetNodeId = fromSeed ? edge.toNodeId : edge.fromNodeId;
    if (scoreByNodeId.has(targetNodeId)) continue;

    const targetNode = byNodeId.get(targetNodeId);
    if (!targetNode) continue;

    const propagatedScore = Number(Math.min(1, Math.max(0.05, sourceItem.activationScore * Math.max(0.1, Math.abs(Number(edge.weight) || 0.5)))).toFixed(4));
    scoreByNodeId.set(targetNodeId, {
      node: targetNode,
      activationScore: propagatedScore
    });
  }

  return Array.from(scoreByNodeId.values())
    .sort(compareScoredNodes)
    .slice(0, topK);
}

function compareScoredNodes(a, b) {
  return b.activationScore - a.activationScore ||
    nodeDepthRank(b.node) - nodeDepthRank(a.node) ||
    String(a.node.nodeId).localeCompare(String(b.node.nodeId));
}

function nodeDepthRank(node) {
  const depth = node.metadata?.depth;
  const index = DEPTH_ORDER.indexOf(depth);
  return index >= 0 ? index : 0;
}

function authorityBoost(authority) {
  if (authority === "user_confirmed") return 0.25;
  if (authority === "active_state" || authority === "answer_guard") return 0.2;
  if (authority === "high") return 0.15;
  return 0;
}

function formatNodeForBrief(node, activationScore) {
  return {
    nodeId: node.nodeId,
    nodeType: node.nodeType,
    title: node.title,
    summary: node.summary,
    sourceRef: node.sourceRef,
    status: node.status,
    authority: node.authority,
    activationScore,
    metadata: {
      activeType: node.metadata?.activeType,
      depth: node.metadata?.depth,
      docType: node.metadata?.docType,
      memoryNodeType: node.metadata?.memoryNodeType,
      needsReview: node.metadata?.needsReview
    }
  };
}

function formatEdgeForBrief(edge) {
  return {
    edgeId: edge.edgeId,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    relation: edge.relation,
    weight: edge.weight,
    confidence: edge.confidence,
    provenance: edge.provenance || []
  };
}

function buildInhibitionSignals(scoredNodes, goalTokens, activatedEdges = []) {
  const signals = [];
  const goalText = goalTokens.join(" ");
  for (const item of scoredNodes) {
    const node = item.node;
    const text = `${node.title || ""} ${node.summary || ""}`.toLowerCase();
    if (
      node.nodeType === "active_state" &&
      node.metadata?.activeType === "capability" &&
      /(html|산출물)/i.test(`${text} ${goalText}`) &&
      item.activationScore > 0
    ) {
      signals.push({
        signal: "avoid_repeating_existing_capability",
        nodeId: node.nodeId,
        reason: "active capability already exists"
      });
    }
  }
  for (const edge of activatedEdges) {
    if (edge.relation === "blocked_by") {
      signals.push({
        signal: "memory_graph_blocked_by_relation",
        edgeId: edge.edgeId,
        reason: "activated relation is blocked_by"
      });
    }
  }
  return signals;
}

function buildReviewSignals(activatedEdges) {
  return activatedEdges
    .filter(edge => ["contradicts", "requires_confirmation", "blocked_by"].includes(edge.relation))
    .map(edge => ({
      signal: edge.relation === "contradicts"
        ? "memory_graph_conflict"
        : edge.relation === "blocked_by"
          ? "blocked_by_relation"
          : "confirmation_required",
      edgeId: edge.edgeId,
      relation: edge.relation
    }));
}

function chooseUsedDepth(activatedNodes) {
  if (activatedNodes.some(node => node.metadata?.depth === "D4")) return "D4";
  if (activatedNodes.some(node => node.metadata?.depth === "D3")) return "D3";
  if (activatedNodes.some(node => node.metadata?.depth === "D2")) return "D2";
  return "D1";
}

function nodeFromObsidianSource(source, scopeId) {
  const title = path.basename(source.path || source.sourceId, path.extname(source.path || ""));
  return {
    nodeId: nodeIdFor("obsidian_doc", source.canonicalId || source.sourceId),
    nodeType: "obsidian_doc",
    scopeId,
    title,
    summary: `${source.sourceClass || "obsidian"} document`,
    sourceRef: source.path,
    status: source.status || "candidate",
    authority: source.trustLevel || "inferred",
    updatedAt: source.mtime || source.lastIndexedAt || isoNow(),
    metadata: {
      sourceId: source.sourceId,
      canonicalId: source.canonicalId,
      scopeHints: source.scopeHints || [],
      docType: source.docType,
      sourceClass: source.sourceClass,
      memoryClasses: source.memoryClasses || [],
      defaultDepth: source.defaultDepth,
      maxAutoDepth: source.maxAutoDepth,
      requiresConfirmationForFact: source.requiresConfirmationForFact,
      memoryNodeType: source.memoryNodeType,
      relations: source.relations || [],
      needsReview: Boolean(source.needsReview),
      visibility: source.visibility,
      sourceRefs: [source.path].filter(Boolean)
    }
  };
}

function nodeFromDepthEntry(entry, source, scopeId) {
  const isRaw = entry.depth === "D4";
  return {
    nodeId: nodeIdFor(isRaw ? "obsidian_raw" : "obsidian_section", entry.depthEntryId),
    nodeType: isRaw ? "obsidian_raw" : "obsidian_section",
    scopeId,
    title: entry.heading || path.basename(entry.path || entry.depthEntryId, ".md"),
    summary: entry.summary || "",
    sourceRef: entry.rawRef || `${entry.path}${entry.heading ? `#${entry.heading}` : ""}`,
    status: source?.status || "candidate",
    authority: source?.trustLevel || source?.authority || "inferred",
    updatedAt: entry.indexedAt || isoNow(),
    metadata: {
      sourceId: entry.sourceId,
      depthEntryId: entry.depthEntryId,
      scopeHints: entry.scopeHints || [],
      depth: entry.depth,
      line: entry.line,
      lineStart: entry.lineStart,
      lineEnd: entry.lineEnd,
      rawRef: entry.rawRef,
      docType: source?.docType,
      needsReview: Boolean(source?.needsReview),
      sourceRefs: [entry.rawRef || entry.path].filter(Boolean)
    }
  };
}

function nodeFromFact(fact) {
  return {
    nodeId: nodeIdFor("fact", fact.factId),
    nodeType: "fact",
    scopeId: fact.scopeId,
    title: `${fact.subject || ""} ${fact.predicate || ""}`.trim(),
    summary: `${fact.subject || ""} ${fact.predicate || ""} ${fact.object || ""}`.trim(),
    sourceRef: fact.factId,
    status: fact.status || "candidate",
    authority: fact.sourceType || "inferred",
    updatedAt: fact.updatedAt || isoNow(),
    metadata: {
      factId: fact.factId,
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      sourceRefs: [...(fact.sourceRefs || []), ...(fact.sourceRecordIds || [])],
      confidence: fact.confidence
    }
  };
}

function nodeFromActiveState(scopeId, activeType, item) {
  const itemId = item.id || item.title || stableId("active", [scopeId, activeType, item.summary]);
  return {
    nodeId: nodeIdFor("active_state", `${scopeId}:${activeType}:${itemId}`),
    nodeType: "active_state",
    scopeId,
    title: item.title || item.id || activeType,
    summary: item.summary || item.rule || "",
    sourceRef: itemId,
    status: item.status || "active",
    authority: "active_state",
    updatedAt: item.updatedAt || isoNow(),
    metadata: {
      activeType,
      activeId: itemId,
      sourceRefs: item.sourceRefs || []
    }
  };
}

function nodeFromGuardRule(scopeId, guardHint) {
  const guardId = guardHint.id || stableId("guard", [scopeId, guardHint.rule]);
  return {
    nodeId: nodeIdFor("guard_rule", `${scopeId}:${guardId}`),
    nodeType: "guard_rule",
    scopeId,
    title: guardHint.rule || guardHint.id || "guard rule",
    summary: guardHint.rule || "",
    sourceRef: guardId,
    status: "active",
    authority: "answer_guard",
    updatedAt: isoNow(),
    metadata: {
      guardId,
      appliesWhen: guardHint.appliesWhen || [],
      sourceRefs: guardHint.sourceRefs || []
    }
  };
}

function buildSourceRefEdges(nodes) {
  const edges = [];
  const bySourceRef = new Map();
  for (const node of nodes) {
    for (const ref of nodeSourceRefs(node)) {
      if (!bySourceRef.has(ref)) bySourceRef.set(ref, []);
      bySourceRef.get(ref).push(node);
    }
  }

  for (const linkedNodes of bySourceRef.values()) {
    for (const from of linkedNodes) {
      for (const to of linkedNodes) {
        if (from.nodeId === to.nodeId) continue;
        const relation = sourceRelation(from, to);
        if (!relation) continue;
        edges.push(createEdge(from.nodeId, to.nodeId, relation, 0.7, [from.sourceRef, to.sourceRef]));
      }
    }
  }
  return dedupeEdges(edges);
}

function buildDepthContainmentEdges(nodes) {
  const docBySourceId = new Map();
  for (const node of nodes.filter(node => node.nodeType === "obsidian_doc")) {
    if (node.metadata?.sourceId) docBySourceId.set(node.metadata.sourceId, node);
  }
  const edges = [];
  for (const node of nodes.filter(node => ["obsidian_section", "obsidian_raw"].includes(node.nodeType))) {
    const doc = docBySourceId.get(node.metadata?.sourceId);
    if (doc) edges.push(createEdge(doc.nodeId, node.nodeId, "contains", 0.6, [node.sourceRef]));
  }
  return dedupeEdges(edges);
}

function buildPromotionEdges(nodes) {
  const facts = nodes.filter(node => node.nodeType === "fact");
  const activeNodes = nodes.filter(node => node.nodeType === "active_state");
  const edges = [];
  for (const fact of facts) {
    for (const active of activeNodes) {
      const sameFact = active.metadata?.activeId === fact.metadata?.factId;
      const sharedRef = hasSharedSourceRef(fact, active);
      if (sameFact || sharedRef) {
        edges.push(createEdge(fact.nodeId, active.nodeId, "promoted_to", 0.8, nodeSourceRefs(fact)));
      }
    }
  }
  return dedupeEdges(edges);
}

function buildGuardRuleEdges(nodes) {
  const activeNodes = nodes.filter(node => node.nodeType === "active_state");
  const guardNodes = nodes.filter(node => node.nodeType === "guard_rule");
  const edges = [];
  for (const active of activeNodes) {
    for (const guard of guardNodes) {
      if (hasSharedSourceRef(active, guard)) {
        edges.push(createEdge(active.nodeId, guard.nodeId, "supports", 0.75, nodeSourceRefs(active)));
      }
    }
  }
  return dedupeEdges(edges);
}

function buildOntologyRelationEdges(nodes) {
  const docs = nodes.filter(node => node.nodeType === "obsidian_doc");
  const byKey = new Map();
  for (const node of docs) {
    for (const key of ontologyNodeKeys(node)) {
      if (!byKey.has(key)) byKey.set(key, node);
    }
  }

  const edges = [];
  for (const node of docs) {
    for (const relation of node.metadata?.relations || []) {
      if (!relation || relation.status === "deprecated" || relation.status === "blocked") continue;
      const target = byKey.get(String(relation.target || "").toLowerCase());
      if (!target) continue;

      const weight = relation.type === "contradicts" || relation.type === "blocked_by"
        ? -Math.abs(relation.strength || DEFAULT_RELATION_STRENGTH[relation.type] || 0.5)
        : Math.abs(relation.strength || DEFAULT_RELATION_STRENGTH[relation.type] || 0.5);
      const metadata = {
        source: "obsidian_frontmatter",
        direction: relation.direction,
        status: relation.status,
        reason: relation.reason,
        target: relation.target
      };

      if (relation.direction === "incoming") {
        edges.push(createEdge(target.nodeId, node.nodeId, relation.type, weight, [node.sourceRef, target.sourceRef], metadata));
      } else if (relation.direction === "bidirectional") {
        edges.push(createEdge(node.nodeId, target.nodeId, relation.type, weight, [node.sourceRef, target.sourceRef], metadata));
        edges.push(createEdge(target.nodeId, node.nodeId, relation.type, weight, [node.sourceRef, target.sourceRef], metadata));
      } else {
        edges.push(createEdge(node.nodeId, target.nodeId, relation.type, weight, [node.sourceRef, target.sourceRef], metadata));
      }
    }
  }

  return dedupeEdges(edges);
}

function ontologyNodeKeys(node) {
  return [
    node.metadata?.canonicalId,
    node.metadata?.sourceId,
    node.title
  ]
    .filter(Boolean)
    .map(value => String(value).toLowerCase());
}

function sourceRelation(from, to) {
  if (from.nodeType === "obsidian_doc" && to.nodeType !== "obsidian_doc") return "supports";
  if (from.nodeType === "fact" && to.nodeType === "active_state") return "promoted_to";
  if (from.nodeType !== "obsidian_doc" && to.nodeType === "obsidian_doc") return "derived_from";
  if (from.nodeType === "active_state" && to.nodeType === "guard_rule") return "supports";
  return null;
}

function nodeSourceRefs(node) {
  const refs = new Set();
  if (node.sourceRef) refs.add(node.sourceRef);
  for (const ref of node.metadata?.sourceRefs || []) refs.add(ref);
  return Array.from(refs).filter(Boolean);
}

function hasSharedSourceRef(a, b) {
  const aRefs = new Set(nodeSourceRefs(a));
  return nodeSourceRefs(b).some(ref => aRefs.has(ref));
}

function createEdge(fromNodeId, toNodeId, relation, weight, provenance = [], metadata = {}) {
  return {
    edgeId: edgeIdFor(fromNodeId, toNodeId, relation),
    fromNodeId,
    toNodeId,
    relation,
    weight,
    confidence: Math.min(1, Math.max(0, Math.abs(weight))),
    provenance: Array.from(new Set(provenance.filter(Boolean))),
    lastActivatedAt: null,
    metadata
  };
}

function dedupeEdges(edges) {
  return Array.from(new Map(edges.map(edge => [edge.edgeId, edge])).values());
}

function evaluateMemoryGraph(brainRoot, options = {}) {
  const scopeId = options.scopeId || options.project || "brain";
  const goal = options.goal || "신규 오픈소스 분석해줘";
  const brief = buildMemoryGraphBrief(brainRoot, {
    ...options,
    scopeId,
    goal,
    logActivation: false
  });
  const nodes = readNodes(brainRoot).filter(node => nodeMatchesScope(node, scopeId));
  const edges = readEdges(brainRoot);
  const checks = [
    {
      checkId: "existing_capability_inhibition",
      passed: brief.inhibitionSignals.some(signal => signal.signal === "avoid_repeating_existing_capability")
    },
    {
      checkId: "obsidian_depth_nodes",
      passed: nodes.some(node => node.nodeType === "obsidian_section") && nodes.some(node => node.nodeType === "obsidian_raw")
    },
    {
      checkId: "depth_contains_edges",
      passed: edges.some(edge => edge.relation === "contains")
    },
    {
      checkId: "typed_relation_edges_supported",
      passed: edges.every(edge => typeof edge.relation === "string" && edge.relation.length > 0)
    },
    {
      checkId: "activation_brief",
      passed: Array.isArray(brief.activatedNodes) && Array.isArray(brief.activatedEdges)
    }
  ];
  return {
    scopeId,
    goal,
    status: checks.every(check => check.passed) ? "passed" : "needs_attention",
    checks,
    activatedNodes: brief.activatedNodes.length,
    activatedEdges: brief.activatedEdges.length
  };
}

module.exports = {
  memoryGraphDir,
  nodesPath,
  edgesPath,
  activationsPath,
  consolidationLogPath,
  graphPolicyPath,
  nodeIdFor,
  edgeIdFor,
  readNodes,
  writeNodes,
  readEdges,
  writeEdges,
  readActivationLog,
  appendActivationLog,
  readConsolidationLog,
  appendConsolidationLog,
  activationSnapshotFromMemoryGraph,
  upsertNodes,
  upsertEdges,
  seedGraphFromSources,
  buildMemoryGraphBrief,
  evaluateMemoryGraph
};
