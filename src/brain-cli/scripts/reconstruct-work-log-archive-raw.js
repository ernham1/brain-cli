"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { acquireLock } = require("../src/lock");

function hashText(value) {
  return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function normalizeRef(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").normalize("NFC");
}

function resolveInside(root, sourceRef) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalizeRef(sourceRef));
  return resolved.startsWith(resolvedRoot + path.sep) ? resolved : null;
}

function parseArchive(archiveText) {
  const marker = /(?:^|\n)---\n## ([^\n]+)\n/g;
  const headings = [];
  let match;
  while ((match = marker.exec(archiveText)) !== null) {
    headings.push({
      fileName: match[1].trim(),
      contentStart: marker.lastIndex,
      markerStart: match.index
    });
  }

  return headings.map((heading, index) => {
    const next = headings[index + 1];
    let segment = archiveText.slice(heading.contentStart, next ? next.markerStart : archiveText.length);
    if (next) {
      if (segment.endsWith("\n")) segment = segment.slice(0, -1);
    } else {
      if (segment.endsWith("\n")) segment = segment.slice(0, -1);
      if (segment.endsWith("\n")) segment = segment.slice(0, -1);
    }
    return { fileName: heading.fileName, content: segment };
  });
}

function archiveFiles(workLogDir) {
  if (!fs.existsSync(workLogDir)) return [];
  return fs.readdirSync(workLogDir)
    .filter(name => /^archive_.*\.md$/i.test(name))
    .sort()
    .map(name => path.join(workLogDir, name));
}

function loadTargets(brainRoot) {
  const db = new Database(path.join(brainRoot, "90_index", "records.db"), {
    readonly: true,
    fileMustExist: true
  });
  try {
    return db.prepare(`
      SELECT record_id, source_ref, content_hash
      FROM records
      WHERE scope_type='topic' AND scope_id='work-log'
      ORDER BY record_id
    `).all().filter(row => {
      if (!row.source_ref || !row.content_hash) return false;
      const targetPath = resolveInside(brainRoot, row.source_ref);
      return targetPath && !fs.existsSync(targetPath);
    }).map(row => ({
      recordId: row.record_id,
      sourceRef: normalizeRef(row.source_ref),
      contentHash: row.content_hash
    }));
  } finally {
    db.close();
  }
}

function reconstructPlan(brainRoot) {
  const root = path.resolve(brainRoot);
  const targets = loadTargets(root);
  const targetsByName = new Map();
  for (const target of targets) {
    const fileName = path.posix.basename(target.sourceRef);
    if (!targetsByName.has(fileName)) targetsByName.set(fileName, []);
    targetsByName.get(fileName).push(target);
  }

  const matches = new Map();
  const archives = archiveFiles(path.join(root, "30_topics", "work-log"));
  let sections = 0;
  let hashChecks = 0;

  for (const archivePath of archives) {
    const parsed = parseArchive(fs.readFileSync(archivePath, "utf8"));
    sections += parsed.length;
    for (const section of parsed) {
      const possibleTargets = targetsByName.get(section.fileName) || [];
      if (possibleTargets.length === 0) continue;
      const contentHash = hashText(section.content);
      hashChecks++;
      for (const target of possibleTargets) {
        if (matches.has(target.recordId) || target.contentHash !== contentHash) continue;
        matches.set(target.recordId, {
          recordId: target.recordId,
          sourceRef: target.sourceRef,
          contentHash: target.contentHash,
          content: section.content,
          evidence: {
            archive: path.basename(archivePath),
            heading: section.fileName
          }
        });
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    brainRoot: root,
    totals: {
      targets: targets.length,
      archiveFiles: archives.length,
      archiveSections: sections,
      hashChecks,
      exactMatches: matches.size,
      unmatched: targets.length - matches.size
    },
    matches: [...matches.values()]
  };
}

function publicReport(plan) {
  return {
    generatedAt: plan.generatedAt,
    brainRoot: plan.brainRoot,
    totals: plan.totals,
    matches: plan.matches.map(match => ({
      recordId: match.recordId,
      sourceRef: match.sourceRef,
      contentHash: match.contentHash,
      evidence: match.evidence
    }))
  };
}

function applyReconstruction(brainRoot, options = {}) {
  const plan = reconstructPlan(brainRoot);
  const limit = Number.isFinite(options.limit) ? options.limit : Infinity;
  const selected = plan.matches.slice(0, limit);
  const lock = acquireLock(plan.brainRoot, { staleMs: 30000, timeoutMs: 30000 });
  const created = [];
  const skipped = [];
  try {
    for (const match of selected) {
      const targetPath = resolveInside(plan.brainRoot, match.sourceRef);
      if (!targetPath) {
        skipped.push({ recordId: match.recordId, reason: "unsafe-source-ref" });
        continue;
      }
      if (fs.existsSync(targetPath)) {
        skipped.push({ recordId: match.recordId, reason: "target-exists" });
        continue;
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const tmpPath = `${targetPath}.archive-reconstruct-${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmpPath, match.content, { encoding: "utf8", flag: "wx" });
        if (hashText(fs.readFileSync(tmpPath, "utf8")) !== match.contentHash) {
          skipped.push({ recordId: match.recordId, reason: "hash-mismatch" });
          continue;
        }
        fs.copyFileSync(tmpPath, targetPath, fs.constants.COPYFILE_EXCL);
        created.push({
          recordId: match.recordId,
          sourceRef: match.sourceRef,
          contentHash: match.contentHash
        });
      } catch (error) {
        skipped.push({ recordId: match.recordId, reason: error.code || error.message });
      } finally {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* best effort */ }
      }
    }
  } finally {
    lock.release();
  }
  return {
    applied: true,
    exactMatches: plan.totals.exactMatches,
    created,
    skipped,
    remainingIndexRepair: created.length
  };
}

function parseArgs(argv) {
  const parsed = { root: null, output: null, apply: false, limit: Infinity };
  for (const arg of argv) {
    if (arg === "--apply") parsed.apply = true;
    else if (arg.startsWith("--output=")) parsed.output = arg.slice(9);
    else if (arg.startsWith("--limit=")) parsed.limit = Number(arg.slice(8));
    else if (!arg.startsWith("--") && !parsed.root) parsed.root = arg;
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root) {
    throw new Error("사용법: node reconstruct-work-log-archive-raw.js <brainRoot> [--output=<json>] [--apply] [--limit=N]");
  }
  const result = args.apply
    ? applyReconstruction(args.root, args)
    : reconstructPlan(args.root);
  if (args.output) {
    const outputPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const report = args.apply ? result : publicReport(result);
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  const output = args.apply
    ? result
    : { generatedAt: result.generatedAt, brainRoot: result.brainRoot, totals: result.totals };
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error); process.exit(1); }
}

module.exports = {
  parseArchive,
  reconstructPlan,
  applyReconstruction,
  publicReport,
  hashText
};
