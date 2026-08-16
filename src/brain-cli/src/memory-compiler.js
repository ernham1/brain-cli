"use strict";

const path = require("path");
const { ensureDir, isoNow, readJsonl, writeJsonl } = require("./utils");
const { upsertFact } = require("./fact-ledger");

function classesDir(brainRoot) {
  return path.join(brainRoot, "43_memory_classes");
}

function classesPath(brainRoot) {
  return path.join(classesDir(brainRoot), "classes.jsonl");
}

function classifyMemory(record = {}, content = "") {
  const type = record.type || "";
  const tags = Array.isArray(record.tags) ? record.tags.join(" ") : "";
  const text = `${record.title || ""} ${record.summary || ""} ${tags} ${content}`.toLowerCase();

  if (/guard|reflection|실패|반복|중복 제안/.test(text)) return "reflection";
  if (type === "project_state" || type === "decision") return "semantic";
  if (type === "rule" || /rule|절차|프로토콜|policy|운영 원칙/.test(text)) return "procedural";
  if (type === "log" || type === "note") return "episodic";
  return "semantic";
}

function extractFactCandidates(record = {}, content = "") {
  const text = `${record.title || ""} ${record.summary || ""} ${content}`;
  const candidates = [];
  if (/(밴딩AI|AgentForge|BandingAI)/i.test(text) && /HTML/i.test(text) && /(가능|지원|생성|산출물|supports?)/i.test(text)) {
    candidates.push({
      scopeType: record.scopeType || "project",
      scopeId: record.scopeId || "agentforge",
      subject: "AgentForge",
      predicate: "supports",
      object: "HTML artifact generation",
      sourceRecordIds: record.recordId ? [record.recordId] : [],
      sourceRefs: record.sourceRef ? [record.sourceRef] : [],
      sourceType: record.sourceType,
      recordType: record.type,
      confidence: record.sourceType === "user_confirmed" ? 0.95 : 0.82
    });
  }
  return candidates;
}

function compileRecord(brainRoot, record, content = "") {
  const memoryClass = classifyMemory(record, content);
  const compiled = {
    recordId: record.recordId,
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    memoryClass,
    sourceType: record.sourceType || "candidate",
    title: record.title || "",
    summary: record.summary || "",
    compiledAt: isoNow()
  };

  const existing = readJsonl(classesPath(brainRoot)).filter(item => item.recordId !== record.recordId);
  existing.push(compiled);
  ensureDir(classesDir(brainRoot));
  writeJsonl(classesPath(brainRoot), existing);

  const factResults = [];
  for (const candidate of extractFactCandidates(record, content)) {
    factResults.push(upsertFact(brainRoot, candidate));
  }

  return { compiled, factResults };
}

function loadRecords(brainRoot) {
  return readJsonl(path.join(brainRoot, "90_index", "records.jsonl"));
}

function compileMemory(brainRoot, options = {}) {
  const records = loadRecords(brainRoot);
  const targets = options.recordId
    ? records.filter(record => record.recordId === options.recordId)
    : records.filter(record => !options.scopeId || record.scopeId === options.scopeId);
  if (options.recordId && targets.length === 0) throw new Error(`record를 찾을 수 없습니다: ${options.recordId}`);

  const results = targets.map(record => compileRecord(brainRoot, record, options.content || ""));
  return { total: results.length, results };
}

module.exports = {
  classesPath,
  classifyMemory,
  extractFactCandidates,
  compileRecord,
  compileMemory
};
