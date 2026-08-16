"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ensureDir, isoNow, readJsonl, writeJsonl, calculateHash } = require("./utils");
const { splitFrontmatter } = require("./obsidian-frontmatter");
const { memoryNodeTypeFromFrontmatter, normalizeOntologyRelations } = require("./ontology-relations");

function obsidianDir(brainRoot) {
  return path.join(brainRoot, "45_obsidian_sources");
}

function sourcesPath(brainRoot) {
  return path.join(obsidianDir(brainRoot), "sources.jsonl");
}

function sourceIdFor(filePath) {
  return `obs_${crypto.createHash("sha1").update(path.resolve(filePath).toLowerCase()).digest("hex").slice(0, 12)}`;
}

function walkMarkdown(root, limit = Infinity) {
  const results = [];
  const stack = [root];
  while (stack.length > 0 && results.length < limit) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) stack.push(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        results.push(fullPath);
        if (results.length >= limit) break;
      }
    }
  }
  return results;
}

function parseFrontmatter(content) {
  return splitFrontmatter(content).data;
}

function inferSourceClass(filePath, frontmatter) {
  if (frontmatter.doc_type) return frontmatter.doc_type;
  const text = filePath.toLowerCase();
  if (/설계|design|system/.test(text)) return "design";
  if (/research|리서치|조사/.test(text)) return "research";
  if (/기획|plan/.test(text)) return "planning";
  return "note";
}

function scopeHintsFor(filePath, frontmatter, scope) {
  const hints = new Set();
  if (scope) hints.add(scope);
  if (frontmatter.scope) hints.add(frontmatter.scope);
  if (frontmatter.scope_id) hints.add(frontmatter.scope_id);
  const lower = filePath.toLowerCase();
  if (lower.includes("brain")) hints.add("brain");
  if (lower.includes("agentforge") || lower.includes("밴딩")) hints.add("agentforge");
  return Array.from(hints);
}

function buildSourceRecord(filePath, root, options = {}) {
  const content = fs.readFileSync(filePath, "utf-8");
  const frontmatter = parseFrontmatter(content);
  const stat = fs.statSync(filePath);
  return {
    sourceId: sourceIdFor(filePath),
    path: path.resolve(filePath),
    root: path.resolve(root),
    hash: calculateHash(filePath),
    mtime: stat.mtime.toISOString(),
    sourceClass: inferSourceClass(filePath, frontmatter),
    scopeHints: scopeHintsFor(filePath, frontmatter, options.scope),
    trustLevel: frontmatter.authority || (frontmatter.status === "approved" || frontmatter.status === "final" ? "high" : "normal"),
    visibility: frontmatter.visibility || "project",
    canonicalId: frontmatter.canonical_id || null,
    docType: frontmatter.doc_type || null,
    status: frontmatter.status || null,
    authority: frontmatter.authority || null,
    memoryClasses: Array.isArray(frontmatter.memory_classes)
      ? frontmatter.memory_classes
      : String(frontmatter.memory_classes || "").split(",").map(item => item.trim()).filter(Boolean),
    defaultDepth: frontmatter.default_depth || null,
    maxAutoDepth: frontmatter.max_auto_depth || null,
    requiresConfirmationForFact: frontmatter.requires_confirmation_for_fact === true || frontmatter.requires_confirmation_for_fact === "true",
    memoryNodeType: memoryNodeTypeFromFrontmatter(frontmatter),
    relations: normalizeOntologyRelations(frontmatter),
    needsReview: Object.keys(frontmatter).length === 0,
    lastIndexedAt: isoNow()
  };
}

function indexObsidian(brainRoot, options = {}) {
  const root = options.root;
  if (!root || !fs.existsSync(root)) throw new Error(`Obsidian root를 찾을 수 없습니다: ${root}`);
  const files = walkMarkdown(root, Number(options.limit || Infinity));
  const existing = readJsonl(sourcesPath(brainRoot));
  const currentSourceIds = new Set(files.map(filePath => sourceIdFor(filePath)));
  const bySourceId = new Map(existing
    .filter(source => !options.prune || path.resolve(source.root || "") !== path.resolve(root) || currentSourceIds.has(source.sourceId))
    .map(source => [source.sourceId, source]));

  for (const filePath of files) {
    const record = buildSourceRecord(filePath, root, options);
    const previous = bySourceId.get(record.sourceId);
    if (previous && previous.hash === record.hash) {
      bySourceId.set(record.sourceId, { ...previous, lastIndexedAt: isoNow() });
    } else {
      bySourceId.set(record.sourceId, record);
    }
  }

  ensureDir(obsidianDir(brainRoot));
  const sources = Array.from(bySourceId.values());
  writeJsonl(sourcesPath(brainRoot), sources);
  return { indexed: files.length, total: sources.length, sources: files.map(filePath => bySourceId.get(sourceIdFor(filePath))) };
}

function readSources(brainRoot) {
  return readJsonl(sourcesPath(brainRoot));
}

function getSource(brainRoot, sourceId) {
  return readSources(brainRoot).find(source => source.sourceId === sourceId) || null;
}

module.exports = {
  obsidianDir,
  sourcesPath,
  sourceIdFor,
  parseFrontmatter,
  indexObsidian,
  readSources,
  getSource
};
