"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const Database = require("better-sqlite3");
const { acquireLock } = require("../src/lock");

function normalizeRef(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").normalize("NFC");
}

function resolveInside(root, sourceRef) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalizeRef(sourceRef));
  if (resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep)) return resolved;
  return null;
}

function hashBuffer(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function hashFile(filePath) {
  return hashBuffer(fs.readFileSync(filePath));
}

async function readJsonlIds(filePath) {
  const ids = new Set();
  if (!fs.existsSync(filePath)) return ids;
  const input = fs.createReadStream(filePath);
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.recordId) ids.add(record.recordId);
  }
  return ids;
}

function readDbRows(brainRoot) {
  const dbPath = path.join(brainRoot, "90_index", "records.db");
  if (!fs.existsSync(dbPath)) throw new Error(`records.db 없음: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`
      SELECT record_id, scope_type, scope_id, type, title, summary, tags,
             source_ref, source_type, status, replaced_by, deprecation_reason,
             updated_at, content_hash, original_chunk
      FROM records
      ORDER BY record_id
    `).all();
  } finally {
    db.close();
  }
}

function increment(map, key) {
  map[key] = (map[key] || 0) + 1;
}

const EVIDENCE_SCAN_SKIP_DIRS = new Set([".git", "node_modules"]);

function scanEvidenceRoots(evidenceRoots, targetRows) {
  const roots = [...new Set((evidenceRoots || []).map(root => path.resolve(root)))]
    .filter(root => fs.existsSync(root));
  const targetsByName = new Map();
  for (const row of targetRows) {
    if (!row.source_ref || !row.content_hash) continue;
    const fileName = path.basename(normalizeRef(row.source_ref)).toLowerCase();
    if (!targetsByName.has(fileName)) targetsByName.set(fileName, new Set());
    targetsByName.get(fileName).add(row.content_hash);
  }

  const evidenceByHash = new Map();
  const stats = {
    roots: roots.length,
    scannedFiles: 0,
    basenameMatches: 0,
    hashChecks: 0,
    exactEvidenceFiles: 0,
    skippedDirectories: 0,
  };

  for (const evidenceRoot of roots) {
    const stack = [evidenceRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      let entries;
      try { entries = fs.readdirSync(current, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (EVIDENCE_SCAN_SKIP_DIRS.has(entry.name.toLowerCase())) {
            stats.skippedDirectories++;
            continue;
          }
          stack.push(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;
        stats.scannedFiles++;
        const expectedHashes = targetsByName.get(entry.name.toLowerCase());
        if (!expectedHashes) continue;
        stats.basenameMatches++;
        let actualHash;
        try {
          stats.hashChecks++;
          actualHash = hashFile(fullPath);
        } catch { continue; }
        if (!expectedHashes.has(actualHash)) continue;
        stats.exactEvidenceFiles++;
        if (!evidenceByHash.has(actualHash)) evidenceByHash.set(actualHash, []);
        evidenceByHash.get(actualHash).push({
          origin: "external-file-exact",
          path: fullPath,
          root: evidenceRoot,
        });
      }
    }
  }

  return { roots, stats, evidenceByHash };
}

async function planRecovery(brainRoot, options = {}) {
  const root = path.resolve(brainRoot);
  const requestedIds = new Set(options.recordIds || []);
  const peerRoots = [...new Set((options.peerRoots || []).map(peer => path.resolve(peer)))]
    .filter(peer => peer !== root && fs.existsSync(peer));
  const jsonIds = await readJsonlIds(path.join(root, "90_index", "records.jsonl"));
  const rows = readDbRows(root);
  const dbOnlyRows = rows.filter(row => !jsonIds.has(row.record_id));
  const missingRows = dbOnlyRows.filter(row => {
    if (requestedIds.size > 0 && !requestedIds.has(row.record_id)) return false;
    const sourcePath = row.source_ref ? resolveInside(root, row.source_ref) : null;
    return !sourcePath || !fs.existsSync(sourcePath);
  });
  const targetHashes = new Set(missingRows.map(row => row.content_hash).filter(Boolean));
  const evidenceByHash = new Map();
  const checkedPaths = new Set();

  function addEvidence(candidateRoot, row, origin) {
    if (!row.content_hash || !targetHashes.has(row.content_hash) || !row.source_ref) return;
    const candidatePath = resolveInside(candidateRoot, row.source_ref);
    if (!candidatePath || checkedPaths.has(candidatePath.toLowerCase()) || !fs.existsSync(candidatePath)) return;
    checkedPaths.add(candidatePath.toLowerCase());
    if (!fs.statSync(candidatePath).isFile()) return;
    const actualHash = hashFile(candidatePath);
    if (actualHash !== row.content_hash) return;
    if (!evidenceByHash.has(actualHash)) evidenceByHash.set(actualHash, []);
    evidenceByHash.get(actualHash).push({ origin, path: candidatePath, sourceRef: normalizeRef(row.source_ref) });
  }

  for (const row of rows) addEvidence(root, row, "current-hash-match");
  for (const peerRoot of peerRoots) {
    const peerDbPath = path.join(peerRoot, "90_index", "records.db");
    if (!fs.existsSync(peerDbPath)) continue;
    for (const row of readDbRows(peerRoot)) addEvidence(peerRoot, row, `peer-hash-match:${peerRoot}`);
  }

  const evidenceScan = scanEvidenceRoots(options.evidenceRoots || [], missingRows);
  for (const [contentHash, matches] of evidenceScan.evidenceByHash) {
    if (!evidenceByHash.has(contentHash)) evidenceByHash.set(contentHash, []);
    evidenceByHash.get(contentHash).push(...matches);
  }

  const candidates = [];
  const byClass = {};
  const byScope = {};
  const byEvidence = {};
  for (const row of missingRows) {
    const sourceRef = normalizeRef(row.source_ref);
    let classification = "D";
    let evidence = null;
    const expectedHash = row.content_hash || null;

    if (row.original_chunk) {
      const originalHash = hashBuffer(Buffer.from(row.original_chunk, "utf8"));
      if (expectedHash && originalHash === expectedHash) {
        classification = "A";
        evidence = { type: "original-chunk-exact", hash: originalHash };
      } else {
        classification = "C";
        evidence = { type: "original-chunk-mismatch", hash: originalHash };
      }
    }

    if (classification !== "A" && sourceRef) {
      for (const peerRoot of peerRoots) {
        const peerPath = resolveInside(peerRoot, sourceRef);
        if (!peerPath || !fs.existsSync(peerPath) || !fs.statSync(peerPath).isFile()) continue;
        const peerHash = hashFile(peerPath);
        if (expectedHash && peerHash === expectedHash) {
          classification = "A";
          evidence = { type: "peer-source-exact", path: peerPath, hash: peerHash };
          break;
        }
        if (classification === "D") {
          classification = "C";
          evidence = { type: "peer-source-mismatch", path: peerPath, hash: peerHash };
        }
      }
    }

    if (classification !== "A" && expectedHash && evidenceByHash.has(expectedHash)) {
      const match = evidenceByHash.get(expectedHash)[0];
      classification = "B";
      evidence = { type: match.origin, path: match.path, root: match.root || null, hash: expectedHash };
    }

    const scope = `${row.scope_type || "unknown"}/${row.scope_id || "unknown"}`;
    increment(byClass, classification);
    increment(byScope, scope);
    increment(byEvidence, evidence ? evidence.type : "none");
    candidates.push({
      recordId: row.record_id,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      sourceRef,
      contentHash: expectedHash,
      classification,
      evidence,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    brainRoot: root,
    peerRoots,
    evidenceRoots: evidenceScan.roots,
    evidenceScan: evidenceScan.stats,
    totals: {
      dbRecords: rows.length,
      jsonRecords: jsonIds.size,
      dbOnlyRecords: dbOnlyRows.length,
      dbOnlyWithRaw: dbOnlyRows.length - missingRows.length,
      dbOnlyRawMissing: missingRows.length,
      recoverableRecords: (byClass.A || 0) + (byClass.B || 0),
      partialEvidenceRecords: byClass.C || 0,
      noEvidenceRecords: byClass.D || 0,
      originalChunkRows: rows.filter(row => Boolean(row.original_chunk)).length,
    },
    byClass,
    byEvidence,
    byScope,
    candidates,
  };
}

async function applyRawRecovery(brainRoot, options = {}) {
  if (!Array.isArray(options.recordIds) || options.recordIds.length === 0) {
    throw new Error("--apply에는 --record-id allowlist가 필요합니다");
  }
  const plan = await planRecovery(brainRoot, options);
  const limit = Number.isFinite(options.limit) ? options.limit : Infinity;
  const eligible = plan.candidates.filter(item => ["A", "B"].includes(item.classification));
  const bySourceRef = new Map();
  const conflicts = [];
  for (const item of eligible) {
    if (!item.sourceRef || !item.contentHash) continue;
    const existing = bySourceRef.get(item.sourceRef.toLowerCase());
    if (existing && existing.contentHash !== item.contentHash) {
      conflicts.push({ sourceRef: item.sourceRef, recordIds: [existing.recordId, item.recordId] });
      bySourceRef.delete(item.sourceRef.toLowerCase());
      continue;
    }
    if (!existing) bySourceRef.set(item.sourceRef.toLowerCase(), item);
  }
  const selected = [...bySourceRef.values()].slice(0, limit);
  const lock = acquireLock(plan.brainRoot, { staleMs: 30000, timeoutMs: 30000 });
  const created = [];
  const skipped = [];
  try {
    for (const item of selected) {
      const targetPath = resolveInside(plan.brainRoot, item.sourceRef);
      if (!targetPath) { skipped.push({ recordId: item.recordId, reason: "unsafe-source-ref" }); continue; }
      if (fs.existsSync(targetPath)) { skipped.push({ recordId: item.recordId, reason: "target-exists" }); continue; }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const tmpPath = `${targetPath}.forensic-tmp`;
      if (item.evidence.type === "original-chunk-exact") {
        const row = readDbRows(plan.brainRoot).find(record => record.record_id === item.recordId);
        fs.writeFileSync(tmpPath, row.original_chunk, "utf8");
      } else {
        fs.copyFileSync(item.evidence.path, tmpPath);
      }
      const actualHash = hashFile(tmpPath);
      if (actualHash !== item.contentHash) {
        fs.unlinkSync(tmpPath);
        skipped.push({ recordId: item.recordId, reason: "hash-mismatch" });
        continue;
      }
      fs.renameSync(tmpPath, targetPath);
      created.push({ recordId: item.recordId, sourceRef: item.sourceRef, contentHash: actualHash });
    }
  } finally {
    lock.release();
  }
  return { applied: true, created, skipped, conflicts, remainingIndexRepair: created.length };
}

function writeQuarantineCatalog(plan, outputPath) {
  const resolvedOutput = path.resolve(outputPath);
  const checkedEvidenceRoots = [...(plan.evidenceRoots || [])];
  const rows = (plan.candidates || [])
    .filter(item => item.classification === "C" || item.classification === "D")
    .sort((left, right) => left.recordId.localeCompare(right.recordId))
    .map(item => ({
      recordId: item.recordId,
      scopeType: item.scopeType,
      scopeId: item.scopeId,
      sourceRef: item.sourceRef,
      contentHash: item.contentHash,
      classification: item.classification,
      evidence: item.evidence || null,
      checkedEvidenceRoots,
      status: "quarantined",
      checkedAt: plan.generatedAt,
    }));
  const body = rows.map(row => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  const suffix = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const tmpPath = `${resolvedOutput}.${suffix}.tmp`;
  let backupPath = null;
  fs.writeFileSync(tmpPath, body, { encoding: "utf8", flag: "wx" });
  try {
    if (fs.existsSync(resolvedOutput)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      backupPath = `${resolvedOutput}.backup-${stamp}-${suffix}`;
      fs.renameSync(resolvedOutput, backupPath);
    }
    fs.renameSync(tmpPath, resolvedOutput);
  } catch (error) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    if (backupPath && fs.existsSync(backupPath) && !fs.existsSync(resolvedOutput)) {
      fs.renameSync(backupPath, resolvedOutput);
    }
    throw error;
  }
  return {
    outputPath: resolvedOutput,
    backupPath,
    records: rows.length,
    byClass: rows.reduce((counts, row) => {
      counts[row.classification] = (counts[row.classification] || 0) + 1;
      return counts;
    }, {}),
  };
}
function parseArgs(argv) {
  const args = { root: null, peerRoots: [], evidenceRoots: [], output: null, quarantine: null, apply: false, limit: Infinity, recordIds: [] };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg.startsWith("--peer=")) args.peerRoots.push(arg.slice(7));
    else if (arg.startsWith("--evidence=")) args.evidenceRoots.push(arg.slice(11));
    else if (arg.startsWith("--output=")) args.output = arg.slice(9);
    else if (arg.startsWith("--quarantine=")) args.quarantine = arg.slice(13);
    else if (arg.startsWith("--limit=")) args.limit = Number(arg.slice(8));
    else if (arg.startsWith("--record-id=")) args.recordIds.push(...arg.slice(12).split(",").filter(Boolean));
    else if (!arg.startsWith("--") && !args.root) args.root = arg;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root) throw new Error("사용법: node forensic-raw-recovery.js <brainRoot> [--peer=<root>] [--evidence=<root>] [--output=<json>] [--quarantine=<jsonl>] [--apply --record-id=<id,...>] [--limit=N]");
  const result = args.apply
    ? await applyRawRecovery(args.root, args)
    : await planRecovery(args.root, args);
  if (args.output) {
    const outputPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  }
  const quarantine = !args.apply && args.quarantine ? writeQuarantineCatalog(result, args.quarantine) : null;
  const output = args.apply ? result : { generatedAt: result.generatedAt, brainRoot: result.brainRoot, peerRoots: result.peerRoots, evidenceRoots: result.evidenceRoots, evidenceScan: result.evidenceScan, totals: result.totals, byClass: result.byClass, byEvidence: result.byEvidence, topScopes: Object.entries(result.byScope).sort((a,b) => b[1]-a[1]).slice(0,20), quarantine };
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

if (require.main === module) main().catch(error => { console.error(error); process.exit(1); });

module.exports = { planRecovery, applyRawRecovery, scanEvidenceRoots, writeQuarantineCatalog, resolveInside, hashBuffer };
