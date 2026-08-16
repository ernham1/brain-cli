"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ensureDir, isoNow, readJsonl, writeJsonl, normalizeTokens } = require("./utils");
const { getSource, readSources } = require("./obsidian-connector");

function depthIndexPath(brainRoot) {
  return path.join(brainRoot, "45_obsidian_sources", "depth-index.jsonl");
}

const DEPTH_ORDER = ["D0", "D1", "D2", "D3", "D4"];

function entryId(sourceId, depth, locator = "") {
  return `depth_${crypto.createHash("sha1").update(`${sourceId}|${depth}|${locator}`).digest("hex").slice(0, 12)}`;
}

function stripFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") return { lines, lineOffset: 0 };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return { lines, lineOffset: 0 };
  return { lines: lines.slice(end + 1), lineOffset: end + 1 };
}

function firstMeaningfulLine(content) {
  return (stripFrontmatter(content).lines.map(line => line.trim()).find(line =>
    line && !line.startsWith("---") && !line.startsWith("#") && !line.startsWith(">")
  ) || "").slice(0, 180);
}

function splitSections(content) {
  const { lines, lineOffset } = stripFrontmatter(content);
  const sections = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,4})\s+(.+)$/);
    if (match) {
      if (current) sections.push(current);
      current = { heading: match[2].trim(), line: i + 1 + lineOffset, body: [] };
    } else if (current) {
      current.body.push({ text: lines[i], line: i + 1 + lineOffset });
    }
  }
  if (current) sections.push(current);
  if (sections.length === 0) {
    sections.push({
      heading: path.basename("untitled", ".md"),
      line: lineOffset + 1,
      body: lines.map((line, index) => ({ text: line, line: index + 1 + lineOffset }))
    });
  }
  return sections;
}

function summarizeSection(section) {
  const body = section.body.map(line => line.text).join(" ").replace(/\s+/g, " ").trim();
  return body.slice(0, 240) || section.heading;
}

function splitParagraphChunks(section, maxChars = 700) {
  const chunks = [];
  let current = [];

  function flush() {
    const text = current.map(line => line.text).join("\n").trim();
    if (text) {
      chunks.push({
        heading: section.heading,
        blockIndex: chunks.length + 1,
        lineStart: current[0].line,
        lineEnd: current[current.length - 1].line,
        text
      });
    }
    current = [];
  }

  for (const line of section.body) {
    if (!line.text.trim()) {
      flush();
      continue;
    }
    current.push(line);
    const currentText = current.map(item => item.text).join("\n");
    if (currentText.length >= maxChars) flush();
  }
  flush();
  return chunks;
}

function scopeHints(source) {
  return Array.isArray(source.scopeHints) ? source.scopeHints : [];
}

function buildDepthEntries(source) {
  const content = fs.readFileSync(source.path, "utf-8");
  const title = path.basename(source.path, ".md");
  const entries = [
    {
      depthEntryId: entryId(source.sourceId, "D0"),
      sourceId: source.sourceId,
      depth: "D0",
      path: source.path,
      heading: null,
      line: 1,
      summary: `${title} — ${firstMeaningfulLine(content)}`.trim(),
      scopeHints: scopeHints(source),
      visibility: source.visibility || "project",
      indexedAt: isoNow()
    },
    {
      depthEntryId: entryId(source.sourceId, "D1"),
      sourceId: source.sourceId,
      depth: "D1",
      path: source.path,
      heading: title,
      line: 1,
      summary: firstMeaningfulLine(content) || title,
      scopeHints: scopeHints(source),
      visibility: source.visibility || "project",
      indexedAt: isoNow()
    }
  ];

  for (const section of splitSections(content)) {
    entries.push({
      depthEntryId: entryId(source.sourceId, "D2", section.heading),
      sourceId: source.sourceId,
      depth: "D2",
      path: source.path,
      heading: section.heading,
      line: section.line,
      summary: summarizeSection(section),
      scopeHints: scopeHints(source),
      visibility: source.visibility || "project",
      indexedAt: isoNow()
    });
    for (const chunk of splitParagraphChunks(section)) {
      const locator = `${section.heading}:${chunk.blockIndex}:${chunk.lineStart}-${chunk.lineEnd}`;
      entries.push({
        depthEntryId: entryId(source.sourceId, "D3", locator),
        sourceId: source.sourceId,
        depth: "D3",
        path: source.path,
        heading: section.heading,
        blockIndex: chunk.blockIndex,
        line: chunk.lineStart,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        summary: chunk.text.replace(/\s+/g, " ").trim().slice(0, 500),
        scopeHints: scopeHints(source),
        visibility: source.visibility || "project",
        indexedAt: isoNow()
      });
      entries.push({
        depthEntryId: entryId(source.sourceId, "D4", locator),
        sourceId: source.sourceId,
        depth: "D4",
        path: source.path,
        heading: section.heading,
        blockIndex: chunk.blockIndex,
        line: chunk.lineStart,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        rawRef: `${source.path}:${chunk.lineStart}-${chunk.lineEnd}`,
        summary: `${source.path}:${chunk.lineStart}-${chunk.lineEnd} — ${chunk.text.replace(/\s+/g, " ").trim().slice(0, 260)}`,
        scopeHints: scopeHints(source),
        visibility: source.visibility || "project",
        indexedAt: isoNow()
      });
    }
  }
  return entries;
}

