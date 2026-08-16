"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ensureDir, writeJsonl } = require("../src/utils");
const { sourcesPath } = require("../src/obsidian-connector");
const { indexDepthForSource } = require("../src/depth-retriever");
const { upsertFact } = require("../src/fact-ledger");
const {
  activationSnapshotFromMemoryGraph,
  appendConsolidationLog,
  activationsPath,
  consolidationLogPath,
  edgesPath,
  graphPolicyPath,
  buildMemoryGraphBrief,
  memoryGraphDir,
  nodesPath,
  readActivationLog,
  readConsolidationLog,
  readEdges,
  readNodes,
  seedGraphFromSources,
  upsertEdges,
  upsertNodes
} = require("../src/memory-graph");

let testRoot;

function setupRoot() {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-memory-graph-"));
  fs.mkdirSync(path.join(testRoot, "90_index"), { recursive: true });
  const obsidianPath = path.join(testRoot, "obsidian", "AgentForge-HTML.md");
  const claimDesignerPath = path.join(testRoot, "obsidian", "Claim-Designer.md");
  const specWriterPath = path.join(testRoot, "obsidian", "Spec-Writer.md");
  ensureDir(path.dirname(obsidianPath));
  fs.writeFileSync(obsidianPath, "# AgentForge HTML\n\n밴딩AI는 HTML 산출물을 만들 수 있음.\n", "utf-8");
  fs.writeFileSync(claimDesignerPath, "# Claim Designer\n\nClaim designer produces claim draft.\n", "utf-8");
  fs.writeFileSync(specWriterPath, "# Spec Writer\n\nSpec writer consumes claim draft.\n", "utf-8");
  ensureDir(path.dirname(sourcesPath(testRoot)));
  writeJsonl(sourcesPath(testRoot), [{
    sourceId: "obs_agentforge_html",
    path: obsidianPath,
    root: path.dirname(obsidianPath),
    hash: "sha256:test",
    mtime: "2026-05-12T00:00:00.000Z",
    sourceClass: "design",
    scopeHints: ["agentforge"],
    trustLevel: "normal",
    visibility: "project",
    docType: "design",
    status: "draft",
    needsReview: false,
    lastIndexedAt: "2026-05-12T00:00:00.000Z"
  }, {
    sourceId: "obs_claim_designer",
    path: claimDesignerPath,
    root: path.dirname(claimDesignerPath),
    hash: "sha256:claim",
    mtime: "2026-05-12T00:00:00.000Z",
    sourceClass: "agent",
    scopeHints: ["agentforge"],
    trustLevel: "user_confirmed",
    visibility: "project",
    canonicalId: "agent.claim-designer",
    docType: "agent",
    status: "active",
    memoryNodeType: "agent",
    relations: [{
      target: "agent.spec-writer",
      type: "outputs_to",
      direction: "outgoing",
      strength: 0.8,
      status: "active",
      reason: "claim draft feeds spec writer"
    }],
    needsReview: false,
    lastIndexedAt: "2026-05-12T00:00:00.000Z"
  }, {
    sourceId: "obs_spec_writer",
    path: specWriterPath,
    root: path.dirname(specWriterPath),
    hash: "sha256:spec",
    mtime: "2026-05-12T00:00:00.000Z",
    sourceClass: "agent",
    scopeHints: ["agentforge"],
    trustLevel: "normal",
    visibility: "project",
    canonicalId: "agent.spec-writer",
    docType: "agent",
    status: "active",
    memoryNodeType: "agent",
    relations: [],
    needsReview: false,
    lastIndexedAt: "2026-05-12T00:00:00.000Z"
  }]);
  indexDepthForSource(testRoot, "obs_agentforge_html");
  upsertFact(testRoot, {
    scopeId: "agentforge",
    subject: "밴딩AI",
    predicate: "supports",
    object: "HTML 산출물 생성",
    sourceRefs: [obsidianPath],
    sourceType: "user_confirmed",
    confidence: 0.95
  });
}

