"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ensureDir, isoNow, readJsonl, writeJsonl, safeReadJson } = require("./utils");
const { detectSensitive } = require("./sensitive-scan");

const DEFAULT_POLICY = {
  channelModes: {
    codex_local: ["public", "project", "thread", "private_user_preference", "private_user_workstyle", "private_user_contextual", "private_agent"],
    desktop_claude: ["public", "project", "thread", "private_user_preference", "private_user_workstyle", "private_user_contextual"],
    telegram_1_1: ["public", "project", "thread", "private_user_preference", "private_user_workstyle", "private_user_contextual"],
    telegram_multi_agent: ["public", "project", "thread", "private_user_preference", "private_user_workstyle"]
  },
  alwaysDeny: ["sensitive"],
  sensitiveRequiresReview: ["private_user_sensitive"]
};

function policyDir(brainRoot) {
  return path.join(brainRoot, "46_policy");
}

function accessPolicyPath(brainRoot) {
  return path.join(policyDir(brainRoot), "access-policy.json");
}

function accessAuditPath(brainRoot) {
  return path.join(policyDir(brainRoot), "access-audit.jsonl");
}

function overridesPath(brainRoot) {
  return path.join(policyDir(brainRoot), "user-overrides.jsonl");
}

function normalizeChannelMode(mode) {
  if (!mode || mode === "dm") return "telegram_1_1";
  if (mode === "group" || mode === "thread") return "telegram_multi_agent";
  return mode;
}

function loadPolicy(brainRoot) {
  const result = safeReadJson(accessPolicyPath(brainRoot));
  if (result.ok) return { ...DEFAULT_POLICY, ...result.data };
  ensureDir(policyDir(brainRoot));
  fs.writeFileSync(accessPolicyPath(brainRoot), JSON.stringify(DEFAULT_POLICY, null, 2), "utf-8");
  return DEFAULT_POLICY;
}

function readOverrides(brainRoot) {
  return readJsonl(overridesPath(brainRoot));
}

function isExpired(override, now = new Date()) {
  return override.expiresAt && new Date(override.expiresAt).getTime() < now.getTime();
}

function applicableOverrides(brainRoot, options = {}) {
  const channelMode = normalizeChannelMode(options.channelMode);
  const conversationId = options.conversationId || options.conversation || null;
  return readOverrides(brainRoot).filter(override => {
    if (isExpired(override)) return false;
    if (override.channelMode !== channelMode) return false;
    if (override.conversationId && conversationId && override.conversationId !== conversationId) return false;
    if (override.conversationId && !conversationId) return false;
    return true;
  });
}

function getAllowedVisibilities(brainRoot, options = {}) {
  const policy = loadPolicy(brainRoot);
  const channelMode = normalizeChannelMode(options.channelMode || "codex_local");
  const allowed = new Set(policy.channelModes[channelMode] || policy.channelModes.codex_local);
  const denied = new Set(policy.alwaysDeny || []);

  for (const override of applicableOverrides(brainRoot, { ...options, channelMode })) {
    for (const visibility of override.allowVisibility || []) {
      if (visibility !== "sensitive") allowed.add(visibility);
    }
    for (const visibility of override.denyVisibility || []) denied.add(visibility);
  }

  for (const visibility of denied) allowed.delete(visibility);
  return { channelMode, allowed: Array.from(allowed), denied: Array.from(denied) };
}

function appendAudit(brainRoot, event) {
  ensureDir(policyDir(brainRoot));
  const records = readJsonl(accessAuditPath(brainRoot));
  records.push({ ...event, checkedAt: isoNow() });
  writeJsonl(accessAuditPath(brainRoot), records);
}

function checkAccess(brainRoot, options = {}) {
  const visibility = options.visibility || "project";
  const text = `${options.title || ""} ${options.summary || ""} ${options.content || ""}`;
  const sensitive = detectSensitive(text);
  const policy = getAllowedVisibilities(brainRoot, options);
  const blockedBySensitive = sensitive.sensitive || visibility === "sensitive";
  const allowed = !blockedBySensitive && policy.allowed.includes(visibility);
  const result = {
    allowed,
    channelMode: policy.channelMode,
    visibility,
    sensitive: sensitive.sensitive,
    sensitiveMatches: sensitive.matches,
    reason: allowed ? "allowed" : (blockedBySensitive ? "sensitive_blocked" : "visibility_blocked")
  };
  appendAudit(brainRoot, {
    ref: options.ref || null,
    channelMode: result.channelMode,
    visibility,
    allowed,
    reason: result.reason
  });
  return result;
}

function filterMemoryItems(brainRoot, items, options = {}) {
  const allowed = [];
  const blockedRefs = [];
  for (const item of items || []) {
    const check = checkAccess(brainRoot, { ...options, ...item });
    if (check.allowed) allowed.push(item);
    else blockedRefs.push({ ref: item.ref || item.recordId || item.id || null, visibility: check.visibility, reason: check.reason });
  }
  return { allowed, blockedRefs };
}

function createOverrideId(input) {
  const seed = `${input.action}|${input.channelMode}|${input.conversationId}|${Date.now()}`;
  return `override_${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 10)}`;
}

function upsertOverride(brainRoot, input = {}) {
  const action = input.action || "allow";
  const channelMode = normalizeChannelMode(input.channelMode);
  const days = Number(input.days || 0);
  const expiresAt = input.expiresAt || (days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null);
  const visibility = input.visibility;
  if (!visibility) throw new Error("override visibility가 필요합니다.");
  if (visibility === "sensitive") throw new Error("sensitive는 override로 허용할 수 없습니다.");
  if (visibility === "private_user_sensitive" && input.scope !== "session") {
    throw new Error("private_user_sensitive는 session override만 허용됩니다.");
  }

  const override = {
    overrideId: createOverrideId({ ...input, action, channelMode }),
    createdAt: isoNow(),
    createdBy: input.createdBy || "codex",
    channelMode,
    conversationId: input.conversationId || input.conversation || null,
    scope: input.scope || "thread",
    allowVisibility: action === "allow" ? [visibility] : [],
    denyVisibility: action === "deny" ? [visibility] : [],
    expiresAt,
    reason: input.reason || ""
  };
  ensureDir(policyDir(brainRoot));
  const overrides = readOverrides(brainRoot);
  overrides.push(override);
  writeJsonl(overridesPath(brainRoot), overrides);
  appendAudit(brainRoot, {
    ref: override.overrideId,
    channelMode,
    visibility,
    allowed: action === "allow",
    reason: `override_${action}`
  });
  return override;
}

module.exports = {
  policyDir,
  accessPolicyPath,
  accessAuditPath,
  overridesPath,
  loadPolicy,
  checkAccess,
  filterMemoryItems,
  getAllowedVisibilities,
  upsertOverride,
  readOverrides,
  normalizeChannelMode
};
