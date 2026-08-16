"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ensureDir, isoNow, readJsonl, writeJsonl } = require("./utils");
const { loadActiveState, saveActiveState } = require("./active-state");

function factDir(brainRoot) {
  return path.join(brainRoot, "42_facts");
}

function factsPath(brainRoot) {
  return path.join(factDir(brainRoot), "facts.jsonl");
}

function scopeFactsPath(brainRoot, scopeId) {
  return path.join(factDir(brainRoot), `${scopeId}.json`);
}

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function factAxis(fact) {
  return `${normalizeText(fact.scopeId).toLowerCase()}::${normalizeText(fact.subject).toLowerCase()}::${normalizeText(fact.predicate).toLowerCase()}`;
}

function createFactId(fact) {
  const seed = [
    fact.scopeType || "project",
    fact.scopeId,
    normalizeText(fact.subject).toLowerCase(),
    normalizeText(fact.predicate).toLowerCase(),
    normalizeText(fact.object).toLowerCase()
  ].join("|");
  return `fact_${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 12)}`;
}

function readFacts(brainRoot) {
  return readJsonl(factsPath(brainRoot));
}

function writeFacts(brainRoot, facts) {
  ensureDir(factDir(brainRoot));
  writeJsonl(factsPath(brainRoot), facts);
  const byScope = {};
  for (const fact of facts) {
    if (!byScope[fact.scopeId]) byScope[fact.scopeId] = [];
    byScope[fact.scopeId].push(fact);
  }
  for (const [scopeId, scopeFacts] of Object.entries(byScope)) {
    fs.writeFileSync(scopeFactsPath(brainRoot, scopeId), JSON.stringify({
      scopeId,
      updatedAt: isoNow(),
      facts: scopeFacts
    }, null, 2), "utf-8");
  }
}

function isHighTrust(input) {
  return input.sourceType === "user_confirmed" || input.recordType === "project_state";
}

function normalizeFactInput(input) {
  const sourceRecordIds = Array.isArray(input.sourceRecordIds) ? input.sourceRecordIds.filter(Boolean) : [];
  const sourceRefs = Array.isArray(input.sourceRefs) ? input.sourceRefs.filter(Boolean) : [];
  if (input.sourceRecordId) sourceRecordIds.push(input.sourceRecordId);
  if (input.sourceRef) sourceRefs.push(input.sourceRef);

  const fact = {
    factId: input.factId,
    scopeType: input.scopeType || "project",
    scopeId: input.scopeId || input.scope,
    subject: normalizeText(input.subject),
    predicate: normalizeText(input.predicate),
    object: normalizeText(input.object),
    status: input.status || "active",
    validFrom: input.validFrom || isoNow(),
    validTo: input.validTo || null,
    supersedes: Array.isArray(input.supersedes) ? input.supersedes : [],
    sourceRecordIds,
    sourceRefs,
    sourceType: input.sourceType || null,
    recordType: input.recordType || null,
    confidence: typeof input.confidence === "number" ? input.confidence : 0.8,
    updatedAt: input.updatedAt || isoNow()
  };

  if (!fact.scopeId) throw new Error("fact scopeId가 필요합니다.");
  if (!fact.subject || !fact.predicate || !fact.object) {
    throw new Error("fact subject/predicate/object가 필요합니다.");
  }
  if (fact.status === "active" && sourceRecordIds.length === 0 && sourceRefs.length === 0) {
    throw new Error("active fact에는 sourceRecordIds 또는 sourceRefs가 필요합니다.");
  }

  fact.factId = fact.factId || createFactId(fact);
  return fact;
}

