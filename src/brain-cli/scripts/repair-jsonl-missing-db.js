"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { getDb, insertRecord } = require("../src/db");
const { acquireLock } = require("../src/lock");
const { calculateHash, readJsonl } = require("../src/utils");

function normalizeRef(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").normalize("NFC");
}

function resolveInside(root, sourceRef) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalizeRef(sourceRef));
  return resolved.startsWith(resolvedRoot + path.sep) ? resolved : null;
}

function recordsPath(brainRoot) {
  return path.join(brainRoot, "90_index", "records.jsonl");
}

function databasePath(brainRoot) {
  return path.join(brainRoot, "90_index", "records.db");
}

function planRepair(brainRoot, options = {}) {
  const root = path.resolve(brainRoot);
  const requestedRecordId = options.recordId || null;
  const records = readJsonl(recordsPath(root)).filter(record => !requestedRecordId || record.recordId === requestedRecordId);
  const db = new Database(databasePath(root), { readonly: true, fileMustExist: true });
  const exists = db.prepare("SELECT 1 FROM records WHERE record_id = ?");
  const candidates = [];
  const skipped = [];
  try {
    for (const record of records) {
      if (!record.recordId || !record.sourceRef || !record.contentHash) {
        skipped.push({ recordId: record.recordId || null, reason: "metadata-incomplete" });
        continue;
      }
      if (exists.get(record.recordId)) {
        skipped.push({ recordId: record.recordId, reason: "already-in-db" });
        continue;
      }
      const rawPath = resolveInside(root, record.sourceRef);
      if (!rawPath || !fs.existsSync(rawPath) || !fs.statSync(rawPath).isFile()) {
        skipped.push({ recordId: record.recordId, reason: rawPath ? "raw-missing" : "unsafe-source-ref" });
        continue;
      }
      const actualHash = calculateHash(rawPath);
      if (actualHash !== record.contentHash) {
        skipped.push({ recordId: record.recordId, reason: "content-hash-mismatch", expected: record.contentHash, actual: actualHash });
        continue;
      }
      candidates.push({ record, rawPath, actualHash });
    }
  } finally {
    db.close();
  }
  return {
    brainRoot: root,
    requestedRecordId,
    examined: records.length,
    candidates: candidates.map(item => ({ recordId: item.record.recordId, sourceRef: item.record.sourceRef, contentHash: item.actualHash })),
    skipped
  };
}

function backupDatabase(brainRoot) {
  const indexDir = path.join(brainRoot, "90_index");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(indexDir, `_backup-jsonl-missing-db-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: false });
  const copied = [];
  for (const name of ["records.db", "records.db-wal", "records.db-shm"]) {
    const source = path.join(indexDir, name);
    if (!fs.existsSync(source)) continue;
    fs.copyFileSync(source, path.join(backupDir, name), fs.constants.COPYFILE_EXCL);
    copied.push(name);
  }
  if (!copied.includes("records.db")) throw new Error("records.db backup failed");
  return { backupDir, copied };
}

function applyRepair(brainRoot, options = {}) {
  if (!options.recordId) throw new Error("운영 적용은 --record=<recordId>를 명시해야 합니다.");
  const root = path.resolve(brainRoot);
  const lock = acquireLock(root, { staleMs: 30000, timeoutMs: 30000 });
  try {
    const plan = planRepair(root, { recordId: options.recordId });
    if (plan.candidates.length === 0) {
      return { applied: false, inserted: 0, backupDir: null, plan };
    }
    if (plan.candidates.length !== 1) throw new Error(`단건 복구 대상 수가 1이 아닙니다: ${plan.candidates.length}`);
    const backup = backupDatabase(root);
    const candidate = plan.candidates[0];
    const record = readJsonl(recordsPath(root)).find(item => item.recordId === candidate.recordId);
    const db = getDb(root);
    try {
      insertRecord(db, record);
      const row = db.prepare("SELECT record_id, content_hash FROM records WHERE record_id = ?").get(record.recordId);
      const fts = db.prepare("SELECT COUNT(*) AS count FROM records_fts WHERE record_id = ?").get(record.recordId);
      if (!row || row.content_hash !== record.contentHash || fts.count !== 1) throw new Error("DB/FTS post-insert verification failed");
    } finally {
      db.close();
    }
    return { applied: true, inserted: 1, recordId: record.recordId, backupDir: backup.backupDir, backupFiles: backup.copied };
  } finally {
    lock.release();
  }
}

function parseArgs(argv) {
  const result = { root: null, recordId: null, apply: false };
  for (const arg of argv) {
    if (arg === "--apply") result.apply = true;
    else if (arg.startsWith("--record=")) result.recordId = arg.slice(9);
    else if (!arg.startsWith("--") && !result.root) result.root = arg;
  }
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root) throw new Error("사용법: node repair-jsonl-missing-db.js <brainRoot> [--record=<id>] [--apply]");
  const result = args.apply ? applyRepair(args.root, args) : planRepair(args.root, args);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error); process.exit(1); }
}

module.exports = { planRepair, applyRepair, resolveInside };