function indexDepthForSource(brainRoot, sourceId) {
  const source = getSource(brainRoot, sourceId);
  if (!source) throw new Error(`source를 찾을 수 없습니다: ${sourceId}`);
  const existing = readJsonl(depthIndexPath(brainRoot)).filter(entry => entry.sourceId !== sourceId);
  const entries = buildDepthEntries(source);
  ensureDir(path.dirname(depthIndexPath(brainRoot)));
  writeJsonl(depthIndexPath(brainRoot), [...existing, ...entries]);
  return { sourceId, entries };
}

function chooseDepth(goal, requestedDepth) {
  if (requestedDepth && requestedDepth !== "auto") return String(requestedDepth).toUpperCase();
  const text = String(goal || "");
  if (/원문|라인|line|인용|출처|근거|검증|충돌|정합|최신/.test(text)) return "D4";
  if (/구현|설계|자세|상세|분석|리서치|비교/.test(text)) return "D3";
  if (/뭐야|무엇|간단|짧게/.test(text)) return "D1";
  return "D1";
}

function scoreEntry(entry, goal) {
  const tokens = normalizeTokens(goal || "");
  const text = `${entry.heading || ""} ${entry.summary || ""} ${entry.rawRef || ""} ${entry.path || ""} ${(entry.scopeHints || []).join(" ")}`.toLowerCase();
  if (tokens.length === 0) return 0;
  let score = 0;
  for (const token of tokens) {
    if (text.includes(token.toLowerCase())) score += 1;
  }
  return score;
}

function allowedDepths(selectedDepth) {
  const depth = String(selectedDepth || "D1").toUpperCase();
  const index = DEPTH_ORDER.indexOf(depth);
  if (index < 0) return new Set(["D0", "D1"]);
  return new Set(DEPTH_ORDER.slice(0, index + 1));
}

function retrieveDepth(brainRoot, options = {}) {
  let entries = readJsonl(depthIndexPath(brainRoot));
  if (entries.length === 0) {
    const sources = readSources(brainRoot).filter(source => !options.scopeId || (source.scopeHints || []).includes(options.scopeId));
    for (const source of sources.slice(0, 5)) indexDepthForSource(brainRoot, source.sourceId);
    entries = readJsonl(depthIndexPath(brainRoot));
  }

  const selectedDepth = chooseDepth(options.goal, options.depth || "auto");
  const depthOrder = allowedDepths(selectedDepth);
  const scopeId = String(options.scopeId || "").toLowerCase();
  const candidates = entries
    .filter(entry => depthOrder.has(entry.depth))
    .filter(entry => !scopeId || entry.path.toLowerCase().includes(scopeId) || (entry.scopeHints || []).some(hint => String(hint).toLowerCase() === scopeId))
    .map(entry => ({ ...entry, score: scoreEntry(entry, options.goal) }))
    .filter(entry => entry.score > 0 || selectedDepth === "D0")
    .sort((a, b) => b.score - a.score || a.depth.localeCompare(b.depth))
    .slice(0, Number(options.topK || 5));

  return {
    goal: options.goal || "",
    requestedDepth: options.depth || "auto",
    selectedDepth,
    sections: candidates,
    usedRefs: candidates.map(entry => `${entry.path}${entry.heading ? `#${entry.heading}` : ""}`)
  };
}

module.exports = {
  depthIndexPath,
  indexDepthForSource,
  retrieveDepth,
  chooseDepth,
  allowedDepths,
  buildDepthEntries
};