describe("Memory Graph sidecar", () => {
  beforeEach(setupRoot);
  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("경로와 upsert는 sidecar JSONL을 idempotent하게 관리한다", () => {
    assert.equal(memoryGraphDir(testRoot), path.join(testRoot, "49_memory_graph"));
    assert.equal(nodesPath(testRoot), path.join(testRoot, "49_memory_graph", "nodes.jsonl"));
    assert.equal(edgesPath(testRoot), path.join(testRoot, "49_memory_graph", "edges.jsonl"));
    assert.equal(activationsPath(testRoot), path.join(testRoot, "49_memory_graph", "activations.jsonl"));
    assert.equal(consolidationLogPath(testRoot), path.join(testRoot, "49_memory_graph", "consolidation-log.jsonl"));

    upsertNodes(testRoot, [{
      nodeId: "node_test",
      nodeType: "fact",
      scopeId: "agentforge",
      title: "테스트",
      summary: "테스트 노드",
      sourceRef: "ref",
      status: "active",
      authority: "test",
      metadata: {}
    }]);
    upsertNodes(testRoot, [{
      nodeId: "node_test",
      nodeType: "fact",
      scopeId: "agentforge",
      title: "테스트 갱신",
      summary: "테스트 노드",
      sourceRef: "ref",
      status: "active",
      authority: "test",
      metadata: {}
    }]);
    upsertEdges(testRoot, [{
      edgeId: "edge_test",
      fromNodeId: "node_a",
      toNodeId: "node_b",
      relation: "supports",
      weight: 0.7,
      confidence: 0.7,
      provenance: ["ref"],
      metadata: {}
    }]);
    upsertEdges(testRoot, [{
      edgeId: "edge_test",
      fromNodeId: "node_a",
      toNodeId: "node_b",
      relation: "supports",
      weight: 0.8,
      confidence: 0.8,
      provenance: ["ref"],
      metadata: {}
    }]);

    const nodes = readNodes(testRoot);
    const edges = readEdges(testRoot);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].title, "테스트 갱신");
    assert.equal(edges.length, 1);
    assert.equal(edges[0].weight, 0.8);
  });

  it("Obsidian source, Fact, Active State를 node/edge로 seed한다", () => {
    const first = seedGraphFromSources(testRoot, { scopeId: "agentforge" });
    const second = seedGraphFromSources(testRoot, { scopeId: "agentforge" });
    const nodes = readNodes(testRoot);
    const edges = readEdges(testRoot);

    assert.ok(fs.existsSync(graphPolicyPath(testRoot)));
    assert.equal(first.nodes.length, second.nodes.length);
    assert.equal(first.edges.length, second.edges.length);
    assert.equal(nodes.length, second.nodes.length);
    assert.equal(edges.length, second.edges.length);
    assert.ok(nodes.some(node => node.nodeType === "obsidian_doc"));
    assert.ok(nodes.some(node => node.nodeType === "obsidian_section" && node.metadata.depth === "D2"));
    assert.ok(nodes.some(node => node.nodeType === "obsidian_raw" && node.metadata.depth === "D4"));
    assert.ok(nodes.some(node => node.nodeType === "fact"));
    assert.ok(nodes.some(node => node.nodeType === "active_state" && node.title.includes("HTML")));
    assert.ok(nodes.some(node => node.nodeType === "guard_rule"));
    assert.ok(edges.some(edge => edge.relation === "contains"));
    assert.ok(edges.some(edge => edge.relation === "supports"));
    assert.ok(edges.some(edge => edge.relation === "derived_from"));
    assert.ok(edges.some(edge => edge.relation === "promoted_to"));
    assert.ok(edges.some(edge => edge.relation === "outputs_to"));
  });

  it("Obsidian typed relation은 대상 노드를 1-hop activation으로 포함한다", () => {
    const section = buildMemoryGraphBrief(testRoot, {
      scopeId: "agentforge",
      goal: "claim designer workflow",
      topK: 8
    });

    assert.ok(section.activatedNodes.some(node => node.title === "Claim-Designer"));
    assert.ok(section.activatedNodes.some(node => node.title === "Spec-Writer"));
    assert.ok(section.activatedEdges.some(edge => edge.relation === "outputs_to"));
  });

  it("Memory Graph Brief는 활성 노드와 inhibition signal을 반환한다", () => {
    const section = buildMemoryGraphBrief(testRoot, {
      scopeId: "agentforge",
      goal: "신규 오픈소스 HTML 분석"
    });

    assert.equal(section.seed.scopeId, "agentforge");
    assert.ok(section.activatedNodes.some(node => node.nodeType === "active_state" && node.title.includes("HTML")));
    assert.ok(section.activatedEdges.some(edge => edge.relation === "promoted_to"));
    assert.ok(section.inhibitionSignals.some(signal => signal.signal === "avoid_repeating_existing_capability"));
    assert.equal(section.usedDepth, "D4");
    assert.ok(section.graphRefs.nodesPath.endsWith(path.join("49_memory_graph", "nodes.jsonl")));
    assert.equal(readActivationLog(testRoot).length, 1);
  });

  it("consolidation log는 graph activation snapshot을 기록한다", () => {
    const section = buildMemoryGraphBrief(testRoot, {
      scopeId: "agentforge",
      goal: "신규 오픈소스 HTML 분석"
    });
    const record = appendConsolidationLog(testRoot, {
      scopeId: "agentforge",
      source: "answer_guard",
      eventType: "guard_result",
      resultId: "guard_test",
      status: "revise_required",
      activation: activationSnapshotFromMemoryGraph(section),
      metadata: {
        findingTypes: ["known_capability_as_new_suggestion"]
      }
    });
    const records = readConsolidationLog(testRoot);

    assert.equal(record.resultId, "guard_test");
    assert.equal(records.length, 1);
    assert.ok(records[0].activation.activatedNodeIds.length > 0);
    assert.ok(records[0].activation.inhibitionSignals.some(signal => signal.signal === "avoid_repeating_existing_capability"));
    assert.equal(records[0].metadata.findingTypes[0], "known_capability_as_new_suggestion");
  });

  it("graph policy는 blocked node를 activation에서 제외한다", () => {
    fs.mkdirSync(path.dirname(graphPolicyPath(testRoot)), { recursive: true });
    fs.writeFileSync(graphPolicyPath(testRoot), JSON.stringify({
      version: 1,
      blockedNodeTypes: ["active_state"],
      blockedSourceRefs: [],
      maxDepthByChannelMode: {}
    }, null, 2), "utf-8");

    const section = buildMemoryGraphBrief(testRoot, {
      scopeId: "agentforge",
      goal: "신규 오픈소스를 분석해줘"
    });

    assert.equal(section.activatedNodes.some(node => node.nodeType === "active_state"), false);
    assert.equal(section.inhibitionSignals.some(signal => signal.signal === "avoid_repeating_existing_capability"), false);
  });
});
