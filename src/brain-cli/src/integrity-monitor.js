"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const MONITOR_VERSION = 1;

function normalizeRef(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").normalize("NFC");
}

function resolveInside(root, sourceRef) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalizeRef(sourceRef));
  if (resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep)) return resolved;
  return null;
}

function readJsonlState(filePath) {
  const records = [];
  const parseIssues = [];
  if (!fs.existsSync(filePath)) {
    parseIssues.push({
      key: "records-jsonl:missing",
      type: "invalid-jsonl",
      severity: "critical",
      details: "records.jsonl 파일 없음",
    });
    return { records, parseIssues };
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    try {
      const record = JSON.parse(lines[index]);
      if (record.recordId) records.push(record);
    } catch {
      parseIssues.push({
        key: `invalid-jsonl-line:${index + 1}`,
        type: "invalid-jsonl",
        severity: "critical",
        details: `records.jsonl ${index + 1}행 파싱 실패`,
      });
    }
  }
  return { records, parseIssues };
}

function readDbRows(dbPath) {
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`
      SELECT record_id, source_ref, content_hash, status
      FROM records
      ORDER BY record_id
    `).all();
  } finally {
    db.close();
  }
}

function readManifestMap(manifestPath) {
  if (!fs.existsSync(manifestPath)) return { map: new Map(), error: "manifest 파일 없음" };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
  catch { return { map: new Map(), error: "manifest JSON 파싱 실패" }; }
  const map = new Map();
  if (Array.isArray(manifest.files)) {
    for (const entry of manifest.files) {
      if (!entry || !entry.path) continue;
      map.set(normalizeRef(entry.path), entry.hash || entry.contentHash || null);
    }
  } else if (manifest.files && typeof manifest.files === "object") {
    for (const [sourceRef, value] of Object.entries(manifest.files)) {
      map.set(
        normalizeRef(sourceRef),
        typeof value === "string" ? value : value && (value.hash || value.contentHash) || null
      );
    }
  }
  return { map, error: null };
}

function readSourceContract(brainRoot) {
  const contractPath = path.join(brainRoot, "90_index", "integrity-monitor", "source-contract.json");
  const empty = { exclusions: new Set(), exclusionPatterns: [], error: null, contractPath };
  if (!fs.existsSync(contractPath)) return empty;
  try {
    const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
    if (!Array.isArray(contract.manifestHashExclusions)) {
      return { ...empty, error: "source-contract manifestHashExclusions 배열 없음" };
    }
    const exclusions = new Set(contract.manifestHashExclusions
      .map(entry => normalizeRef(entry && entry.sourceRef))
      .filter(Boolean));
    const exclusionPatterns = contract.manifestHashExclusions
      .map(entry => ({
        prefix: normalizeRef(entry && entry.sourceRefPrefix),
        suffix: normalizeRef(entry && entry.sourceRefSuffix),
      }))
      .filter(entry => entry.prefix || entry.suffix);
    return { exclusions, exclusionPatterns, error: null, contractPath };
  } catch {
    return { ...empty, error: "source-contract JSON 파싱 실패" };
  }
}

function isManifestHashExcluded(sourceContract, sourceRef) {
  const normalized = normalizeRef(sourceRef);
  if (sourceContract.exclusions.has(normalized)) return true;
  return sourceContract.exclusionPatterns.some(pattern =>
    (!pattern.prefix || normalized.startsWith(pattern.prefix))
    && (!pattern.suffix || normalized.endsWith(pattern.suffix))
  );
}

