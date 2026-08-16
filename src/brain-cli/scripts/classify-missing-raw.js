"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { auditIntegrity } = require("../src/integrity-monitor");

function normalizeRef(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").normalize("NFC");
}

function sourceFamily(sourceRef) {
  const ref = normalizeRef(sourceRef);
  if (ref.startsWith("30_topics/work-log/")) return "work-log";
  if (ref.startsWith("10_projects/clo-handoff/sessions/")) return "session-handoff";
  const parts = ref.split("/").filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : "other";
}

function generatorProfile(row, canonical) {
  const family = sourceFamily(row.source_ref);
  const generators = [];
  if (family === "work-log") {
    generators.push("work-log-archive");
    if (canonical.jsonl === 0) generators.push("auto-brain-transcript");
  } else if (family === "session-handoff") {
    generators.push("session-handoff-transcript");
  }
  return generators.length > 0 ? generators.join("+") : "no-specialized-generator";
}

function increment(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function incrementMap(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function readCanonicalState(brainRoot) {
  const indexDir = path.join(brainRoot, "90_index");
  const jsonl = fs.readFileSync(path.join(indexDir, "records.jsonl"), "utf8")
    .split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const digest = fs.readFileSync(path.join(indexDir, "records_digest.txt"), "utf8").split(/\r?\n/);
  const manifest = JSON.parse(fs.readFileSync(path.join(indexDir, "manifest.json"), "utf8"));
  const jsonlCounts = new Map();
  const digestCounts = new Map();
  const manifestCounts = new Map();
  for (const record of jsonl) incrementMap(jsonlCounts, record.recordId);
  for (const line of digest) {
    const separator = line.indexOf(" | ");
    if (separator > 0) incrementMap(digestCounts, line.slice(0, separator));
  }
  for (const entry of manifest.files || []) incrementMap(manifestCounts, normalizeRef(entry.path));
  return { jsonlCounts, digestCounts, manifestCounts };
}

function classifyMissingRaw(brainRoot) {
  const root = path.resolve(brainRoot);
  const audit = auditIntegrity(root);
  const missing = audit.issues.filter(issue => issue.type === "missing-raw");
  const canonicalState = readCanonicalState(root);
  const db = new Database(path.join(root, "90_index", "records.db"), { readonly: true, fileMustExist: true });
  const select = db.prepare(`
    SELECT record_id, scope_type, scope_id, type, source_type, source_ref, content_hash, summary, updated_at
    FROM records WHERE record_id = ?
  `);
  try {
    const groups = { scope: {}, type: {}, sourceFamily: {}, generatorProfile: {}, canonicalState: {} };
    const items = missing.map(issue => {
      const row = select.get(issue.recordId);
      if (!row) throw new Error(`DB record missing during classification: ${issue.recordId}`);
      const sourceRef = normalizeRef(row.source_ref);
      const canonical = {
        jsonl: canonicalState.jsonlCounts.get(row.record_id) || 0,
        digest: canonicalState.digestCounts.get(row.record_id) || 0,
        manifest: canonicalState.manifestCounts.get(sourceRef) || 0,
      };
      const family = sourceFamily(sourceRef);
      const profile = generatorProfile(row, canonical);
      const canonicalKey = `jsonl${canonical.jsonl}-digest${canonical.digest}-manifest${canonical.manifest}`;
      increment(groups.scope, `${row.scope_type}/${row.scope_id}`);
      increment(groups.type, row.type || "(none)");
      increment(groups.sourceFamily, family);
      increment(groups.generatorProfile, profile);
      increment(groups.canonicalState, canonicalKey);
      return {
        recordId: row.record_id,
        scopeType: row.scope_type,
        scopeId: row.scope_id,
        type: row.type,
        sourceType: row.source_type,
        sourceRef,
        contentHash: row.content_hash,
        summary: row.summary,
        updatedAt: row.updated_at,
        sourceFamily: family,
        generatorProfile: profile,
        canonical,
      };
    });
    const classifiedTotal = Object.values(groups.sourceFamily).reduce((sum, count) => sum + count, 0);
    if (classifiedTotal !== missing.length || missing.length !== audit.totals.issues) {
      throw new Error(`classification total mismatch: ${classifiedTotal}/${missing.length}/${audit.totals.issues}`);
    }
    return {
      generatedAt: new Date().toISOString(),
      brainRoot: root,
      total: missing.length,
      auditTotals: audit.totals,
      groups,
      items,
    };
  } finally {
    db.close();
  }
}

function parseArgs(argv) {
  const args = { root: null, output: null };
  for (const arg of argv) {
    if (arg.startsWith("--output=")) args.output = arg.slice(9);
    else if (!arg.startsWith("--") && !args.root) args.root = arg;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root) throw new Error("사용법: node classify-missing-raw.js <brainRoot> [--output=<json>]");
  const report = classifyMissingRaw(args.root);
  if (args.output) {
    const outputPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  process.stdout.write(JSON.stringify({ generatedAt: report.generatedAt, total: report.total, groups: report.groups }, null, 2) + "\n");
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error); process.exit(1); }
}

module.exports = { classifyMissingRaw, generatorProfile, sourceFamily };
