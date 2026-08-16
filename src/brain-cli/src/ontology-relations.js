"use strict";

const RELATION_TYPES = [
  "inputs_from",
  "outputs_to",
  "depends_on",
  "verifies",
  "reviewed_by",
  "supersedes",
  "contradicts",
  "similar_to",
  "belongs_to",
  "used_for",
  "blocked_by",
  "related_to",
  "supports",
  "derived_from",
  "promoted_to",
  "contains",
  "requires_confirmation",
  "same_scope"
];

const RELATION_TYPE_SET = new Set(RELATION_TYPES);

const RELATION_ALIASES = {
  input_from: "inputs_from",
  input: "inputs_from",
  output_to: "outputs_to",
  output: "outputs_to",
  depends: "depends_on",
  dependency: "depends_on",
  verify: "verifies",
  validates: "verifies",
  validates_to: "verifies",
  reviewed: "reviewed_by",
  review_by: "reviewed_by",
  replaces: "supersedes",
  replaces_to: "supersedes",
  conflicts_with: "contradicts",
  conflict: "contradicts",
  similar: "similar_to",
  belongs: "belongs_to",
  used: "used_for",
  blocks: "blocked_by",
  blocked: "blocked_by",
  relates_to: "related_to",
  related: "related_to",
  relation: "related_to",
  requires_confirm: "requires_confirmation",
  needs_confirmation: "requires_confirmation"
};

const DEFAULT_RELATION_STRENGTH = {
  inputs_from: 0.75,
  outputs_to: 0.8,
  depends_on: 0.75,
  verifies: 0.75,
  reviewed_by: 0.7,
  supersedes: 0.85,
  contradicts: 0.8,
  similar_to: 0.45,
  belongs_to: 0.55,
  used_for: 0.65,
  blocked_by: 0.8,
  related_to: 0.35,
  supports: 0.7,
  derived_from: 0.65,
  promoted_to: 0.8,
  contains: 0.6,
  requires_confirmation: 0.6,
  same_scope: 0.4
};

function normalizeRelationType(input) {
  const raw = String(input || "related_to")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const type = RELATION_ALIASES[raw] || raw;
  return RELATION_TYPE_SET.has(type) ? type : "related_to";
}

function clampStrength(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function normalizeDirection(value) {
  const direction = String(value || "outgoing").trim().toLowerCase();
  if (["incoming", "bidirectional", "outgoing"].includes(direction)) return direction;
  return "outgoing";
}

function normalizeStatus(value) {
  const status = String(value || "active").trim().toLowerCase();
  if (["active", "candidate", "deprecated", "blocked"].includes(status)) return status;
  return "active";
}

function relationTargetOf(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  return item.target || item.to || item.ref || item.canonical_id || item.canonicalId || "";
}

function normalizeRelation(item) {
  const target = String(relationTargetOf(item)).trim();
  if (!target) return null;

  const type = normalizeRelationType(typeof item === "object" ? item.type || item.relation : "related_to");
  const fallbackStrength = DEFAULT_RELATION_STRENGTH[type] || 0.5;
  return {
    target,
    type,
    direction: normalizeDirection(typeof item === "object" ? item.direction : "outgoing"),
    strength: clampStrength(typeof item === "object" ? item.strength ?? item.weight : undefined, fallbackStrength),
    status: normalizeStatus(typeof item === "object" ? item.status : "candidate"),
    reason: typeof item === "object" && item.reason ? String(item.reason) : null
  };
}

function relationInputsFromFrontmatter(frontmatter = {}) {
  const memory = frontmatter.memory && typeof frontmatter.memory === "object" ? frontmatter.memory : {};
  const inputs = [];
  if (Array.isArray(memory.relations)) inputs.push(...memory.relations);
  if (Array.isArray(frontmatter.relations)) inputs.push(...frontmatter.relations);
  if (Array.isArray(frontmatter.relates_to)) inputs.push(...frontmatter.relates_to);
  else if (frontmatter.relates_to) inputs.push(frontmatter.relates_to);
  return inputs;
}

function normalizeOntologyRelations(frontmatter = {}) {
  const byKey = new Map();
  for (const item of relationInputsFromFrontmatter(frontmatter)) {
    const relation = normalizeRelation(item);
    if (!relation) continue;
    const key = [
      relation.target.toLowerCase(),
      relation.type,
      relation.direction
    ].join("|");
    byKey.set(key, relation);
  }
  return Array.from(byKey.values());
}

function inferMemoryNodeType(docType) {
  const normalized = String(docType || "note").toLowerCase();
  if (["agent", "workflow", "capability", "concept", "rule", "decision"].includes(normalized)) return normalized;
  if (normalized === "design") return "document";
  if (normalized === "research") return "evidence";
  if (normalized === "planning") return "plan";
  return "knowledge";
}

function memoryNodeTypeFromFrontmatter(frontmatter = {}) {
  const memory = frontmatter.memory && typeof frontmatter.memory === "object" ? frontmatter.memory : {};
  return String(memory.node_type || memory.nodeType || inferMemoryNodeType(frontmatter.doc_type)).trim();
}

function buildDefaultMemoryFrontmatter(docType) {
  return {
    node_type: inferMemoryNodeType(docType),
    relations: []
  };
}

module.exports = {
  RELATION_TYPES,
  DEFAULT_RELATION_STRENGTH,
  normalizeRelationType,
  normalizeOntologyRelations,
  memoryNodeTypeFromFrontmatter,
  buildDefaultMemoryFrontmatter
};
