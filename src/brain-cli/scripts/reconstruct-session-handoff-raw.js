"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { acquireLock } = require("../src/lock");
const { generateDigestLine } = require("../src/utils");

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

function mapDbRecord(row) {
  let tags = [];
  try { tags = JSON.parse(row.tags || "[]"); } catch { /* invalid legacy tags */ }
  return {
    recordId: row.record_id,
    title: row.title,
    summary: row.summary,
    tags,
    status: row.status,
    type: row.type,
    sourceType: row.source_type,
    updatedAt: row.updated_at
  };
}

function sessionParts(sourceRef) {
  const match = normalizeRef(sourceRef).match(/vscode-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-([^.]+)\.md$/);
  if (!match) return null;
  return {
    day: `${match[1]}${match[2]}${match[3]}`,
    date: `${match[1]}-${match[2]}-${match[3]}`,
    time: `${match[4]}:${match[5]}`,
    sessionId: match[7]
  };
}

function renderHandoff(parts, cwd, gitStatus, recentBrain) {
  return [
    `# VS Code 세션 핸드오프 — ${parts.date} ${parts.time}`,
    "",
    "## 세션 정보",
    `- 종료 시각: ${parts.date} ${parts.time} KST`,
    `- 작업 디렉토리: ${cwd}`,
    `- 세션 ID: ${parts.sessionId}`,
    "",
    "## 마지막 대화 내용 (클로 발언 최근 3개)",
    "(대화 내용 없음)",
    "",
    "## 수정된 파일 (git status)",
    gitStatus,
    "",
    "## 오늘 Brain에 저장된 레코드",
    recentBrain
  ].join("\n");
}

function recentBrainFromHandoff(value) {
  const marker = "## 오늘 Brain에 저장된 레코드\n";
  const markerIndex = String(value || "").indexOf(marker);
  return markerIndex >= 0 ? String(value).slice(markerIndex + marker.length) : null;
}

function transcriptFiles(root) {
  const byPrefix = new Map();
  const stack = [path.resolve(root)];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const prefix = entry.name.slice(0, 8);
        if (!byPrefix.has(prefix)) byPrefix.set(prefix, full);
      }
    }
  }
  return byPrefix;
}

function cwdFromSummary(summary) {
  const prefix = "VS Code 세션 종료 (";
  const value = String(summary || "");
  if (!value.startsWith(prefix) || !value.endsWith(")") || value.endsWith(")…")) return null;
  return value.slice(prefix.length, -1);
}

function cwdFromTranscript(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const descriptor = fs.openSync(filePath, "r");
  try {
    const chunkSize = 64 * 1024;
    const buffer = Buffer.alloc(chunkSize);
    let carry = "";
    let total = 0;
    while (total < 8 * 1024 * 1024) {
      const bytes = fs.readSync(descriptor, buffer, 0, chunkSize, null);
      if (bytes === 0) break;
      total += bytes;
      const text = carry + buffer.subarray(0, bytes).toString("utf8");
      const lines = text.split("\n");
      carry = lines.pop() || "";
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          if (typeof item.cwd === "string" && item.cwd) return item.cwd;
        } catch { /* incomplete or malformed line */ }
      }
    }
    if (carry) {
      try {
        const item = JSON.parse(carry);
        if (typeof item.cwd === "string" && item.cwd) return item.cwd;
      } catch { /* ignore */ }
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return null;
}

function upperBoundByRowId(entries, rowid) {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (entries[mid].rowid < rowid) low = mid + 1;
    else high = mid;
  }
  return low;
}

