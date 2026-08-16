"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const AUDIT_DIRS = ["00_user", "10_projects", "30_topics"];
const ROTATION_CUTOFF = "2026-07-05T00:00:00.000Z";

function normalizeRef(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .normalize("NFC");
}

function refKey(value) {
  return normalizeRef(value).toLowerCase();
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return { _parseError: `${filePath}:${index + 1}: ${error.message}` };
      }
    });
}

function walkFiles(root, relativeDir) {
  const start = path.join(root, relativeDir);
  if (!fs.existsSync(start)) return [];
  const files = [];
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile()) files.push(normalizeRef(path.relative(root, absolute)));
    }
  }
  return files;
}

function findHistoricalJsonls(brainRoot) {
  const indexDir = path.join(brainRoot, "90_index");
  if (!fs.existsSync(indexDir)) return [];
  const files = [];
  const current = path.join(indexDir, "records.jsonl");
  if (fs.existsSync(current)) files.push(current);
  for (const entry of fs.readdirSync(indexDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("_backup")) continue;
    const stack = [path.join(indexDir, entry.name)];
    while (stack.length > 0) {
      const currentDir = stack.pop();
      for (const child of fs.readdirSync(currentDir, { withFileTypes: true })) {
        const absolute = path.join(currentDir, child.name);
        if (child.isDirectory()) stack.push(absolute);
        else if (child.isFile() && /records.*\.jsonl$/i.test(child.name)) files.push(absolute);
      }
    }
  }
  return files;
}

function deriveScope(sourceRef, evidenceRecords) {
  const record = evidenceRecords.find(item => item.scopeId || item.scopeType);
  if (record) return { scopeType: record.scopeType || null, scopeId: record.scopeId || null };
  const segments = normalizeRef(sourceRef).split("/");
  const typeByDir = { "00_user": "user", "10_projects": "project", "30_topics": "topic" };
  return { scopeType: typeByDir[segments[0]] || null, scopeId: segments[1] || null };
}