function hashFile(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function issue(key, type, severity, recordId, sourceRef, details) {
  return { key, type, severity, recordId: recordId || null, sourceRef: sourceRef || null, details };
}

function auditIntegrity(brainRoot) {
  const root = path.resolve(brainRoot);
  const indexDir = path.join(root, "90_index");
  const jsonState = readJsonlState(path.join(indexDir, "records.jsonl"));
  const dbRows = readDbRows(path.join(indexDir, "records.db"));
  const manifestState = readManifestMap(path.join(indexDir, "manifest.json"));
  const sourceContract = readSourceContract(root);
  const issues = [...jsonState.parseIssues];
  const jsonById = new Map();
  const duplicateIds = new Set();

  for (const record of jsonState.records) {
    if (jsonById.has(record.recordId)) duplicateIds.add(record.recordId);
    else jsonById.set(record.recordId, record);
  }
  for (const recordId of [...duplicateIds].sort()) {
    issues.push(issue(`duplicate-jsonl:${recordId}`, "duplicate-jsonl", "critical", recordId, null, "records.jsonl 중복 ID"));
  }

  const dbById = new Map(dbRows.map(row => [row.record_id, row]));
  for (const [recordId, record] of jsonById) {
    if (!dbById.has(recordId)) {
      issues.push(issue(`jsonl-missing-db:${recordId}`, "jsonl-missing-db", "critical", recordId, record.sourceRef, "JSONL에는 있으나 DB에 없음"));
    }
  }

  if (manifestState.error) {
    issues.push(issue("manifest:unreadable", "hash-contract", "critical", null, null, manifestState.error));
  }
  if (sourceContract.error) {
    issues.push(issue("source-contract:unreadable", "hash-contract", "critical", null, null, sourceContract.error));
  }

  const checkedManifestRefs = new Set();
  for (const row of dbRows) {
    const sourceRef = normalizeRef(row.source_ref);
    const sourcePath = sourceRef ? resolveInside(root, sourceRef) : null;
    const rawExists = Boolean(sourcePath && fs.existsSync(sourcePath));
    const jsonRecord = jsonById.get(row.record_id);

    if (!jsonRecord && rawExists) {
      issues.push(issue(`db-missing-jsonl:${row.record_id}`, "db-missing-jsonl", "critical", row.record_id, sourceRef, "DB와 Raw에는 있으나 JSONL에 없음"));
    }
    if (sourceRef && !["deprecated", "archived"].includes(row.status) && !rawExists) {
      issues.push(issue(`missing-raw:${row.record_id}`, "missing-raw", "warning", row.record_id, sourceRef, "active DB record의 Raw 없음"));
    }
    if (!jsonRecord || !sourceRef) continue;

    const jsonHash = jsonRecord.contentHash || null;
    const dbHash = row.content_hash || null;
    if (!jsonHash || !dbHash || jsonHash !== dbHash) {
      issues.push(issue(
        `hash-contract:${row.record_id}`,
        "hash-contract",
        "critical",
        row.record_id,
        sourceRef,
        { jsonHash, dbHash }
      ));
    }
    if (rawExists && !checkedManifestRefs.has(sourceRef)) {
      checkedManifestRefs.add(sourceRef);
      if (isManifestHashExcluded(sourceContract, sourceRef)) continue;
      const manifestHash = manifestState.map.get(sourceRef) || null;
      const rawHash = hashFile(sourcePath);
      if (!manifestHash || manifestHash !== rawHash) {
        issues.push(issue(
          `hash-contract:source:${sourceRef}`,
          "hash-contract",
          "critical",
          null,
          sourceRef,
          { manifestHash, rawHash }
        ));
      }
    }
  }

  if (fs.existsSync(indexDir)) {
    for (const entry of fs.readdirSync(indexDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".tmp")) {
        issues.push(issue(`index-tmp:${entry.name}`, "index-tmp", "critical", null, null, "90_index 최상위 tmp 잔류"));
      }
    }
  }

  issues.sort((left, right) => left.key.localeCompare(right.key));
  const byType = {};
  for (const item of issues) byType[item.type] = (byType[item.type] || 0) + 1;
  return {
    version: MONITOR_VERSION,
    generatedAt: new Date().toISOString(),
    brainRoot: root,
    readOnly: true,
    totals: {
      jsonRecords: jsonState.records.length,
      uniqueJsonRecords: jsonById.size,
      dbRecords: dbRows.length,
      issues: issues.length,
    },
    byType,
    sourceContractExclusions: sourceContract.exclusions.size + sourceContract.exclusionPatterns.length,
    issues,
  };
}

