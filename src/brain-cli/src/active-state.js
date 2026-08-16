"use strict";

const fs = require("fs");
const path = require("path");
const { ensureDir, isoNow, safeReadJson } = require("./utils");

function activeStateDir(brainRoot, scopeId) {
  return path.join(brainRoot, "41_active", scopeId);
}

function activeStatePath(brainRoot, scopeId) {
  return path.join(activeStateDir(brainRoot, scopeId), "state.json");
}

function activeStateMarkdownPath(brainRoot, scopeId) {
  return path.join(activeStateDir(brainRoot, scopeId), "state.md");
}

function createDefaultActiveState(scopeId) {
  const state = {
    scopeId,
    updatedAt: isoNow(),
    facts: [],
    decisions: [],
    capabilities: [],
    guardHints: [],
    sourceRefs: [],
    staleCandidates: []
  };

  if (scopeId === "agentforge") {
    const sourceRef = "docs/instructions/2026-05-11-brain-memory-kernel-poc1-implementation.md";
    state.capabilities.push({
      id: "agentforge.html-artifact-output",
      title: "밴딩AI HTML 산출물 가능",
      summary: "밴딩AI는 HTML 산출물을 생성할 수 있으므로 신규 제안이 아니라 기존 기능 연결 대상으로 다뤄야 한다.",
      status: "active",
      sourceRefs: [sourceRef],
      updatedAt: state.updatedAt
    });
    state.guardHints.push({
      id: "do-not-suggest-html-as-new",
      rule: "HTML 산출물을 밴딩AI에 새로 추가하자고 말하지 말고 기존 기능 활용 관점으로 답한다.",
      appliesWhen: ["밴딩AI", "AgentForge", "HTML", "오픈소스 분석"],
      sourceRefs: [sourceRef]
    });
    state.sourceRefs.push(sourceRef);
  }

  return state;
}

function normalizeState(state, scopeId) {
  return {
    scopeId: state.scopeId || scopeId,
    updatedAt: state.updatedAt || isoNow(),
    facts: Array.isArray(state.facts) ? state.facts : [],
    decisions: Array.isArray(state.decisions) ? state.decisions : [],
    capabilities: Array.isArray(state.capabilities) ? state.capabilities : [],
    guardHints: Array.isArray(state.guardHints) ? state.guardHints : [],
    sourceRefs: Array.isArray(state.sourceRefs) ? state.sourceRefs : [],
    staleCandidates: Array.isArray(state.staleCandidates) ? state.staleCandidates : []
  };
}

function loadActiveState(brainRoot, scopeId, options = {}) {
  const filePath = activeStatePath(brainRoot, scopeId);
  if (!fs.existsSync(filePath)) {
    const created = createDefaultActiveState(scopeId);
    if (options.createIfMissing !== false) {
      saveActiveState(brainRoot, created);
    }
    return created;
  }

  const result = safeReadJson(filePath);
  if (!result.ok) {
    throw new Error(`Active State JSON을 읽을 수 없습니다: ${filePath}`);
  }
  return normalizeState(result.data, scopeId);
}

function saveActiveState(brainRoot, state) {
  const scopeId = state.scopeId;
  ensureDir(activeStateDir(brainRoot, scopeId));
  const normalized = normalizeState({ ...state, updatedAt: state.updatedAt || isoNow() }, scopeId);
  fs.writeFileSync(activeStatePath(brainRoot, scopeId), JSON.stringify(normalized, null, 2), "utf-8");
  fs.writeFileSync(activeStateMarkdownPath(brainRoot, scopeId), formatActiveStateMarkdown(normalized), "utf-8");
  return normalized;
}

function formatActiveStateMarkdown(state) {
  const lines = [
    `# ${state.scopeId} Active State`,
    `> updatedAt: ${state.updatedAt}`,
    "",
    "## Capabilities"
  ];

  if (state.capabilities.length === 0) {
    lines.push("- 없음");
  } else {
    for (const capability of state.capabilities) {
      const refs = (capability.sourceRefs || []).join(", ");
      lines.push(`- ${capability.title}: ${capability.summary} [refs: ${refs}]`);
    }
  }

  lines.push("", "## Guard Hints");
  if (state.guardHints.length === 0) {
    lines.push("- 없음");
  } else {
    for (const hint of state.guardHints) {
      const refs = (hint.sourceRefs || []).join(", ");
      lines.push(`- ${hint.rule} [refs: ${refs}]`);
    }
  }

  lines.push("", "## Source Refs");
  if (state.sourceRefs.length === 0) {
    lines.push("- 없음");
  } else {
    for (const ref of state.sourceRefs) lines.push(`- ${ref}`);
  }

  return lines.join("\n") + "\n";
}

function validateActiveState(state) {
  const issues = [];
  for (const fact of state.facts) {
    if (!Array.isArray(fact.sourceRefs) || fact.sourceRefs.length === 0) {
      issues.push(`출처 없는 fact: ${fact.id || fact.title || "unknown"}`);
    }
  }
  for (const capability of state.capabilities) {
    if (!Array.isArray(capability.sourceRefs) || capability.sourceRefs.length === 0) {
      issues.push(`출처 없는 capability: ${capability.id || capability.title || "unknown"}`);
    }
  }
  return { passed: issues.length === 0, issues };
}

module.exports = {
  activeStatePath,
  activeStateMarkdownPath,
  loadActiveState,
  saveActiveState,
  validateActiveState,
  createDefaultActiveState,
  formatActiveStateMarkdown
};
