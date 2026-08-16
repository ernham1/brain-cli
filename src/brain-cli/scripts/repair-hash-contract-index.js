"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { acquireLock } = require("../src/lock");
const { writeFilePreservingPrevious } = require("../src/integrity-monitor");
const { validate } = require("../src/validate");
const { calculateHash, readJsonl, safeReadJson, writeJsonl } = require("../src/utils");

const CANONICAL_FILES = ["records.jsonl", "records_digest.txt", "manifest.json", "records.db"];

function normalizeRef(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").normalize("NFC");
}

function resolveInside(root, sourceRef) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalizeRef(sourceRef));
  return resolved !== resolvedRoot && resolved.startsWith(resolvedRoot + path.sep) ? resolved : null;
}

function readDbHashMap(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return new Map(db.prepare("SELECT record_id, content_hash FROM records").all()
      .map(row => [row.record_id, row.content_hash]));
  } finally {
    db.close();
  }
}

function readManifestHashMap(manifestPath) {
  const result = safeReadJson(manifestPath);
  if (!result.ok || !Array.isArray(result.data.files)) throw new Error("manifest.json 읽기 실패");
  return new Map(result.data.files
    .filter(entry => entry && entry.path)
    .map(entry => [normalizeRef(entry.path), entry.hash || entry.contentHash || null]));
}

function planExactJsonlHashRepair(brainRoot) {
  const root = path.resolve(brainRoot);
  const indexDir = path.join(root, "90_index");
  const records = readJsonl(path.join(indexDir, "records.jsonl"));
  const dbHashes = readDbHashMap(path.join(indexDir, "records.db"));
  const manifestHashes = readManifestHashMap(path.join(indexDir, "manifest.json"));
  const eligible = [];
  const blocked = [];

  for (const record of records) {
    const dbHash = dbHashes.get(record.recordId) || null;
    if (!dbHash || record.contentHash === dbHash) continue;
    const sourceRef = normalizeRef(record.sourceRef);
    const sourcePath = sourceRef ? resolveInside(root, sourceRef) : null;
    const rawHash = sourcePath && fs.existsSync(sourcePath) ? calculateHash(sourcePath) : null;
    const manifestHash = manifestHashes.get(sourceRef) || null;
    const item = {
      recordId: record.recordId,
      sourceRef,
      jsonHash: record.contentHash || null,
      dbHash,
      rawHash,
      manifestHash,
    };
    if (rawHash === dbHash && manifestHash === dbHash) eligible.push(item);
    else blocked.push(item);
  }

  return { brainRoot: root, eligible, blocked };
}

function copyCanonicalBackup(indexDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(indexDir, `_backup-hash-contract-index-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: false });
  for (const name of CANONICAL_FILES) {
    const source = path.join(indexDir, name);
    if (!fs.existsSync(source)) throw new Error(`백업 대상 없음: ${source}`);
    fs.copyFileSync(source, path.join(backupDir, name));
  }
  return backupDir;
}

function applyExactJsonlHashRepair(brainRoot) {
  const root = path.resolve(brainRoot);
  const indexDir = path.join(root, "90_index");
  const recordsPath = path.join(indexDir, "records.jsonl");
  const tmpPaths = ["records.jsonl", "records_digest.txt", "manifest.json"]
    .map(name => path.join(indexDir, `${name}.tmp`));
  const lock = acquireLock(root, { timeoutMs: 5 * 60 * 1000, staleMs: 30000 });
  let backupDir = null;
  let adjacentBackupPath = null;
  try {
    const plan = planExactJsonlHashRepair(root);
    if (plan.eligible.length === 0) return { ...plan, changed: 0, backupDir: null, adjacentBackupPath: null };

    backupDir = copyCanonicalBackup(indexDir);
    const replacements = new Map(plan.eligible.map(item => [item.recordId, item.dbHash]));
    const records = readJsonl(recordsPath);
    const updatedRecords = records.map(record => replacements.has(record.recordId)
      ? { ...record, contentHash: replacements.get(record.recordId) }
      : record);

    writeJsonl(tmpPaths[0], updatedRecords);
    fs.copyFileSync(path.join(indexDir, "records_digest.txt"), tmpPaths[1]);
    fs.copyFileSync(path.join(indexDir, "manifest.json"), tmpPaths[2]);
    const tmpValidation = validate(root, { tmpMode: true });
    if (!tmpValidation.passed) throw new Error(`정정 tmp 검증 실패: ${tmpValidation.errors.join("; ")}`);

    const body = fs.readFileSync(tmpPaths[0], "utf8");
    const written = writeFilePreservingPrevious(recordsPath, body);
    adjacentBackupPath = written.backupPath;
    const validation = validate(root);
    if (!validation.passed) throw new Error(`정정 후 검증 실패: ${validation.errors.join("; ")}`);
    const remaining = planExactJsonlHashRepair(root).eligible;
    if (remaining.length > 0) throw new Error(`정정 후 잔류: ${remaining.length}건`);

    return {
      brainRoot: root,
      changed: plan.eligible.length,
      changedRecordIds: plan.eligible.map(item => item.recordId),
      blocked: plan.blocked,
      backupDir,
      adjacentBackupPath,
    };
  } catch (error) {
    if (backupDir && fs.existsSync(path.join(backupDir, "records.jsonl"))) {
      fs.copyFileSync(path.join(backupDir, "records.jsonl"), recordsPath);
    }
    throw error;
  } finally {
    for (const tmpPath of tmpPaths) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    }
    lock.release();
  }
}

function main() {
  const brainRoot = process.argv[2];
  if (!brainRoot) throw new Error("사용법: node repair-hash-contract-index.js <brainRoot> [--apply]");
  const result = process.argv.includes("--apply")
    ? applyExactJsonlHashRepair(brainRoot)
    : planExactJsonlHashRepair(brainRoot);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (require.main === module) main();

module.exports = { applyExactJsonlHashRepair, planExactJsonlHashRepair };
