"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
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

function shortPath(filePath) {
  const parts = String(filePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-3).join("/");
}

function sourceParts(sourceRef) {
  const match = normalizeRef(sourceRef).match(/\/(\d{8})_(\d{2})(\d{2})(\d{2})\.md$/);
  if (!match) return null;
  return {
    dateStr: `${match[1].slice(0,4)}-${match[1].slice(4,6)}-${match[1].slice(6,8)}`,
    timeStr: `${match[2]}:${match[3]}`,
    epochHint: Date.parse(`${match[1].slice(0,4)}-${match[1].slice(4,6)}-${match[1].slice(6,8)}T${match[2]}:${match[3]}:${match[4]}+09:00`),
  };
}

function targetActionKey(summary) {
  return String(summary || "").replace(/^\[\d{2}:\d{2}\]\s*/, "");
}

function eventActionKey(toolUse) {
  const name = toolUse.name;
  const input = toolUse.input || {};
  if (name === "Write" || name === "Edit") return `${name}: ${shortPath(input.file_path)}`;
  if (name === "Bash") return String(input.command || "").trim().slice(0, 80);
  return null;
}

function renderCandidates(toolUse, toolResult, target) {
  const parts = sourceParts(target.sourceRef);
  if (!parts) return [];
  const input = toolUse.input || {};
  const dateStr = parts.dateStr;
  const timeStr = parts.timeStr;
  if (toolUse.name === "Write") {
    const preview = String(input.content || "").trim().slice(0, 300);
    return [[
      `# 파일 쓰기 — ${dateStr} ${timeStr}`, "", "## 대상 파일", input.file_path || "", "",
      "## 내용 미리보기 (앞 300자)", preview || "(빈 파일)",
    ].join("\n")];
  }
  if (toolUse.name === "Edit") {
    const oldString = String(input.old_string || "").trim().slice(0, 200);
    const newString = String(input.new_string || "").trim().slice(0, 200);
    return [[
      `# 파일 수정 — ${dateStr} ${timeStr}`, "", "## 대상 파일", input.file_path || "", "",
      "## 변경 전 (앞 200자)", oldString || "(없음)", "", "## 변경 후 (앞 200자)", newString || "(없음)",
    ].join("\n")];
  }
  if (toolUse.name === "Bash") {
    const command = String(input.command || "").trim();
    const outputs = new Set();
    if (typeof toolResult.blockContent === "string") outputs.add(toolResult.blockContent.trim());
    if (typeof toolResult.stdout === "string") outputs.add(toolResult.stdout.trim());
    if (typeof toolResult.output === "string") outputs.add(toolResult.output.trim());
    if (outputs.size === 0) outputs.add("");
    return [...outputs].map(output => {
      const summary = output.length > 300 ? output.slice(0, 300) + "..." : output;
      return [
        `# 작업 로그 — ${dateStr} ${timeStr}`, "", "## 명령", "```", command.slice(0, 500), "```", "",
        "## 결과 요약", summary || "(출력 없음)",
      ].join("\n");
    });
  }
  return [];
}

async function readJsonIds(filePath) {
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

async function loadTargets(brainRoot, options = {}) {
  const requestedIds = new Set(options.recordIds || []);
  const jsonIds = await readJsonIds(path.join(brainRoot, "90_index", "records.jsonl"));
  const db = new Database(path.join(brainRoot, "90_index", "records.db"), { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`
      SELECT record_id, summary, source_ref, updated_at, content_hash
      FROM records
      WHERE scope_type='topic' AND scope_id='work-log'
      ORDER BY updated_at, record_id
    `).all().filter(row => {
      if (requestedIds.size > 0 && !requestedIds.has(row.record_id)) return false;
      if (jsonIds.has(row.record_id) || !row.source_ref || !row.content_hash) return false;
      const targetPath = resolveInside(brainRoot, row.source_ref);
      return targetPath && !fs.existsSync(targetPath);
    }).map(row => ({
      recordId: row.record_id,
      summary: row.summary,
      sourceRef: normalizeRef(row.source_ref),
      updatedAt: row.updated_at,
      contentHash: row.content_hash,
    }));
  } finally {
    db.close();
  }
}

function transcriptFiles(root) {
  const files = [];
  const stack = [path.resolve(root)];
  while (stack.length) {
    const current = stack.pop();
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    }
  }
  return files;
}

function toolBlocks(item) {
  const content = item.message && item.message.content;
  return Array.isArray(content) ? content : [];
}

function resultData(item, block) {
  const toolUseResult = item.toolUseResult || {};
  return {
    isError: Boolean(block.is_error),
    blockContent: typeof block.content === "string" ? block.content : null,
    stdout: typeof toolUseResult.stdout === "string" ? toolUseResult.stdout : null,
    output: typeof toolUseResult.output === "string" ? toolUseResult.output : null,
  };
}

