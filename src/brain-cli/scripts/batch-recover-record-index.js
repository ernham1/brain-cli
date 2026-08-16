"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { acquireLock } = require("../src/lock");
const { getWriteDb, getNextRecordId, recordExists, insertRecords } = require("../src/db");
const { validate } = require("../src/validate");
const {
  calculateHashFromString,
  generateDigestLine,
  isoNow,
  readJsonl,
  safeReadJson,
  writeJsonl,
  ensureDir,
} = require("../src/utils");

function normalizeRef(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").normalize("NFC");
}

function refKey(value) {
  return normalizeRef(value).toLowerCase();
}

function hashContent(content) {
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

function loadDbState(brainRoot) {
  const db = new Database(path.join(brainRoot, "90_index", "records.db"), { readonly: true, fileMustExist: true });
  const rows = db.prepare("SELECT source_ref, content_hash, status FROM records").all();
  db.close();
  return {
    sourceRefs: new Set(rows.map(row => refKey(row.source_ref)).filter(Boolean)),
    activeHashes: new Set(rows.filter(row => row.status === "active" && row.content_hash).map(row => row.content_hash)),
  };
}

function versionedSourceRef(brainRoot, sourceRef, knownSourceRefs) {
  const normalized = normalizeRef(sourceRef);
  const extension = path.posix.extname(normalized);
  const stem = normalized.slice(0, normalized.length - extension.length);
  for (let version = 2; version < 100; version++) {
    const candidate = `${stem}-v${version}${extension}`;
    if (!knownSourceRefs.has(refKey(candidate)) && !fs.existsSync(path.join(brainRoot, candidate))) return candidate;
  }
  throw new Error(`복구 sourceRef 버전을 결정할 수 없습니다: ${sourceRef}`);
}

function metadataFromSource(candidate, content) {
  const lines = content.split(/\r?\n/).map(line => line.trim());
  const heading = lines.find(line => /^#\s+/.test(line));
  const fallback = path.posix.basename(candidate.sourceRef, path.posix.extname(candidate.sourceRef));
  const title = (heading ? heading.replace(/^#\s+/, "") : fallback).slice(0, 200);
  const summary = lines
    .filter(line => line && !/^```/.test(line) && !/^#+\s*$/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 300) || title;
  const isDecision = normalizeRef(candidate.sourceRef).includes("/decisions/");
  return {
    scopeType: candidate.scopeType,
    scopeId: candidate.scopeId,
    type: isDecision ? "decision" : "log",
    title,
    summary,
    tags: ["domain/dev", "intent/retrieval"],
    sourceType: isDecision ? "user_confirmed" : "candidate",
  };
}

function incrementRecordId(recordId) {
  const match = recordId.match(/^(.*_)(\d+)$/);
  if (!match) throw new Error(`recordId 순번 해석 실패: ${recordId}`);
  return `${match[1]}${String(Number.parseInt(match[2], 10) + 1).padStart(match[2].length, "0")}`;
}

function categoryFor(sourceRef) {
  if (sourceRef.startsWith("00_user/")) return "user";
  if (sourceRef.startsWith("10_projects/")) return "project";
  if (sourceRef.startsWith("30_topics/")) return "topic";
  return "other";
}

function manifestSummary(files) {
  const byCategory = { policy: 0, user: 0, project: 0, agent: 0, topic: 0, wiki: 0, index: 0 };
  for (const file of files) {
    if (byCategory[file.category] !== undefined) byCategory[file.category]++;
  }
  return { totalFiles: files.length, byCategory };
}

function restoreCommitted(committed, backups) {
  for (const { original } of [...committed].reverse()) {
    const backup = backups.find(item => item.original === original);
    try {
      if (backup && fs.existsSync(backup.bak)) fs.copyFileSync(backup.bak, original);
      else if (fs.existsSync(original)) fs.unlinkSync(original);
    } catch { /* final rollback below retries backups */ }
  }
}

function createChunk(brainRoot, items) {
  const indexDir = path.join(brainRoot, "90_index");
  const lock = acquireLock(brainRoot, { staleMs: 30000, timeoutMs: 30000 });
  const tmpFiles = [];
  const backups = [];
  const committed = [];
  let db;
  try {
    const residual = fs.readdirSync(indexDir).filter(name => name.endsWith(".tmp"));
    if (residual.length > 0) throw new Error(`배치 시작 전 잔류 tmp: ${residual.join(", ")}`);

    const indexPaths = ["records.jsonl", "manifest.json", "records_digest.txt"].map(name => path.join(indexDir, name));
    for (const original of indexPaths) {
      const bak = `${original}.batch-recovery.bak`;
      fs.copyFileSync(original, bak);
      backups.push({ original, bak });
    }

    db = getWriteDb(brainRoot);
    const recordsPath = path.join(indexDir, "records.jsonl");
    const records = readJsonl(recordsPath);
    const existingIds = new Set(records.map(record => record.recordId));
    const nextIds = new Map();
    const now = isoNow();
    const newRecords = [];

    for (const item of items) {
      const dbNextRecordId = getNextRecordId(db, item.record.scopeType, item.record.scopeId);
      const sequenceKey = dbNextRecordId.slice(0, -4);
      const recordId = nextIds.get(sequenceKey) || dbNextRecordId;
      nextIds.set(sequenceKey, incrementRecordId(recordId));
      if (recordExists(db, recordId) || existingIds.has(recordId)) {
        throw new Error(`recordId 충돌: ${recordId} — 배치를 중단합니다.`);
      }
      existingIds.add(recordId);
      newRecords.push({
        recordId,
        scopeType: item.record.scopeType,
        scopeId: item.record.scopeId,
        type: item.record.type,
        title: item.record.title,
        summary: item.record.summary,
        tags: item.record.tags,
        sourceType: item.record.sourceType,
        sourceRef: item.newSourceRef,
        status: "active",
        replacedBy: null,
        deprecationReason: null,
        updatedAt: now,
        contentHash: calculateHashFromString(item.content),
      });
    }

    for (const item of items) {
      const original = path.join(brainRoot, item.newSourceRef);
      if (fs.existsSync(original)) throw new Error(`복구 대상 파일이 이미 존재합니다: ${item.newSourceRef}`);
      ensureDir(path.dirname(original));
      const tmp = `${original}.tmp`;
      fs.writeFileSync(tmp, item.content, "utf-8");
      tmpFiles.push(tmp);
    }

    const recordsTmp = `${recordsPath}.tmp`;
    writeJsonl(recordsTmp, records.concat(newRecords));
    tmpFiles.push(recordsTmp);

    const manifestPath = path.join(indexDir, "manifest.json");
    const manifestResult = safeReadJson(manifestPath);
    if (!manifestResult.ok) throw new Error(`manifest 읽기 실패: ${manifestResult.error}`);
    const manifest = manifestResult.data;
    const manifestPaths = new Set((manifest.files || []).map(file => refKey(file.path)));
    if (!Array.isArray(manifest.files)) manifest.files = [];
    for (const item of items) {
      if (manifestPaths.has(refKey(item.newSourceRef))) throw new Error(`manifest 경로 충돌: ${item.newSourceRef}`);
      manifestPaths.add(refKey(item.newSourceRef));
      manifest.files.push({
        path: item.newSourceRef,
        hash: calculateHashFromString(item.content),
        size: Buffer.byteLength(item.content, "utf-8"),
        updatedAt: now,
        category: categoryFor(item.newSourceRef),
      });
    }
    manifest.updatedAt = now;
    manifest.summary = manifestSummary(manifest.files);
    const manifestTmp = `${manifestPath}.tmp`;
    fs.writeFileSync(manifestTmp, JSON.stringify(manifest, null, 2), "utf-8");
    tmpFiles.push(manifestTmp);

    const digestPath = path.join(indexDir, "records_digest.txt");
    const digestTmp = `${digestPath}.tmp`;
    const allRecords = records.concat(newRecords);
    const header = "# Brain records_digest.txt\n# Format: recordId | title | summary | tags | status | type | sourceType | updatedAt\n# Auto-generated by brain-cli BWT. Do not edit manually.\n";
    fs.writeFileSync(digestTmp, header + allRecords.map(generateDigestLine).join("\n") + "\n", "utf-8");
    tmpFiles.push(digestTmp);

    const validation = validate(brainRoot, { tmpMode: true });
    if (!validation.passed) throw new Error(`배치 validate 실패: ${validation.errors.join("; ")}`);

    for (const tmp of tmpFiles) {
      const original = tmp.replace(/\.tmp$/, "");
      fs.renameSync(tmp, original);
      committed.push({ tmp, original });
    }
    try {
      insertRecords(db, newRecords);
    } catch (error) {
      restoreCommitted(committed, backups);
      throw error;
    }

    for (const { bak } of backups) fs.unlinkSync(bak);
    return newRecords.map((record, index) => ({
      sourceRef: items[index].sourceRef,
      newSourceRef: record.sourceRef,
      recordId: record.recordId,
    }));
  } catch (error) {
    restoreCommitted(committed, backups);
    for (const tmp of tmpFiles) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best effort */ }
    }
    for (const { original, bak } of backups) {
      try {
        if (fs.existsSync(bak)) {
          fs.copyFileSync(bak, original);
          fs.unlinkSync(bak);
        }
      } catch { /* best effort */ }
    }
    throw error;
  } finally {
    if (db) db.close();
    lock.release();
  }
}

function writeReport(outputPath, report) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
}

function main() {
  const auditPath = path.resolve(process.argv[2] || "");
  const rootArg = process.argv.find(arg => arg.startsWith("--root="));
  const outputArg = process.argv.find(arg => arg.startsWith("--output="));
  const chunkArg = process.argv.find(arg => arg.startsWith("--chunk="));
  const limitArg = process.argv.find(arg => arg.startsWith("--limit="));
  if (!auditPath || !rootArg || !outputArg) {
    throw new Error("사용법: node scripts/batch-recover-record-index.js <audit.json> --root=<brainRoot> --output=<report.json> [--chunk=100] [--limit=N]");
  }
  const brainRoot = path.resolve(rootArg.slice("--root=".length));
  const outputPath = path.resolve(outputArg.slice("--output=".length));
  const chunkSize = chunkArg ? Number.parseInt(chunkArg.slice("--chunk=".length), 10) : 100;
  const limit = limitArg ? Number.parseInt(limitArg.slice("--limit=".length), 10) : Infinity;
  const audit = JSON.parse(fs.readFileSync(auditPath, "utf-8"));
  const rootReport = audit.roots.find(item => path.resolve(item.brainRoot).toLowerCase() === brainRoot.toLowerCase());
  if (!rootReport) throw new Error(`감사 보고서에 Brain root가 없습니다: ${brainRoot}`);

  const dbState = loadDbState(brainRoot);
  const candidates = rootReport.missingCandidates
    .filter(item => item.postRotationSource)
    .filter(item => !item.protectedAreswar && String(item.scopeId || "").toLowerCase() !== "areswar")
    .filter(item => !item.contentIndexedBy || item.contentIndexedBy.length === 0)
    .slice(0, limit);
  const report = {
    brainRoot,
    auditPath,
    startedAt: new Date().toISOString(),
    planned: candidates.length,
    created: [],
    skipped: [],
    failed: [],
  };
  const prepared = [];
  for (const candidate of candidates) {
    const originalPath = path.join(brainRoot, candidate.sourceRef);
    if (!fs.existsSync(originalPath)) {
      report.skipped.push({ sourceRef: candidate.sourceRef, reason: "source_missing" });
      continue;
    }
    const content = fs.readFileSync(originalPath, "utf-8");
    const contentHash = hashContent(content);
    if (dbState.activeHashes.has(contentHash)) {
      report.skipped.push({ sourceRef: candidate.sourceRef, reason: "content_already_indexed" });
      continue;
    }
    const newSourceRef = versionedSourceRef(brainRoot, candidate.sourceRef, dbState.sourceRefs);
    dbState.sourceRefs.add(refKey(newSourceRef));
    dbState.activeHashes.add(contentHash);
    prepared.push({
      sourceRef: candidate.sourceRef,
      newSourceRef,
      content,
      record: metadataFromSource(candidate, content),
    });
  }

  for (let offset = 0; offset < prepared.length; offset += chunkSize) {
    const chunk = prepared.slice(offset, offset + chunkSize);
    try {
      report.created.push(...createChunk(brainRoot, chunk));
    } catch (error) {
      report.failed.push({ offset, size: chunk.length, message: error.message });
      report.finishedAt = new Date().toISOString();
      writeReport(outputPath, report);
      throw error;
    }
    report.finishedAt = new Date().toISOString();
    writeReport(outputPath, report);
    process.stdout.write(`배치 복구 ${Math.min(offset + chunk.length, prepared.length)}/${prepared.length}, 생성 ${report.created.length}, 건너뜀 ${report.skipped.length}\n`);
  }

  report.finishedAt = new Date().toISOString();
  writeReport(outputPath, report);
  process.stdout.write(JSON.stringify({
    planned: report.planned,
    created: report.created.length,
    skipped: report.skipped.length,
    failed: report.failed.length,
    outputPath,
  }, null, 2) + "\n");
}

if (require.main === module) main();

module.exports = { createChunk };