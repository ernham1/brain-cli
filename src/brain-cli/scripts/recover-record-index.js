"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { BWTEngine } = require("../src/bwt");

function normalizeRef(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").normalize("NFC");
}

function refKey(value) {
  return normalizeRef(value).toLowerCase();
}

function fileHash(content) {
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

function loadDbState(brainRoot) {
  const db = new Database(path.join(brainRoot, "90_index", "records.db"), { readonly: true, fileMustExist: true });
  const rows = db.prepare("SELECT record_id, source_ref, content_hash, status FROM records").all();
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
  const text = content.toString("utf-8");
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const heading = lines.find(line => /^#\s+/.test(line));
  const fallback = path.posix.basename(candidate.sourceRef, path.posix.extname(candidate.sourceRef));
  const title = (heading ? heading.replace(/^#\s+/, "") : fallback).slice(0, 200);
  const summaryText = lines
    .filter(line => line && !/^```/.test(line) && !/^#+\s*$/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 300);
  const isDecision = normalizeRef(candidate.sourceRef).includes("/decisions/");
  return {
    scopeType: candidate.scopeType,
    scopeId: candidate.scopeId,
    type: isDecision ? "decision" : "log",
    title,
    summary: summaryText || title,
    tags: ["domain/dev", "intent/retrieval"],
    sourceType: isDecision ? "user_confirmed" : "candidate",
  };
}

function writeProgress(outputPath, report) {
  if (!outputPath) return;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
}

function main() {
  const reportPath = process.argv[2];
  const apply = process.argv.includes("--apply");
  const rootArg = process.argv.find(arg => arg.startsWith("--root="));
  const outputArg = process.argv.find(arg => arg.startsWith("--output="));
  const limitArg = process.argv.find(arg => arg.startsWith("--limit="));
  if (!reportPath || !rootArg) {
    throw new Error("사용법: node scripts/recover-record-index.js <audit.json> --root=<brainRoot> [--apply] [--limit=N] [--output=file]");
  }

  const brainRoot = path.resolve(rootArg.slice("--root=".length));
  const outputPath = outputArg ? path.resolve(outputArg.slice("--output=".length)) : null;
  const limit = limitArg ? Number.parseInt(limitArg.slice("--limit=".length), 10) : Infinity;
  const audit = JSON.parse(fs.readFileSync(path.resolve(reportPath), "utf-8"));
  const rootReport = audit.roots.find(item => path.resolve(item.brainRoot).toLowerCase() === brainRoot.toLowerCase());
  if (!rootReport) throw new Error(`감사 보고서에 Brain root가 없습니다: ${brainRoot}`);

  const candidates = rootReport.missingCandidates
    .filter(item => item.postRotationSource)
    .filter(item => !item.protectedAreswar && String(item.scopeId || "").toLowerCase() !== "areswar")
    .filter(item => !item.contentIndexedBy || item.contentIndexedBy.length === 0)
    .slice(0, limit);
  const dbState = loadDbState(brainRoot);
  const recovery = {
    brainRoot,
    auditReport: path.resolve(reportPath),
    startedAt: new Date().toISOString(),
    apply,
    planned: candidates.length,
    created: [],
    skipped: [],
    failed: [],
  };

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const originalPath = path.join(brainRoot, candidate.sourceRef);
    if (!fs.existsSync(originalPath)) {
      recovery.skipped.push({ sourceRef: candidate.sourceRef, reason: "source_missing" });
      continue;
    }
    const content = fs.readFileSync(originalPath);
    const contentHash = fileHash(content);
    if (dbState.activeHashes.has(contentHash)) {
      recovery.skipped.push({ sourceRef: candidate.sourceRef, reason: "content_already_indexed" });
      continue;
    }

    const newSourceRef = versionedSourceRef(brainRoot, candidate.sourceRef, dbState.sourceRefs);
    const intent = {
      action: "create",
      sourceRef: newSourceRef,
      scopeType: candidate.scopeType,
      scopeId: candidate.scopeId,
      content: content.toString("utf-8"),
      record: metadataFromSource(candidate, content),
    };
    if (!apply) {
      recovery.created.push({ sourceRef: candidate.sourceRef, newSourceRef, dryRun: true });
      continue;
    }

    const result = new BWTEngine(brainRoot).execute(intent);
    if (!result.success) {
      const failure = { sourceRef: candidate.sourceRef, newSourceRef, report: result.report };
      recovery.failed.push(failure);
      recovery.finishedAt = new Date().toISOString();
      writeProgress(outputPath, recovery);
      throw new Error(`복구 실패: ${candidate.sourceRef}: ${result.report.message}`);
    }
    recovery.created.push({ sourceRef: candidate.sourceRef, newSourceRef, recordId: result.recordId });
    dbState.sourceRefs.add(refKey(newSourceRef));
    dbState.activeHashes.add(contentHash);
    if ((index + 1) % 25 === 0 || index + 1 === candidates.length) {
      recovery.finishedAt = new Date().toISOString();
      writeProgress(outputPath, recovery);
      process.stdout.write(`복구 진행 ${index + 1}/${candidates.length}, 생성 ${recovery.created.length}, 건너뜀 ${recovery.skipped.length}\n`);
    }
  }

  recovery.finishedAt = new Date().toISOString();
  writeProgress(outputPath, recovery);
  process.stdout.write(JSON.stringify({
    apply,
    planned: recovery.planned,
    created: recovery.created.length,
    skipped: recovery.skipped.length,
    failed: recovery.failed.length,
    outputPath,
  }, null, 2) + "\n");
}

if (require.main === module) main();