function summarizeByScope(items) {
  const counts = new Map();
  for (const item of items) {
    const key = `${item.scopeType || "unknown"}/${item.scopeId || "unknown"}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([scope, count]) => ({ scope, count }))
    .sort((a, b) => b.count - a.count || a.scope.localeCompare(b.scope));
}

function auditRoot(brainRoot) {
  const dbPath = path.join(brainRoot, "90_index", "records.db");
  if (!fs.existsSync(dbPath)) throw new Error(`records.db 없음: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const dbRows = db.prepare(`
    SELECT record_id, scope_type, scope_id, source_ref, title, summary, status, updated_at, content_hash
    FROM records
  `).all();
  db.close();

  const dbById = new Map(dbRows.map(row => [row.record_id, row]));
  const dbByContentHash = new Map();
  for (const row of dbRows) {
    if (!row.content_hash) continue;
    if (!dbByContentHash.has(row.content_hash)) dbByContentHash.set(row.content_hash, []);
    dbByContentHash.get(row.content_hash).push(row);
  }
  const dbSourceKeys = new Set(dbRows.filter(row => row.source_ref).map(row => refKey(row.source_ref)));
  const diskFiles = AUDIT_DIRS.flatMap(dir => walkFiles(brainRoot, dir));
  const diskByKey = new Map(diskFiles.map(sourceRef => [refKey(sourceRef), sourceRef]));

  const jsonlFiles = findHistoricalJsonls(brainRoot);
  const evidenceBySource = new Map();
  const parseErrors = [];
  for (const jsonlFile of jsonlFiles) {
    for (const record of readJsonl(jsonlFile)) {
      if (record._parseError) {
        parseErrors.push(record._parseError);
        continue;
      }
      if (!record.sourceRef) continue;
      const key = refKey(record.sourceRef);
      if (!evidenceBySource.has(key)) evidenceBySource.set(key, { sourceRef: normalizeRef(record.sourceRef), records: [], evidence: [] });
      const item = evidenceBySource.get(key);
      item.records.push(record);
      item.evidence.push(normalizeRef(path.relative(brainRoot, jsonlFile)));
    }
  }

  const manifestPath = path.join(brainRoot, "90_index", "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    for (const entry of manifest.files || []) {
      if (!entry.path || !AUDIT_DIRS.some(dir => normalizeRef(entry.path).startsWith(`${dir}/`))) continue;
      const key = refKey(entry.path);
      if (!evidenceBySource.has(key)) evidenceBySource.set(key, { sourceRef: normalizeRef(entry.path), records: [], evidence: [] });
      evidenceBySource.get(key).evidence.push("90_index/manifest.json");
    }
  }

  const missingCandidates = [];
  for (const [key, evidence] of evidenceBySource) {
    if (dbSourceKeys.has(key) || !diskByKey.has(key)) continue;
    const scope = deriveScope(evidence.sourceRef, evidence.records);
    const fileBuffer = fs.readFileSync(path.join(brainRoot, diskByKey.get(key)));
    const contentHash = `sha256:${crypto.createHash("sha256").update(fileBuffer).digest("hex")}`;
    const contentIndexedBy = (dbByContentHash.get(contentHash) || []).map(row => ({
      recordId: row.record_id,
      sourceRef: normalizeRef(row.source_ref),
      status: row.status,
    }));
    const dateMatch = normalizeRef(evidence.sourceRef).match(/\/(\d{8})/);
    const sourceDate = dateMatch ? dateMatch[1] : null;
    const collisionRows = evidence.records
      .map(record => ({ record, current: dbById.get(record.recordId) }))
      .filter(item => item.current && refKey(item.current.source_ref) !== key)
      .map(item => ({
        recordId: item.record.recordId,
        previousTitle: item.record.title || "",
        currentTitle: item.current.title || "",
        currentSourceRef: normalizeRef(item.current.source_ref),
        currentUpdatedAt: item.current.updated_at,
        postRotationOverwrite: Boolean(item.current.updated_at && item.current.updated_at >= ROTATION_CUTOFF),
      }));
    missingCandidates.push({
      sourceRef: diskByKey.get(key),
      ...scope,
      protectedAreswar: String(scope.scopeId || "").toLowerCase() === "areswar",
      sourceDate,
      postRotationSource: Boolean(sourceDate && sourceDate >= "20260705"),
      contentHash,
      contentIndexedBy,
      collisionRows,
      evidence: [...new Set(evidence.evidence)].sort(),
      historicalRecordIds: [...new Set(evidence.records.map(record => record.recordId).filter(Boolean))],
    });
  }
  missingCandidates.sort((a, b) => a.sourceRef.localeCompare(b.sourceRef));

  const diskOnly = diskFiles
    .filter(sourceRef => !dbSourceKeys.has(refKey(sourceRef)) && !evidenceBySource.has(refKey(sourceRef)))
    .map(sourceRef => ({ sourceRef, ...deriveScope(sourceRef, []) }));
  const dbMissingFiles = dbRows
    .filter(row => row.source_ref && !diskByKey.has(refKey(row.source_ref)))
    .map(row => ({ recordId: row.record_id, sourceRef: normalizeRef(row.source_ref), scopeType: row.scope_type, scopeId: row.scope_id, status: row.status }));

  const k4Path = path.join(brainRoot, "90_index", "k4_events.jsonl");
  const k4RecordIds = new Set(readJsonl(k4Path).map(event => event.recordId).filter(Boolean));
  return {
    brainRoot,
    generatedAt: new Date().toISOString(),
    cutoff: ROTATION_CUTOFF,
    totals: {
      dbRecords: dbRows.length,
      dbDistinctSourceRefs: dbSourceKeys.size,
      diskFiles: diskFiles.length,
      historicalJsonlFiles: jsonlFiles.length,
      historicalSourceRefs: evidenceBySource.size,
      missingCandidates: missingCandidates.length,
      protectedAreswarCandidates: missingCandidates.filter(item => item.protectedAreswar).length,
      postRotationSourceCandidates: missingCandidates.filter(item => item.postRotationSource).length,
      contentAlreadyIndexedCandidates: missingCandidates.filter(item => item.contentIndexedBy.length > 0).length,
      repairNeededAfterRotation: missingCandidates.filter(item => item.postRotationSource && !item.protectedAreswar && item.contentIndexedBy.length === 0).length,
      collisionConfirmedCandidates: missingCandidates.filter(item => item.collisionRows.length > 0).length,
      postRotationCollisionCandidates: missingCandidates.filter(item => item.collisionRows.some(row => row.postRotationOverwrite)).length,
      diskOnlyWithoutIndexEvidence: diskOnly.length,
      dbSourceRefsMissingOnDisk: dbMissingFiles.length,
      k4Events: k4RecordIds.size,
      parseErrors: parseErrors.length,
    },
    missingByScope: summarizeByScope(missingCandidates),
    diskOnlyByScope: summarizeByScope(diskOnly),
    missingCandidates,
    dbSourceRefsMissingOnDisk: dbMissingFiles,
    historicalJsonlFiles: jsonlFiles.map(file => normalizeRef(file)),
    parseErrors,
  };
}

function main() {
  const roots = process.argv.slice(2).filter(arg => !arg.startsWith("--output="));
  const outputArg = process.argv.slice(2).find(arg => arg.startsWith("--output="));
  if (roots.length === 0) throw new Error("사용법: node scripts/audit-record-index.js <brainRoot...> [--output=report.json]");
  const report = { generatedAt: new Date().toISOString(), roots: roots.map(auditRoot) };
  if (outputArg) {
    const outputPath = path.resolve(outputArg.slice("--output=".length));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
  }
  process.stdout.write(JSON.stringify({
    generatedAt: report.generatedAt,
    roots: report.roots.map(item => ({ brainRoot: item.brainRoot, totals: item.totals, missingByScope: item.missingByScope })),
  }, null, 2) + "\n");
}

if (require.main === module) main();

module.exports = { auditRoot };