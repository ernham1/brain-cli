"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ensureDir, isoNow, normalizeTokens, readJsonl, writeJsonl } = require("./utils");
const { obsidianDir, readSources } = require("./obsidian-connector");
const { renderFrontmatter, splitFrontmatter } = require("./obsidian-frontmatter");
const { normalizeRelationType } = require("./ontology-relations");

const SCHEMA_VERSION = "obsidian-relation-candidate/v1";
const DEFAULT_MIN_SCORE = 0.35;
const DEFAULT_LIMIT = 50;

function relationCandidatesPath(brainRoot) {
  return path.join(obsidianDir(brainRoot), "relation-candidates.jsonl");
}

function relationDecisionsPath(brainRoot) {
  return path.join(obsidianDir(brainRoot), "relation-decisions.jsonl");
}

function relationApplicationsPath(brainRoot) {
  return path.join(obsidianDir(brainRoot), "relation-applications.jsonl");
}

function stableCandidateId(sourceId, targetId, relationType) {
  const digest = crypto
    .createHash("sha1")
    .update(`${sourceId}:${targetId}:${relationType}`.toLowerCase())
    .digest("hex")
    .slice(0, 14);
  return `orc_${digest}`;
}

function stableDecisionId(candidateId, decision, reviewedAt) {
  const digest = crypto
    .createHash("sha1")
    .update(`${candidateId}:${decision}:${reviewedAt}`.toLowerCase())
    .digest("hex")
    .slice(0, 14);
  return `ord_${digest}`;
}

function stableApplicationId(candidateId) {
  const digest = crypto
    .createHash("sha1")
    .update(`obsidian-relation-application:${candidateId}`.toLowerCase())
    .digest("hex")
    .slice(0, 14);
  return `ora_${digest}`;
}