function reconstructPlan(brainRoot, transcriptRoot, options = {}) {
  const root = path.resolve(brainRoot);
  const db = new Database(path.join(root, "90_index", "records.db"), { readonly: true, fileMustExist: true });
  let rows;
  try {
    rows = db.prepare("SELECT rowid, * FROM records ORDER BY rowid").all();
  } finally {
    db.close();
  }

  const requestedRecordIds = new Set(options.recordIds || []);
  const targets = rows.filter(row => {
    if (row.scope_id !== "clo-handoff" || !row.source_ref || !row.content_hash) return false;
    if (requestedRecordIds.size > 0 && !requestedRecordIds.has(row.record_id)) return false;
    const targetPath = resolveInside(root, row.source_ref);
    return targetPath && !fs.existsSync(targetPath) && sessionParts(row.source_ref);
  });
  const rowIndexById = new Map(rows.map((row, index) => [row.rowid, index]));
  const adjacentSnapshots = new Map();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row.scope_id !== "clo-handoff" || !sessionParts(row.source_ref)) continue;
    const rawPath = resolveInside(root, row.source_ref);
    if (!rawPath || !fs.existsSync(rawPath)) continue;
    const recentBrain = recentBrainFromHandoff(fs.readFileSync(rawPath, "utf8"));
    if (recentBrain !== null) adjacentSnapshots.set(index, { recordId: row.record_id, recentBrain });
  }

  const targetDays = [...new Set(targets.map(row => sessionParts(row.source_ref).day))];
  const digestByDay = new Map(targetDays.map(day => [day, []]));
  for (const row of rows) {
    const line = generateDigestLine(mapDbRecord(row));
    for (const day of targetDays) {
      if (line.includes(day)) digestByDay.get(day).push({ rowid: row.rowid, line });
    }
  }

  const transcripts = transcriptFiles(transcriptRoot);
  const cwdCache = new Map();
  const matches = [];
  const unmatched = [];
  const variants = { gitInfoMissing: 0, clean: 0 };

  for (const target of targets) {
    const parts = sessionParts(target.source_ref);
    const digestEntries = digestByDay.get(parts.day) || [];
    const end = upperBoundByRowId(digestEntries, target.rowid);
    const recentRows = digestEntries.slice(Math.max(0, end - 5), end);
    const recentCandidates = [
      {
        value: recentRows.length > 0 ? recentRows.map(entry => entry.line).join("\n") : "(오늘 저장 없음)",
        source: "current-db",
        snapshotRecordId: null
      },
      { value: "(오늘 저장 없음)", source: "fallback", snapshotRecordId: null },
      { value: "(없음)", source: "fallback", snapshotRecordId: null }
    ];
    const targetIndex = rowIndexById.get(target.rowid);
    for (let index = Math.max(0, targetIndex - 60); index <= Math.min(rows.length - 1, targetIndex + 60); index++) {
      const snapshot = adjacentSnapshots.get(index);
      if (!snapshot || snapshot.recordId === target.record_id) continue;
      recentCandidates.push({
        value: snapshot.recentBrain,
        source: "adjacent-raw",
        snapshotRecordId: snapshot.recordId
      });
    }
    const uniqueRecentCandidates = [...new Map(recentCandidates.map(candidate => [candidate.value, candidate])).values()];
    const transcript = transcripts.get(parts.sessionId);
    let cwd = cwdFromSummary(target.summary);
    if (!cwd && transcript) {
      if (!cwdCache.has(transcript)) cwdCache.set(transcript, cwdFromTranscript(transcript));
      cwd = cwdCache.get(transcript);
    }
    if (!cwd) {
      unmatched.push({ recordId: target.record_id, reason: "cwd-evidence-missing" });
      continue;
    }

    let found = null;
    for (const gitStatus of ["(git 정보 없음)", "(수정 없음)"]) {
      for (const recentCandidate of uniqueRecentCandidates) {
        const recentBrain = recentCandidate.value;
        const content = renderHandoff(parts, cwd, gitStatus, recentBrain);
        if (hashText(content) !== target.content_hash) continue;
        found = {
          recordId: target.record_id,
          sourceRef: normalizeRef(target.source_ref),
          contentHash: target.content_hash,
          content,
          evidence: {
            transcript: transcript || null,
            cwdSource: cwdFromSummary(target.summary) ? "db-summary" : "transcript",
            gitStatus,
            digestRows: recentRows.map(entry => entry.rowid),
            recentBrainSource: recentCandidate.source,
            snapshotRecordId: recentCandidate.snapshotRecordId
          }
        };
        if (gitStatus === "(git 정보 없음)") variants.gitInfoMissing++;
        else variants.clean++;
        break;
      }
      if (found) break;
    }
    if (found) matches.push(found);
    else unmatched.push({ recordId: target.record_id, reason: "content-hash-mismatch" });
  }

  return {
    generatedAt: new Date().toISOString(),
    brainRoot: root,
    transcriptRoot: path.resolve(transcriptRoot),
    totals: {
      targets: targets.length,
      transcriptFiles: transcripts.size,
      exactMatches: matches.length,
      unmatched: unmatched.length
    },
    variants,
    matches,
    unmatched
  };
}

function applyReconstruction(brainRoot, transcriptRoot, options = {}) {
  if (!Array.isArray(options.recordIds) || options.recordIds.length === 0) {
    throw new Error("운영 적용은 --record-id=<id[,id]>를 명시해야 합니다.");
  }
  const plan = reconstructPlan(brainRoot, transcriptRoot, options);
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
      const tmpPath = `${targetPath}.handoff-reconstruct-${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmpPath, match.content, { encoding: "utf8", flag: "wx" });
        if (hashText(fs.readFileSync(tmpPath, "utf8")) !== match.contentHash) {
          skipped.push({ recordId: match.recordId, reason: "hash-mismatch" });
          continue;
        }
        fs.copyFileSync(tmpPath, targetPath, fs.constants.COPYFILE_EXCL);
        created.push({ recordId: match.recordId, sourceRef: match.sourceRef, contentHash: match.contentHash });
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
  const parsed = { root: null, transcripts: null, output: null, apply: false, limit: Infinity, recordIds: [] };
  for (const arg of argv) {
    if (arg === "--apply") parsed.apply = true;
    else if (arg.startsWith("--transcripts=")) parsed.transcripts = arg.slice(14);
    else if (arg.startsWith("--output=")) parsed.output = arg.slice(9);
    else if (arg.startsWith("--record-id=")) parsed.recordIds.push(...arg.slice(12).split(",").filter(Boolean));
    else if (arg.startsWith("--limit=")) parsed.limit = Number(arg.slice(8));
    else if (!arg.startsWith("--") && !parsed.root) parsed.root = arg;
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root || !args.transcripts) {
    throw new Error("사용법: node reconstruct-session-handoff-raw.js <brainRoot> --transcripts=<root> [--output=<json>] [--record-id=<id[,id]>] [--apply] [--limit=N]");
  }
  const result = args.apply
    ? applyReconstruction(args.root, args.transcripts, args)
    : reconstructPlan(args.root, args.transcripts, args);
  if (args.output) {
    const outputPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  }
  const output = args.apply
    ? result
    : {
        generatedAt: result.generatedAt,
        brainRoot: result.brainRoot,
        transcriptRoot: result.transcriptRoot,
        totals: result.totals,
        variants: result.variants
      };
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error); process.exit(1); }
}

module.exports = {
  reconstructPlan,
  applyReconstruction,
  renderHandoff,
  hashText,
  sessionParts
};
