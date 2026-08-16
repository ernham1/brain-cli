"use strict";

const fs = require("fs");
const path = require("path");
const {
  calculateHash,
  calculateHashFromString,
  generateDigestLine,
  isoNow,
  readJsonl,
  safeReadJson,
  writeJsonl
} = require("./utils");

function categorizeSourceRef(sourceRef) {
  if (sourceRef.startsWith("00_user/")) return "user";
  if (sourceRef.startsWith("10_projects/")) return "project";
  if (sourceRef.startsWith("20_agents/")) return "agent";
  if (sourceRef.startsWith("30_topics/")) return "topic";
  if (sourceRef.startsWith("40_wiki/")) return "wiki";
  if (sourceRef.startsWith("90_index/")) return "index";
  if (sourceRef.startsWith("99_policy/")) return "policy";
  return "unknown";
}

function recordsPath(brainRoot) {
  return path.join(brainRoot, "90_index", "records.jsonl");
}

function manifestPath(brainRoot) {
  return path.join(brainRoot, "90_index", "manifest.json");
}

function digestPath(brainRoot) {
  return path.join(brainRoot, "90_index", "records_digest.txt");
}

function findSourceRefIssues(brainRoot) {
  const records = readJsonl(recordsPath(brainRoot));
  const manifestResult = safeReadJson(manifestPath(brainRoot));
  const manifest = manifestResult.ok ? manifestResult.data : { files: [] };
  const files = Array.isArray(manifest.files) ? manifest.files : [];

  const missingRecordSourceRefs = records.filter(record => {
    if (!record.sourceRef) return false;
    if (record.status !== "active") return false;
    return !fs.existsSync(path.join(brainRoot, record.sourceRef));
  });

  const recordSourceRefs = new Set(records.filter(r => r.sourceRef).map(r => r.sourceRef));
  const missingManifestEntries = files.filter(entry => {
    if (!entry || !entry.path) return false;
    return !fs.existsSync(path.join(brainRoot, entry.path));
  });
  const manifestOnlyMissingEntries = missingManifestEntries.filter(entry => !recordSourceRefs.has(entry.path));

  return {
    missingRecordSourceRefs,
    missingManifestEntries,
    manifestOnlyMissingEntries
  };
}

function renderRecoveredSourceFile(record, recoveredAt = isoNow()) {
  const title = record.title || record.recordId || "Recovered Brain Record";
  const tags = Array.isArray(record.tags) && record.tags.length > 0
    ? record.tags.map(tag => `- ${tag}`).join("\n")
    : "- (none)";
  const summary = record.summary || "(summary 없음)";

  return [
    `# ${title}`,
    "",
    "> Brain sourceRef 자동 복구 문서입니다.",
    "",
    "원본 문서 파일이 없어서 `records.jsonl` 메타데이터 기준으로 재생성했습니다.",
    "원문 전체 내용은 복구할 수 없으며, recall 가능한 핵심 메타데이터만 보존합니다.",
    "",
    "## Record",
    `- recordId: ${record.recordId || ""}`,
    `- scopeType: ${record.scopeType || ""}`,
    `- scopeId: ${record.scopeId || ""}`,
    `- type: ${record.type || ""}`,
    `- sourceType: ${record.sourceType || ""}`,
    `- status: ${record.status || ""}`,
    `- updatedAt: ${record.updatedAt || ""}`,
    `- sourceRef: ${record.sourceRef || ""}`,
    `- recoveredAt: ${recoveredAt}`,
    "",
    "## Summary",
    summary,
    "",
    "## Tags",
    tags,
    ""
  ].join("\n");
}

function upsertManifestEntry(manifest, sourceRef, fullPath, updatedAt = isoNow()) {
  if (!Array.isArray(manifest.files)) manifest.files = [];
  const entry = {
    path: sourceRef,
    hash: calculateHash(fullPath),
    size: fs.statSync(fullPath).size,
    updatedAt,
    category: categorizeSourceRef(sourceRef)
  };
  const index = manifest.files.findIndex(file => file.path === sourceRef);
  if (index >= 0) {
    manifest.files[index] = entry;
  } else {
    manifest.files.push(entry);
  }
}

function recomputeManifestSummary(manifest) {
  const summary = {
    totalFiles: Array.isArray(manifest.files) ? manifest.files.length : 0,
    byCategory: {}
  };
  for (const file of manifest.files || []) {
    const category = file.category || "unknown";
    summary.byCategory[category] = (summary.byCategory[category] || 0) + 1;
  }
  manifest.summary = summary;
}

function repairSourceRefs(brainRoot, options = {}) {
  const { dryRun = false } = options;
  const now = isoNow();
  const recordsFile = recordsPath(brainRoot);
  const manifestFile = manifestPath(brainRoot);
  const digestFile = digestPath(brainRoot);

  const records = readJsonl(recordsFile);
  const manifestResult = safeReadJson(manifestFile);
  const manifest = manifestResult.ok ? manifestResult.data : { version: "1.0", files: [] };
  if (!Array.isArray(manifest.files)) manifest.files = [];

  const issues = findSourceRefIssues(brainRoot);
  const missingById = new Map(issues.missingRecordSourceRefs.map(record => [record.recordId, record]));
  const restored = [];

  for (const record of records) {
    if (!missingById.has(record.recordId)) continue;

    const content = renderRecoveredSourceFile(record, now);
    const fullPath = path.join(brainRoot, record.sourceRef);
    const hash = calculateHashFromString(content);

    restored.push({
      recordId: record.recordId,
      sourceRef: record.sourceRef,
      title: record.title
    });

    if (dryRun) continue;

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
    record.contentHash = hash;
    upsertManifestEntry(manifest, record.sourceRef, fullPath, now);
  }

  const removedManifestEntries = issues.manifestOnlyMissingEntries.map(entry => entry.path);
  if (!dryRun && removedManifestEntries.length > 0) {
    const removeSet = new Set(removedManifestEntries);
    manifest.files = manifest.files.filter(entry => !removeSet.has(entry.path));
  }

  if (!dryRun && (restored.length > 0 || removedManifestEntries.length > 0)) {
    manifest.updatedAt = now;
    recomputeManifestSummary(manifest);
    writeJsonl(recordsFile, records);
    fs.writeFileSync(manifestFile + ".tmp", JSON.stringify(manifest, null, 2), "utf-8");
    fs.renameSync(manifestFile + ".tmp", manifestFile);
    fs.writeFileSync(digestFile, records.map(r => generateDigestLine(r)).join("\n") + (records.length > 0 ? "\n" : ""), "utf-8");
  }

  return {
    dryRun,
    restored,
    removedManifestEntries,
    missingRecordSourceRefs: issues.missingRecordSourceRefs.map(record => ({
      recordId: record.recordId,
      sourceRef: record.sourceRef,
      title: record.title
    })),
    missingManifestEntries: issues.missingManifestEntries.map(entry => entry.path)
  };
}

module.exports = {
  categorizeSourceRef,
  findSourceRefIssues,
  repairSourceRefs,
  renderRecoveredSourceFile
};