function clonePlainObject(value) {
  if (!value || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

function titleForSource(source = {}) {
  return path.basename(source.path || source.sourceId || "unknown", path.extname(source.path || ""));
}

function textForTokenize(source = {}) {
  return [
    titleForSource(source),
    source.path,
    source.canonicalId,
    source.docType,
    source.sourceClass,
    source.memoryNodeType,
    ...(source.memoryClasses || [])
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/[\\/_#:\-.()[\]{}]+/g, " ");
}

function tokenSet(source) {
  return new Set(normalizeTokens(textForTokenize(source)));
}

function intersectionSize(left, right) {
  let count = 0;
  for (const item of left) {
    if (right.has(item)) count += 1;
  }
  return count;
}

function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  const intersection = intersectionSize(left, right);
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function scopeOverlap(source = {}, target = {}, requestedScope) {
  const left = new Set([...(source.scopeHints || []), source.scopeId, requestedScope].filter(Boolean));
  const right = new Set([...(target.scopeHints || []), target.scopeId, requestedScope].filter(Boolean));
  return intersectionSize(left, right) > 0;
}

function classOverlap(source = {}, target = {}) {
  const left = new Set(source.memoryClasses || []);
  const right = new Set(target.memoryClasses || []);
  return intersectionSize(left, right) > 0;
}

function relationTargetRefs(source = {}) {
  const refs = new Set();
  for (const relation of source.relations || []) {
    if (relation.status === "deprecated") continue;
    refs.add(`${String(relation.target || "").toLowerCase()}|${normalizeRelationType(relation.type)}`);
  }
  return refs;
}

function targetRefCandidates(target = {}) {
  return [target.canonicalId, target.sourceId, target.path, titleForSource(target)]
    .filter(Boolean)
    .map(item => String(item).toLowerCase());
}

function hasExistingRelation(source, target, relationType) {
  const refs = relationTargetRefs(source);
  return targetRefCandidates(target).some(ref => refs.has(`${ref}|${relationType}`));
}

function sourceSummary(source = {}) {
  return {
    sourceId: source.sourceId,
    canonicalId: source.canonicalId || null,
    path: source.path,
    root: source.root || null,
    title: titleForSource(source),
    memoryNodeType: source.memoryNodeType || null,
    docType: source.docType || source.sourceClass || null,
    memoryClasses: source.memoryClasses || [],
    scopeHints: source.scopeHints || []
  };
}

function scorePair(source, target, requestedScope) {
  const sourceTokens = tokenSet(source);
  const targetTokens = tokenSet(target);
  const tokenSimilarity = jaccard(sourceTokens, targetTokens);
  const signals = [];
  let score = 0;

  if (scopeOverlap(source, target, requestedScope)) {
    score += 0.25;
    signals.push("same_scope");
  }
  if (classOverlap(source, target)) {
    score += 0.2;
    signals.push("shared_memory_class");
  }
  if (source.memoryNodeType && source.memoryNodeType === target.memoryNodeType) {
    score += 0.1;
    signals.push("same_memory_node_type");
  }
  if ((source.docType || source.sourceClass) && (source.docType || source.sourceClass) === (target.docType || target.sourceClass)) {
    score += 0.1;
    signals.push("same_doc_type");
  }
  if (tokenSimilarity > 0) {
    score += Math.min(0.35, tokenSimilarity);
    signals.push("title_path_token_overlap");
  }

  return {
    score: Number(Math.min(1, score).toFixed(4)),
    tokenSimilarity: Number(tokenSimilarity.toFixed(4)),
    signals
  };
}

function candidateFromPair(source, target, requestedScope, scoreResult) {
  const relationType = "similar_to";
  const now = isoNow();
  return {
    candidateId: stableCandidateId(source.sourceId, target.sourceId, relationType),
    schemaVersion: SCHEMA_VERSION,
    scopeId: requestedScope || (source.scopeHints || [])[0] || "unknown",
    status: "candidate",
    source: sourceSummary(source),
    target: sourceSummary(target),
    relation: {
      type: relationType,
      direction: "outgoing",
      strength: Number(Math.max(0.35, Math.min(0.85, scoreResult.score)).toFixed(4)),
      status: "candidate",
      reason: "source_registry_similarity"
    },
    score: scoreResult.score,
    signals: scoreResult.signals,
    evidence: {
      tokenSimilarity: scoreResult.tokenSimilarity
    },
    createdBy: "obsidian_relation_candidate_generator",
    createdAt: now,
    updatedAt: now
  };
}

function sourceIsEligible(source = {}, requestedScope) {
  if (!source.sourceId || !source.path) return false;
  if (source.status === "deprecated" || source.status === "archived") return false;
  if (!requestedScope) return true;
  return (source.scopeHints || []).includes(requestedScope) || source.scopeId === requestedScope;
}

function mergeCandidate(existing, next) {
  if (!existing) return next;
  return {
    ...existing,
    source: next.source,
    target: next.target,
    relation: next.relation,
    score: next.score,
    signals: next.signals,
    evidence: next.evidence,
    hitCount: (existing.hitCount || 1) + 1,
    updatedAt: next.updatedAt
  };
}

function generateRelationCandidates(brainRoot, options = {}) {
  const scopeId = options.scope || options.scopeId;
  const minScore = Number(options.minScore || DEFAULT_MIN_SCORE);
  const limit = Number(options.limit || DEFAULT_LIMIT);
  const sources = readSources(brainRoot).filter(source => sourceIsEligible(source, scopeId));
  const proposed = [];

  for (const source of sources) {
    for (const target of sources) {
      if (source.sourceId === target.sourceId) continue;
      if (hasExistingRelation(source, target, "similar_to")) continue;
      const scoreResult = scorePair(source, target, scopeId);
      if (scoreResult.score < minScore) continue;
      proposed.push(candidateFromPair(source, target, scopeId, scoreResult));
    }
  }

  proposed.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.candidateId.localeCompare(b.candidateId);
  });

  const selected = proposed.slice(0, limit);
  const filePath = relationCandidatesPath(brainRoot);
  ensureDir(path.dirname(filePath));
  const existing = readJsonl(filePath);
  const byId = new Map(existing.map(candidate => [candidate.candidateId, candidate]));
  let createdCount = 0;
  let updatedCount = 0;

  for (const candidate of selected) {
    const current = byId.get(candidate.candidateId);
    if (current) updatedCount += 1;
    else createdCount += 1;
    byId.set(candidate.candidateId, mergeCandidate(current, candidate));
  }

  const candidates = Array.from(byId.values()).sort((a, b) => {
    if (String(a.scopeId).localeCompare(String(b.scopeId)) !== 0) {
      return String(a.scopeId).localeCompare(String(b.scopeId));
    }
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    return String(a.candidateId).localeCompare(String(b.candidateId));
  });
  writeJsonl(filePath, candidates);

  return {
    scopeId: scopeId || null,
    sourceCount: sources.length,
    generatedCount: selected.length,
    createdCount,
    updatedCount,
    minScore,
    limit,
    candidates: selected
  };
}

function listRelationCandidates(brainRoot, options = {}) {
  return readJsonl(relationCandidatesPath(brainRoot))
    .filter(candidate => !options.scope && !options.scopeId || candidate.scopeId === (options.scope || options.scopeId))
    .filter(candidate => !options.status || candidate.status === options.status);
}

function replaceCandidate(brainRoot, candidateId, updater) {
  const filePath = relationCandidatesPath(brainRoot);
  const candidates = readJsonl(filePath);
  const index = candidates.findIndex(candidate => candidate.candidateId === candidateId);
  if (index < 0) throw new Error(`relation candidate를 찾을 수 없습니다: ${candidateId}`);
  const next = updater(candidates[index]);
  candidates[index] = next;
  ensureDir(path.dirname(filePath));
  writeJsonl(filePath, candidates);
  return next;
}

function reviewRelationCandidate(brainRoot, review = {}) {
  const allowed = new Set(["approved", "dismissed", "needs_changes"]);
  if (!review.candidateId) throw new Error("candidateId가 필요합니다.");
  if (!allowed.has(review.decision)) {
    throw new Error("decision은 approved, dismissed, needs_changes만 허용됩니다.");
  }

  let originalCandidate;
  const reviewedAt = isoNow();
  const reviewer = review.reviewer || "unknown";
  const reason = review.reason || "";
  const nextCandidate = replaceCandidate(brainRoot, review.candidateId, candidate => {
    originalCandidate = candidate;
    if (candidate.status !== "candidate" && candidate.status !== "needs_changes") {
      throw new Error(`review 가능한 상태가 아닙니다: ${candidate.status}`);
    }
    return {
      ...candidate,
      status: review.decision,
      reviewedAt,
      reviewedBy: reviewer,
      reviewReason: reason,
      updatedAt: reviewedAt
    };
  });

  const decision = {
    decisionId: stableDecisionId(nextCandidate.candidateId, review.decision, reviewedAt),
    candidateId: nextCandidate.candidateId,
    scopeId: nextCandidate.scopeId,
    decision: review.decision,
    reviewer,
    reason,
    source: clonePlainObject(originalCandidate.source),
    target: clonePlainObject(originalCandidate.target),
    relation: clonePlainObject(originalCandidate.relation),
    score: originalCandidate.score,
    signals: clonePlainObject(originalCandidate.signals || []),
    createdFrom: "obsidian_relation_candidate_review",
    createdAt: reviewedAt
  };
  const decisionsPath = relationDecisionsPath(brainRoot);
  ensureDir(path.dirname(decisionsPath));
  const decisions = readJsonl(decisionsPath);
  decisions.push(decision);
  writeJsonl(decisionsPath, decisions);

  return { candidate: nextCandidate, decision };
}

function normalizeFrontmatterRelations(data) {
  if (!data.memory || typeof data.memory !== "object" || Array.isArray(data.memory)) {
    data.memory = {};
  }
  if (!Array.isArray(data.memory.relations)) data.memory.relations = [];
  return data.memory.relations;
}

function frontmatterHasRelation(relations, targetRef, relationType) {
  return relations.some(relation =>
    String(relation.target || relation.to || relation.ref || "").toLowerCase() === targetRef.toLowerCase() &&
    normalizeRelationType(relation.type || relation.relation) === relationType
  );
}

function backupMarkdownFile(filePath, root, backupDir) {
  const baseBackupDir = path.resolve(backupDir || path.join(path.dirname(filePath), ".brain-relation-backup"));
  const relativePath = root ? path.relative(path.resolve(root), path.resolve(filePath)) : path.basename(filePath);
  const backupPath = path.join(baseBackupDir, relativePath);
  ensureDir(path.dirname(backupPath));
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function applyRelationToMarkdown(candidate, options = {}) {
  const sourcePath = candidate.source && candidate.source.path;
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error(`source markdown 파일을 찾을 수 없습니다: ${sourcePath || "unknown"}`);
  }
  const content = fs.readFileSync(sourcePath, "utf-8");
  const parsed = splitFrontmatter(content);
  const data = parsed.data || {};
  const relations = normalizeFrontmatterRelations(data);
  const targetRef = candidate.target.canonicalId || candidate.target.sourceId;
  const relationType = normalizeRelationType(candidate.relation.type);
  const alreadyExists = frontmatterHasRelation(relations, targetRef, relationType);
  let backupPath = null;

  if (!alreadyExists) {
    backupPath = backupMarkdownFile(sourcePath, candidate.source.root, options.backupDir);
    relations.push({
      target: targetRef,
      type: relationType,
      direction: candidate.relation.direction || "outgoing",
      strength: candidate.relation.strength,
      status: "active",
      reason: candidate.reviewReason || candidate.relation.reason || "approved_relation_candidate"
    });
    fs.writeFileSync(sourcePath, renderFrontmatter(data, parsed.body), "utf-8");
  }

  return {
    sourcePath,
    backupPath,
    targetRef,
    relationType,
    changed: !alreadyExists
  };
}

function applyApprovedRelationCandidate(brainRoot, request = {}) {
  if (!request.candidateId) throw new Error("candidateId가 필요합니다.");
  const applicationsPath = relationApplicationsPath(brainRoot);
  ensureDir(path.dirname(applicationsPath));
  const applications = readJsonl(applicationsPath);
  const existing = applications.find(application => application.candidateId === request.candidateId);
  if (existing) {
    const candidate = listRelationCandidates(brainRoot).find(item => item.candidateId === request.candidateId);
    return { application: existing, candidate, applied: false };
  }

  const appliedAt = isoNow();
  let appliedResult;
  const nextCandidate = replaceCandidate(brainRoot, request.candidateId, candidate => {
    if (candidate.status !== "approved") {
      throw new Error("approved relation candidate만 적용할 수 있습니다.");
    }
    appliedResult = applyRelationToMarkdown(candidate, request);
    return {
      ...candidate,
      status: "applied",
      applicationId: stableApplicationId(candidate.candidateId),
      appliedAt,
      appliedBy: request.appliedBy || "unknown",
      applicationReason: request.reason || "",
      updatedAt: appliedAt
    };
  });

  const application = {
    applicationId: nextCandidate.applicationId,
    candidateId: nextCandidate.candidateId,
    scopeId: nextCandidate.scopeId,
    status: appliedResult.changed ? "applied" : "already_present",
    source: clonePlainObject(nextCandidate.source),
    target: clonePlainObject(nextCandidate.target),
    relation: clonePlainObject(nextCandidate.relation),
    result: appliedResult,
    appliedBy: nextCandidate.appliedBy,
    reason: nextCandidate.applicationReason,
    createdFrom: "obsidian_relation_candidate",
    appliedAt
  };
  applications.push(application);
  writeJsonl(applicationsPath, applications);

  return { application, candidate: nextCandidate, applied: true };
}

module.exports = {
  SCHEMA_VERSION,
  relationCandidatesPath,
  relationDecisionsPath,
  relationApplicationsPath,
  generateRelationCandidates,
  listRelationCandidates,
  reviewRelationCandidate,
  applyApprovedRelationCandidate
};
