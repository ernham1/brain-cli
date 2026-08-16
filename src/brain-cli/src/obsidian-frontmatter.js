"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const yaml = require("js-yaml");
const { ensureDir } = require("./utils");
const { buildDefaultMemoryFrontmatter } = require("./ontology-relations");

const REQUIRED_FIELDS = [
  "canonical_id",
  "doc_type",
  "scope_id",
  "scope",
  "status",
  "authority",
  "memory_classes",
  "default_depth",
  "max_auto_depth",
  "visibility",
  "requires_confirmation_for_fact",
  "memory"
];

function walkMarkdown(root, limit = Infinity) {
  const results = [];
  const start = path.resolve(root);
  const stack = [start];
  while (stack.length > 0 && results.length < limit) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        results.push(fullPath);
        if (results.length >= limit) break;
      }
    }
  }
  return results.sort((a, b) => a.localeCompare(b));
}

function splitFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: content, hasFrontmatter: false };
  return {
    data: yaml.load(match[1]) || {},
    body: content.slice(match[0].length),
    hasFrontmatter: true
  };
}

function renderFrontmatter(data, body) {
  const yamlText = yaml.dump(data, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false
  }).trimEnd();
  return `---\n${yamlText}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}

function inferDocType(filePath) {
  const text = filePath.toLowerCase();
  if (/설계|design|architecture|시스템설계/.test(text)) return "design";
  if (/research|리서치|논문|paper|조사/.test(text)) return "research";
  if (/기획|plan|planning/.test(text)) return "planning";
  if (/규칙|rule|policy/.test(text)) return "rule";
  return "note";
}

function inferScopeId(filePath, fallback = "ai-learning") {
  const text = filePath.toLowerCase();
  if (/brain|브레인|memory-kernel|memory kernel/.test(text)) return "brain";
  if (/agentforge|밴딩|banding/.test(text)) return "agentforge";
  if (/clo-telegram|telegram|텔레그램/.test(text)) return "clo-telegram";
  return fallback;
}

function memoryClassesFor(docType) {
  if (docType === "design") return ["architecture", "decision_context"];
  if (docType === "research") return ["evidence", "reference"];
  if (docType === "planning") return ["plan", "decision_context"];
  if (docType === "rule") return ["policy", "guard"];
  return ["knowledge"];
}

function canonicalIdFor(filePath) {
  const seed = path.resolve(filePath).toLowerCase();
  return `obs_${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 16)}`;
}

function buildDefaultFrontmatter(filePath, options = {}) {
  const docType = inferDocType(filePath);
  const scopeId = options.scopeId || inferScopeId(filePath, options.defaultScopeId || "ai-learning");
  return {
    canonical_id: canonicalIdFor(filePath),
    doc_type: docType,
    scope_id: scopeId,
    scope: scopeId,
    status: "candidate",
    authority: "inferred",
    memory_classes: memoryClassesFor(docType),
    default_depth: docType === "note" ? "D1" : "D2",
    max_auto_depth: "D4",
    visibility: "project",
    requires_confirmation_for_fact: true,
    memory: buildDefaultMemoryFrontmatter(docType)
  };
}

function mergeFrontmatter(existing, defaults) {
  const merged = { ...defaults, ...existing };
  for (const field of REQUIRED_FIELDS) {
    if (merged[field] === undefined || merged[field] === null || merged[field] === "") {
      merged[field] = defaults[field];
    }
  }
  if (!Array.isArray(merged.memory_classes)) {
    merged.memory_classes = String(merged.memory_classes || "")
      .split(",")
      .map(item => item.trim())
      .filter(Boolean);
  }
  if (merged.memory_classes.length === 0) merged.memory_classes = defaults.memory_classes;
  if (!merged.memory || typeof merged.memory !== "object" || Array.isArray(merged.memory)) {
    merged.memory = defaults.memory;
  } else {
    merged.memory = {
      ...defaults.memory,
      ...merged.memory,
      relations: Array.isArray(merged.memory.relations) ? merged.memory.relations : []
    };
  }
  return merged;
}

function previewFrontmatter(filePath, options = {}) {
  const content = fs.readFileSync(filePath, "utf-8");
  const parsed = splitFrontmatter(content);
  const defaults = buildDefaultFrontmatter(filePath, options);
  const nextData = mergeFrontmatter(parsed.data, defaults);
  const nextContent = renderFrontmatter(nextData, parsed.body);
  const missingFields = REQUIRED_FIELDS.filter(field =>
    parsed.data[field] === undefined || parsed.data[field] === null || parsed.data[field] === ""
  );
  return {
    path: path.resolve(filePath),
    hasFrontmatter: parsed.hasFrontmatter,
    changed: nextContent !== content,
    missingFields,
    frontmatter: nextData,
    nextContent
  };
}

function planFrontmatter(root, options = {}) {
  if (!root || !fs.existsSync(root)) throw new Error(`Obsidian root를 찾을 수 없습니다: ${root}`);
  const files = walkMarkdown(root, Number(options.limit || Infinity));
  const previews = files.map(filePath => previewFrontmatter(filePath, options));
  const changes = previews.filter(item => item.changed);
  return {
    root: path.resolve(root),
    total: previews.length,
    changeCount: changes.length,
    unchangedCount: previews.length - changes.length,
    previews: changes.slice(0, Number(options.previewLimit || 10)).map(item => ({
      path: item.path,
      hasFrontmatter: item.hasFrontmatter,
      missingFields: item.missingFields,
      frontmatter: item.frontmatter
    })),
    changes
  };
}

function applyFrontmatter(root, options = {}) {
  const plan = planFrontmatter(root, options);
  if (options.dryRun) {
    return {
      mode: "dry_run",
      root: plan.root,
      total: plan.total,
      changeCount: plan.changeCount,
      unchangedCount: plan.unchangedCount,
      previews: plan.previews
    };
  }

  const backupDir = path.resolve(options.backupDir || path.join(root, ".brain-frontmatter-backup"));
  const applied = [];
  for (const item of plan.changes) {
    const relativePath = path.relative(plan.root, item.path);
    const backupPath = path.join(backupDir, relativePath);
    ensureDir(path.dirname(backupPath));
    fs.copyFileSync(item.path, backupPath);
    fs.writeFileSync(item.path, item.nextContent, "utf-8");
    applied.push({ path: item.path, backupPath });
  }

  return {
    mode: "apply",
    root: plan.root,
    backupDir,
    total: plan.total,
    appliedCount: applied.length,
    unchangedCount: plan.unchangedCount,
    applied: applied.slice(0, Number(options.previewLimit || 10))
  };
}

module.exports = {
  REQUIRED_FIELDS,
  walkMarkdown,
  splitFrontmatter,
  renderFrontmatter,
  inferDocType,
  inferScopeId,
  buildDefaultFrontmatter,
  previewFrontmatter,
  planFrontmatter,
  applyFrontmatter
};
