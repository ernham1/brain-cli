"use strict";

const fs = require("fs");
const path = require("path");
const { classifyMissingRaw } = require("./classify-missing-raw");
const { auditIntegrity } = require("../src/integrity-monitor");

function evidenceDisposition(item) {
  if (item.sourceFamily === "work-log") {
    return {
      reason: "archive-contentHash-miss; transcript-render-contentHash-miss; allowed-file-contentHash-miss",
      searchedEvidence: [
        "work-log archives: 5 files/13,197 sections",
        "Claude transcripts: 9,117 files/34,161 matched events",
        "current Brain Raw hash donors",
        "allowed C evidence roots: 5,980 files",
      ],
      nextRequiredEvidence: "해당 contentHash와 일치하는 원본 work-log Raw, 추가 archive 사본, 또는 누락 시점의 원본 tool event/result transcript",
    };
  }
  if (item.sourceFamily === "session-handoff") {
    return {
      reason: "session-transcript-contentHash-miss; allowed-file-contentHash-miss",
      searchedEvidence: [
        "Claude session transcripts: 8,766 files",
        "adjacent surviving session Raw snapshots",
        "current Brain Raw hash donors",
        "allowed C evidence roots: 5,980 files",
      ],
      nextRequiredEvidence: "해당 contentHash와 일치하는 원본 session Raw 또는 현재 transcript 집합에 없는 당시 세션 원문",
    };
  }
  return {
    reason: "no-specialized-generator; db-originalChunk-absent; allowed-file-contentHash-miss",
    searchedEvidence: [
      "DB original_chunk: exact rows 0",
      "current Brain Raw hash donors",
      "allowed C evidence roots: 5,980 files",
    ],
    nextRequiredEvidence: "해당 contentHash와 일치하는 원본 Raw, 별도 백업 사본, 또는 신뢰 가능한 peer Brain 사본",
  };
}

function buildResidualLedger(brainRoot) {
  const classification = classifyMissingRaw(brainRoot);
  const audit = auditIntegrity(brainRoot);
  const rows = classification.items.map(item => ({
    recordId: item.recordId,
    scopeType: item.scopeType,
    scopeId: item.scopeId,
    type: item.type,
    sourceRef: item.sourceRef,
    contentHash: item.contentHash,
    sourceFamily: item.sourceFamily,
    generatorProfile: item.generatorProfile,
    canonical: item.canonical,
    residualClass: "D-evidence-exhausted",
    ...evidenceDisposition(item),
    status: "not-restored",
  }));
  const uniqueIds = new Set(rows.map(row => row.recordId));
  const requiredFieldsPresent = rows.every(row => row.residualClass && row.reason
    && Array.isArray(row.searchedEvidence) && row.searchedEvidence.length > 0 && row.nextRequiredEvidence);
  const valid = rows.length === audit.totals.issues
    && uniqueIds.size === rows.length
    && requiredFieldsPresent
    && audit.issues.every(issue => issue.type === "missing-raw");
  if (!valid) {
    throw new Error(`residual ledger validation failed: rows=${rows.length}, issues=${audit.totals.issues}, unique=${uniqueIds.size}`);
  }
  return {
    generatedAt: new Date().toISOString(),
    brainRoot: path.resolve(brainRoot),
    total: rows.length,
    uniqueRecordIds: uniqueIds.size,
    auditIssues: audit.totals.issues,
    byFamily: classification.groups.sourceFamily,
    byGeneratorProfile: classification.groups.generatorProfile,
    byResidualClass: { "D-evidence-exhausted": rows.length },
    requiredFieldsPresent,
    valid,
    rows,
  };
}

function parseArgs(argv) {
  const args = { root: null, output: null, summary: null };
  for (const arg of argv) {
    if (arg.startsWith("--output=")) args.output = arg.slice(9);
    else if (arg.startsWith("--summary=")) args.summary = arg.slice(10);
    else if (!arg.startsWith("--") && !args.root) args.root = arg;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root || !args.output || !args.summary) {
    throw new Error("사용법: node build-missing-raw-residual-ledger.js <brainRoot> --output=<jsonl> --summary=<json>");
  }
  const result = buildResidualLedger(args.root);
  const outputPath = path.resolve(args.output);
  const summaryPath = path.resolve(args.summary);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(outputPath, result.rows.map(row => JSON.stringify(row)).join("\n") + "\n", "utf8");
  const { rows, ...summary } = result;
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error); process.exit(1); }
}

module.exports = { buildResidualLedger, evidenceDisposition };
