"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { applyReconstruction } = require("./reconstruct-session-handoff-raw");
const { applyRepair } = require("./repair-canonical-index-from-db");
const { runIntegrityMonitor, publicMonitorResult } = require("../src/integrity-monitor");

function parseArgs(argv) {
  const result = { root: null, transcripts: null, manifest: null, batchId: null, outputDir: null };
  for (const arg of argv) {
    if (arg.startsWith("--root=")) result.root = arg.slice(7);
    else if (arg.startsWith("--transcripts=")) result.transcripts = arg.slice(14);
    else if (arg.startsWith("--manifest=")) result.manifest = arg.slice(11);
    else if (arg.startsWith("--batch=")) result.batchId = arg.slice(8);
    else if (arg.startsWith("--output-dir=")) result.outputDir = arg.slice(13);
  }
  return result;
}

function writeReport(directory, name, value) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2) + "\n", "utf8");
}

function hashFile(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function auditTargets(brainRoot, recordIds) {
  const indexDir = path.join(brainRoot, "90_index");
  const records = fs.readFileSync(path.join(indexDir, "records.jsonl"), "utf8")
    .trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const digest = fs.readFileSync(path.join(indexDir, "records_digest.txt"), "utf8").split(/\r?\n/);
  const manifest = JSON.parse(fs.readFileSync(path.join(indexDir, "manifest.json"), "utf8"));
  const db = new Database(path.join(indexDir, "records.db"), { readonly: true, fileMustExist: true });
  const select = db.prepare("SELECT record_id, source_ref, content_hash FROM records WHERE record_id = ?");
  try {
    const items = recordIds.map(recordId => {
      const row = select.get(recordId);
      if (!row) return { recordId, allExact: false, reason: "db-missing" };
      const sourceRef = String(row.source_ref).replace(/\\/g, "/");
      const rawPath = path.resolve(brainRoot, sourceRef);
      const rawHash = fs.existsSync(rawPath) ? hashFile(rawPath) : null;
      const jsonlCount = records.filter(record => record.recordId === recordId).length;
      const digestCount = digest.filter(line => line.startsWith(`${recordId} | `)).length;
      const manifestRows = manifest.files.filter(entry => String(entry.path).replace(/\\/g, "/") === sourceRef);
      const manifestHash = manifestRows.length === 1 ? manifestRows[0].hash : null;
      return {
        recordId,
        sourceRef,
        dbCount: 1,
        jsonlCount,
        digestCount,
        manifestCount: manifestRows.length,
        expectedHash: row.content_hash,
        rawHash,
        manifestHash,
        allExact: jsonlCount === 1 && digestCount === 1 && manifestRows.length === 1
          && rawHash === row.content_hash && manifestHash === row.content_hash
      };
    });
    return { count: items.length, allExact: items.every(item => item.allExact), items };
  } finally {
    db.close();
  }
}

function rollbackCreatedRaw(brainRoot, created) {
  const root = path.resolve(brainRoot);
  for (const item of created) {
    const target = path.resolve(root, item.sourceRef);
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) continue;
    if (hashFile(target) !== item.contentHash) continue;
    fs.unlinkSync(target);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root || !args.transcripts || !args.manifest || !args.batchId || !args.outputDir) {
    throw new Error("사용법: node run-session-handoff-recovery-batch.js --root=<brain> --transcripts=<root> --manifest=<json> --batch=<B01> --output-dir=<dir>");
  }
  const brainRoot = path.resolve(args.root);
  const manifest = JSON.parse(fs.readFileSync(path.resolve(args.manifest), "utf8"));
  const batch = manifest.batches.find(item => item.batchId === args.batchId);
  if (!batch || !Array.isArray(batch.recordIds) || batch.recordIds.length === 0 || batch.recordIds.length > 10) {
    throw new Error(`유효한 1~10건 batch가 아닙니다: ${args.batchId}`);
  }
  const outputDir = path.resolve(args.outputDir, batch.batchId);
  const preState = batch.items.map(item => ({
    recordId: item.recordId,
    sourceRef: item.sourceRef,
    exists: fs.existsSync(path.resolve(brainRoot, item.sourceRef)),
    expectedHash: item.contentHash
  }));
  const existingCount = preState.filter(item => item.exists).length;
  if (existingCount > 0 && existingCount < batch.recordIds.length) {
    throw new Error(`${batch.batchId} 대상 Raw가 일부만 존재합니다: ${existingCount}/${batch.recordIds.length}`);
  }
  writeReport(outputDir, "pre-state.json", { batchId: batch.batchId, items: preState });

  if (existingCount === batch.recordIds.length) {
    const targetAudit = auditTargets(brainRoot, batch.recordIds);
    writeReport(outputDir, "target-audit.json", { batchId: batch.batchId, ...targetAudit });
    if (!targetAudit.allExact) throw new Error(`${batch.batchId} 기존 대상 5중 감사 실패`);
    const monitor = publicMonitorResult(runIntegrityMonitor(brainRoot, { recordEvent: true }));
    writeReport(outputDir, "monitor.json", monitor);
    if (monitor.status !== "healthy" || monitor.newIssueCount !== 0) {
      throw new Error(`${batch.batchId} monitor 실패: status=${monitor.status}, new=${monitor.newIssueCount}`);
    }
    const result = {
      batchId: batch.batchId,
      resumed: true,
      created: batch.recordIds.length,
      recovered: batch.recordIds.length,
      allExact: true,
      monitor: {
        totalIssues: monitor.totals.issues,
        knownIssues: monitor.knownIssueCount,
        newIssues: monitor.newIssueCount
      }
    };
    writeReport(outputDir, "result.json", result);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  const raw = applyReconstruction(brainRoot, args.transcripts, { recordIds: batch.recordIds });
  writeReport(outputDir, "raw-apply.json", raw);
  if (raw.created.length !== batch.recordIds.length || raw.skipped.length !== 0) {
    rollbackCreatedRaw(brainRoot, raw.created);
    throw new Error(`${batch.batchId} Raw 부분 생성으로 원복: created=${raw.created.length}, skipped=${raw.skipped.length}`);
  }

  let canonical;
  try {
    canonical = applyRepair(brainRoot, { recordIds: batch.recordIds });
  } catch (error) {
    rollbackCreatedRaw(brainRoot, raw.created);
    throw error;
  }
  writeReport(outputDir, "canonical-apply.json", canonical);
  if (canonical.recovered !== batch.recordIds.length) {
    throw new Error(`${batch.batchId} canonical 수 불일치: ${canonical.recovered}`);
  }

  const targetAudit = auditTargets(brainRoot, batch.recordIds);
  writeReport(outputDir, "target-audit.json", { batchId: batch.batchId, ...targetAudit });
  if (!targetAudit.allExact) throw new Error(`${batch.batchId} 5중 감사 실패`);

  const monitor = publicMonitorResult(runIntegrityMonitor(brainRoot, { recordEvent: true }));
  writeReport(outputDir, "monitor.json", monitor);
  if (monitor.status !== "healthy" || monitor.newIssueCount !== 0) {
    throw new Error(`${batch.batchId} monitor 실패: status=${monitor.status}, new=${monitor.newIssueCount}`);
  }

  const result = {
    batchId: batch.batchId,
    created: raw.created.length,
    recovered: canonical.recovered,
    backupDir: canonical.backupDir,
    allExact: targetAudit.allExact,
    monitor: {
      totalIssues: monitor.totals.issues,
      knownIssues: monitor.knownIssueCount,
      newIssues: monitor.newIssueCount
    }
  };
  writeReport(outputDir, "result.json", result);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error); process.exit(1); }
}

module.exports = { auditTargets, parseArgs, rollbackCreatedRaw };