function upsertFact(brainRoot, input) {
  const facts = readFacts(brainRoot);
  const incoming = normalizeFactInput(input);
  const now = isoNow();
  const existingIndex = facts.findIndex(fact => fact.factId === incoming.factId);

  if (existingIndex >= 0) {
    const updated = {
      ...facts[existingIndex],
      ...incoming,
      sourceRecordIds: Array.from(new Set([...(facts[existingIndex].sourceRecordIds || []), ...incoming.sourceRecordIds])),
      sourceRefs: Array.from(new Set([...(facts[existingIndex].sourceRefs || []), ...incoming.sourceRefs])),
      updatedAt: now
    };
    facts[existingIndex] = updated;
    writeFacts(brainRoot, facts);
    syncActiveStateFacts(brainRoot, incoming.scopeId);
    return { action: "updated", fact: updated, conflicts: [] };
  }

  const axis = factAxis(incoming);
  const activeConflicts = facts.filter(fact =>
    factAxis(fact) === axis &&
    fact.status === "active" &&
    normalizeText(fact.object).toLowerCase() !== normalizeText(incoming.object).toLowerCase()
  );

  const supersedes = [];
  const conflicts = [];
  if (activeConflicts.length > 0) {
    if (isHighTrust(input)) {
      for (const conflict of activeConflicts) {
        conflict.status = "superseded";
        conflict.validTo = now;
        conflict.updatedAt = now;
        supersedes.push(conflict.factId);
      }
      incoming.supersedes = Array.from(new Set([...(incoming.supersedes || []), ...supersedes]));
    } else {
      incoming.status = "disputed";
      conflicts.push(...activeConflicts.map(fact => fact.factId));
    }
  }

  facts.push({ ...incoming, updatedAt: now });
  writeFacts(brainRoot, facts);
  syncActiveStateFacts(brainRoot, incoming.scopeId);
  return { action: "created", fact: incoming, conflicts };
}

function listFacts(brainRoot, options = {}) {
  return readFacts(brainRoot).filter(fact => {
    if (options.scopeId && fact.scopeId !== options.scopeId) return false;
    if (options.status && fact.status !== options.status) return false;
    return true;
  });
}

function factToActiveStateFact(fact) {
  return {
    id: fact.factId,
    title: `${fact.subject} ${fact.predicate}`,
    summary: `${fact.subject} ${fact.predicate} ${fact.object}`,
    status: fact.status,
    sourceRefs: [...(fact.sourceRefs || []), ...(fact.sourceRecordIds || [])],
    updatedAt: fact.updatedAt
  };
}

function factLooksLikeHtmlCapability(fact) {
  const text = `${fact.subject} ${fact.predicate} ${fact.object}`.toLowerCase();
  return /(agentforge|밴딩ai|bandingai)/i.test(text) && /html/i.test(text) && /(support|supports|지원|가능|생성)/i.test(text);
}

function syncActiveStateFacts(brainRoot, scopeId) {
  const activeFacts = listFacts(brainRoot, { scopeId, status: "active" });
  const state = loadActiveState(brainRoot, scopeId);
  const existingById = new Map((state.facts || []).map(fact => [fact.id, fact]));
  for (const fact of activeFacts) existingById.set(fact.factId, factToActiveStateFact(fact));
  state.facts = Array.from(existingById.values());

  for (const fact of activeFacts.filter(factLooksLikeHtmlCapability)) {
    const sourceRefs = [...(fact.sourceRefs || []), ...(fact.sourceRecordIds || [])];
    const capabilityId = `${scopeId}.html-artifact-output`;
    const existingCapability = (state.capabilities || []).find(capability => capability.id === capabilityId);
    const capability = {
      id: capabilityId,
      title: "밴딩AI HTML 산출물 가능",
      summary: "밴딩AI는 HTML 산출물을 생성할 수 있으므로 신규 제안이 아니라 기존 기능 연결 대상으로 다뤄야 한다.",
      status: "active",
      sourceRefs,
      updatedAt: fact.updatedAt
    };
    if (existingCapability) Object.assign(existingCapability, capability);
    else state.capabilities.push(capability);
    for (const ref of sourceRefs) {
      if (!state.sourceRefs.includes(ref)) state.sourceRefs.push(ref);
    }
  }

  return saveActiveState(brainRoot, state);
}

module.exports = {
  factDir,
  factsPath,
  readFacts,
  writeFacts,
  upsertFact,
  listFacts,
  syncActiveStateFacts,
  normalizeFactInput
};