function baselineSignature(issueKeys) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(issueKeys)).digest("hex")}`;
}

function writeFilePreservingPrevious(filePath, body) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const suffix = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const tmpPath = `${resolved}.${suffix}.tmp`;
  let backupPath = null;
  fs.writeFileSync(tmpPath, body, { encoding: "utf8", flag: "wx" });
  try {
    if (fs.existsSync(resolved)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      backupPath = `${resolved}.backup-${stamp}-${suffix}`;
      fs.renameSync(resolved, backupPath);
    }
    fs.renameSync(tmpPath, resolved);
  } catch (error) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    if (backupPath && fs.existsSync(backupPath) && !fs.existsSync(resolved)) fs.renameSync(backupPath, resolved);
    throw error;
  }
  return { path: resolved, backupPath };
}

function createIntegrityBaseline(brainRoot, baselinePath) {
  const audit = auditIntegrity(brainRoot);
  const issueKeys = audit.issues.map(item => item.key);
  const baseline = {
    version: MONITOR_VERSION,
    createdAt: new Date().toISOString(),
    brainRoot: audit.brainRoot,
    issueKeys,
    issueCount: issueKeys.length,
    signature: baselineSignature(issueKeys),
  };
  const written = writeFilePreservingPrevious(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
  return { baseline, audit, baselinePath: written.path, backupPath: written.backupPath };
}

function compareWithBaseline(audit, baseline) {
  if (!baseline || !Array.isArray(baseline.issueKeys)) {
    return {
      status: "baseline_missing",
      generatedAt: audit.generatedAt,
      knownIssues: [],
      newIssues: [...audit.issues],
      resolvedIssueKeys: [],
      audit,
    };
  }
  const known = new Set(baseline.issueKeys);
  const current = new Set(audit.issues.map(item => item.key));
  const newIssues = audit.issues.filter(item => !known.has(item.key));
  const knownIssues = audit.issues.filter(item => known.has(item.key));
  const resolvedIssueKeys = baseline.issueKeys.filter(key => !current.has(key));
  return {
    status: newIssues.length > 0 ? "alert" : "healthy",
    generatedAt: audit.generatedAt,
    baselineCreatedAt: baseline.createdAt || null,
    baselineSignature: baseline.signature || null,
    knownIssues,
    newIssues,
    resolvedIssueKeys,
    audit,
  };
}

function monitorDirectory(brainRoot) {
  return path.join(path.resolve(brainRoot), "90_index", "integrity-monitor");
}

function defaultBaselinePath(brainRoot) {
  return path.join(monitorDirectory(brainRoot), "baseline.json");
}

function loadIntegrityBaseline(baselinePath) {
  if (!fs.existsSync(baselinePath)) return null;
  try {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    return Array.isArray(baseline.issueKeys) ? baseline : null;
  } catch {
    return null;
  }
}

function eventPayload(result) {
  return {
    version: MONITOR_VERSION,
    generatedAt: result.generatedAt,
    status: result.status,
    brainRoot: result.audit.brainRoot,
    baselineCreatedAt: result.baselineCreatedAt || null,
    baselineSignature: result.baselineSignature || null,
    summary: {
      totalIssues: result.audit.totals.issues,
      knownIssues: result.knownIssues.length,
      newIssues: result.newIssues.length,
      resolvedIssues: result.resolvedIssueKeys.length,
    },
    byType: result.audit.byType,
    newIssues: result.newIssues,
    resolvedIssueKeys: result.resolvedIssueKeys,
  };
}

function writeIntegrityEvent(brainRoot, result, eventDirectory) {
  const directory = eventDirectory ? path.resolve(eventDirectory) : path.join(monitorDirectory(brainRoot), "events");
  fs.mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${stamp}-${process.pid}-${crypto.randomUUID().slice(0, 8)}.json`;
  const eventPath = path.join(directory, fileName);
  const event = eventPayload(result);
  fs.writeFileSync(eventPath, JSON.stringify(event, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  return { eventPath, event };
}

function readLatestIntegrityEvent(brainRoot, eventDirectory) {
  const directory = eventDirectory ? path.resolve(eventDirectory) : path.join(monitorDirectory(brainRoot), "events");
  if (!fs.existsSync(directory)) return null;
  const files = fs.readdirSync(directory)
    .filter(name => name.endsWith(".json"))
    .sort();
  if (files.length === 0) return null;
  try { return JSON.parse(fs.readFileSync(path.join(directory, files[files.length - 1]), "utf8")); }
  catch { return null; }
}

function runIntegrityMonitor(brainRoot, options = {}) {
  const baselinePath = path.resolve(options.baselinePath || defaultBaselinePath(brainRoot));
  const audit = auditIntegrity(brainRoot);
  const baseline = options.baseline || loadIntegrityBaseline(baselinePath);
  const result = compareWithBaseline(audit, baseline);
  let eventPath = null;
  if (options.recordEvent) eventPath = writeIntegrityEvent(brainRoot, result, options.eventDirectory).eventPath;
  return { ...result, baselinePath, eventPath };
}

function publicMonitorResult(result) {
  return {
    status: result.status,
    generatedAt: result.generatedAt,
    brainRoot: result.audit.brainRoot,
    baselinePath: result.baselinePath || null,
    eventPath: result.eventPath || null,
    totals: result.audit.totals,
    byType: result.audit.byType,
    knownIssueCount: result.knownIssues.length,
    newIssueCount: result.newIssues.length,
    resolvedIssueCount: result.resolvedIssueKeys.length,
    newIssues: result.newIssues.slice(0, 100),
    resolvedIssueKeys: result.resolvedIssueKeys.slice(0, 100),
  };
}
module.exports = {
  MONITOR_VERSION,
  auditIntegrity,
  createIntegrityBaseline,
  compareWithBaseline,
  readManifestMap,
  readSourceContract,
  isManifestHashExcluded,
  writeFilePreservingPrevious,
  monitorDirectory,
  defaultBaselinePath,
  loadIntegrityBaseline,
  writeIntegrityEvent,
  readLatestIntegrityEvent,
  runIntegrityMonitor,
  publicMonitorResult,
};