async function reconstructPlan(brainRoot, transcriptRoot, options = {}) {
  const root = path.resolve(brainRoot);
  const targets = await loadTargets(root, options);
  const byActionKey = new Map();
  for (const target of targets) {
    const key = targetActionKey(target.summary);
    if (!byActionKey.has(key)) byActionKey.set(key, []);
    byActionKey.get(key).push(target);
  }
  const files = transcriptFiles(transcriptRoot);
  const matches = new Map();
  let scannedEvents = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex];
    const uses = new Map();
    const input = fs.createReadStream(file);
    for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
      let item; try { item = JSON.parse(line); } catch { continue; }
      for (const block of toolBlocks(item)) {
        if (block.type === "tool_use" && ["Write", "Edit", "Bash"].includes(block.name)) {
          uses.set(block.id, { name: block.name, input: block.input || {}, timestamp: item.timestamp || null });
        } else if (block.type === "tool_result" && uses.has(block.tool_use_id)) {
          const use = uses.get(block.tool_use_id);
          uses.delete(block.tool_use_id);
          const result = resultData(item, block);
          if (result.isError) continue;
          const key = eventActionKey(use);
          const possibleTargets = byActionKey.get(key) || [];
          scannedEvents++;
          for (const target of possibleTargets) {
            if (matches.has(target.recordId)) continue;
            const source = sourceParts(target.sourceRef);
            const resultTime = Date.parse(item.timestamp || use.timestamp || "");
            if (Number.isFinite(resultTime) && source && Math.abs(source.epochHint - resultTime) > 120000) continue;
            for (const content of renderCandidates(use, result, target)) {
              if (hashText(content) !== target.contentHash) continue;
              matches.set(target.recordId, {
                recordId: target.recordId,
                sourceRef: target.sourceRef,
                contentHash: target.contentHash,
                content,
                evidence: { transcript: file, toolUseId: block.tool_use_id, toolName: use.name },
              });
              break;
            }
          }
        }
      }
    }
    if (options.progress && (fileIndex + 1) % 500 === 0) {
      process.stderr.write(`[reconstruct] files=${fileIndex + 1}/${files.length} matches=${matches.size}/${targets.length}\n`);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    brainRoot: root,
    transcriptRoot: path.resolve(transcriptRoot),
    totals: { targets: targets.length, transcriptFiles: files.length, scannedEvents, exactMatches: matches.size, unmatched: targets.length - matches.size },
    matches: [...matches.values()],
  };
}

async function applyReconstruction(brainRoot, transcriptRoot, options = {}) {
  if (!Array.isArray(options.recordIds) || options.recordIds.length === 0) {
    throw new Error("--apply에는 --record-id allowlist가 필요합니다");
  }
  const plan = await reconstructPlan(brainRoot, transcriptRoot, options);
  const limit = Number.isFinite(options.limit) ? options.limit : Infinity;
  const selected = plan.matches.slice(0, limit);
  const lock = acquireLock(plan.brainRoot, { staleMs: 30000, timeoutMs: 30000 });
  const created = [];
  const skipped = [];
  try {
    for (const match of selected) {
      const targetPath = resolveInside(plan.brainRoot, match.sourceRef);
      if (!targetPath) { skipped.push({ recordId: match.recordId, reason: "unsafe-source-ref" }); continue; }
      if (fs.existsSync(targetPath)) { skipped.push({ recordId: match.recordId, reason: "target-exists" }); continue; }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const tmpPath = `${targetPath}.reconstruct-tmp`;
      fs.writeFileSync(tmpPath, match.content, "utf8");
      if (hashText(fs.readFileSync(tmpPath, "utf8")) !== match.contentHash) {
        fs.unlinkSync(tmpPath);
        skipped.push({ recordId: match.recordId, reason: "hash-mismatch" });
        continue;
      }
      fs.renameSync(tmpPath, targetPath);
      created.push({ recordId: match.recordId, sourceRef: match.sourceRef, contentHash: match.contentHash });
    }
  } finally {
    lock.release();
  }
  return { applied: true, exactMatches: plan.totals.exactMatches, created, skipped, remainingIndexRepair: created.length };
}

function parseArgs(argv) {
  const parsed = { root: null, transcripts: null, output: null, apply: false, progress: false, limit: Infinity, recordIds: [] };
  for (const arg of argv) {
    if (arg === "--apply") parsed.apply = true;
    else if (arg === "--progress") parsed.progress = true;
    else if (arg.startsWith("--transcripts=")) parsed.transcripts = arg.slice(14);
    else if (arg.startsWith("--output=")) parsed.output = arg.slice(9);
    else if (arg.startsWith("--limit=")) parsed.limit = Number(arg.slice(8));
    else if (arg.startsWith("--record-id=")) parsed.recordIds.push(...arg.slice(12).split(",").filter(Boolean));
    else if (!arg.startsWith("--") && !parsed.root) parsed.root = arg;
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root || !args.transcripts) throw new Error("사용법: node reconstruct-auto-brain-raw.js <brainRoot> --transcripts=<root> [--output=<json>] [--apply --record-id=<id,...>] [--limit=N]");
  const result = args.apply ? await applyReconstruction(args.root, args.transcripts, args) : await reconstructPlan(args.root, args.transcripts, args);
  if (args.output) {
    const outputPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  }
  const output = args.apply ? result : { generatedAt: result.generatedAt, brainRoot: result.brainRoot, transcriptRoot: result.transcriptRoot, totals: result.totals };
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

if (require.main === module) main().catch(error => { console.error(error); process.exit(1); });
module.exports = { reconstructPlan, applyReconstruction, renderCandidates, hashText };
