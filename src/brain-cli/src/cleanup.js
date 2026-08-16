"use strict";

const fs = require("fs");
const path = require("path");
const { readJsonl, safeReadJson } = require("./utils");

/**
 * Brain cleanup target audit.
 *
 * Raw documents are immutable, so cleanup never mutates files or indexes.
 * Recovery and lifecycle changes must use a dedicated BWT-locked path.
 *
 * @param {string} brainRoot - absolute Brain/ path
 * @returns {{ brokenRefs: number, manifestCleaned: number, archived: number, handoffDeprecated: number, readOnly: boolean }}
 */
function cleanup(brainRoot) {
  const indexDir = path.join(brainRoot, "90_index");
  const records = readJsonl(path.join(indexDir, "records.jsonl"));
  const manifestResult = safeReadJson(path.join(indexDir, "manifest.json"));
  const manifest = manifestResult.ok ? manifestResult.data : null;

  const brokenRefs = records.filter(rec => {
    if (!rec.sourceRef) return false;
    if (rec.status === "deprecated" || rec.status === "archived") return false;
    return !fs.existsSync(path.join(brainRoot, rec.sourceRef));
  }).length;

  const manifestCleaned = manifest && Array.isArray(manifest.files)
    ? manifest.files.filter(entry => !fs.existsSync(path.join(brainRoot, entry.path))).length
    : 0;

  const completedPatterns = ["완료", "\u2705"];
  const handoffDeprecated = records.filter(rec => {
    if (rec.scopeId !== "handoff-to-vscode") return false;
    if (rec.status === "deprecated" || rec.status === "archived") return false;
    const titleAndSummary = `${rec.title || ""} ${rec.summary || ""}`;
    return completedPatterns.some(pattern => titleAndSummary.includes(pattern));
  }).length;

  return {
    brokenRefs,
    manifestCleaned,
    archived: 0,
    handoffDeprecated,
    readOnly: true
  };
}

module.exports = { cleanup };
