"use strict";

const fs = require("fs");
const path = require("path");
const { ensureDir, isoNow, safeReadJson, readJsonl, writeJsonl } = require("./utils");

function ontologyRoot(brainRoot) {
  return path.join(brainRoot, "48_user_ontology");
}

function profilePath(brainRoot, userId) {
  return path.join(ontologyRoot(brainRoot), "profiles", `${userId}.json`);
}

function defaultProfile(userId) {
  return {
    userId,
    updatedAt: isoNow(),
    roleAndWorkstyle: {
      name: "고광웅",
      preferredTitles: ["광웅 이사님", "이사님"],
      forbiddenTitles: ["고 이사님"],
      role: "기획자",
      organization: "주식회사 뉴럴플럭스",
      codingPolicy: "이사님에게 직접 코딩을 시키지 않고 Codex가 구현한다.",
      explanationPreference: "기술 설명은 비유와 예시를 활용한다.",
      collaborationMode: "Codex가 구현하고 이사님은 판단한다."
    },
    visibility: {
      role_and_workstyle: "allow",
      project_context: "allow_in_project_scope",
      private_context: "explicit_consent_required",
      sensitive: "deny"
    },
    projectContext: [],
    privateContext: [],
    sensitive: []
  };
}

function ensureProfile(brainRoot, userId = "ernham") {
  const filePath = profilePath(brainRoot, userId);
  if (!fs.existsSync(filePath)) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(defaultProfile(userId), null, 2), "utf-8");
  }
  const result = safeReadJson(filePath);
  if (!result.ok) throw new Error(`User Ontology profile을 읽을 수 없습니다: ${filePath}`);
  return result.data;
}

function channelModeFromChannel(channel = "") {
  const value = String(channel).toLowerCase();
  if (value.includes("group") || value.includes("thread") || value.includes("2:1")) return "group";
  return "dm";
}

function consentPath(brainRoot) {
  return path.join(ontologyRoot(brainRoot), "consent.jsonl");
}

function hasPrivateConsent(brainRoot, userId, channel) {
  const records = readJsonl(consentPath(brainRoot));
  return records.some(r =>
    r.userId === userId
    && r.channel === channel
    && r.category === "private_context"
    && r.status === "allow"
  );
}

function appendAudit(brainRoot, event) {
  const filePath = path.join(ontologyRoot(brainRoot), "audit.jsonl");
  ensureDir(path.dirname(filePath));
  const records = readJsonl(filePath);
  records.push({ ...event, at: isoNow() });
  writeJsonl(filePath, records);
}

function getAllowedUserContext(brainRoot, options = {}) {
  const userId = options.userId || "ernham";
  const channel = options.channel || "codex_local";
  const channelMode = options.channelMode || channelModeFromChannel(channel);
  const profile = ensureProfile(brainRoot, userId);
  const allowPrivate = channelMode === "dm" || hasPrivateConsent(brainRoot, userId, channel);

  const context = {
    userId,
    channel,
    channelMode,
    visibility: profile.visibility,
    roleAndWorkstyle: profile.roleAndWorkstyle,
    projectContext: profile.projectContext || [],
    privateContext: allowPrivate ? (profile.privateContext || []) : [],
    sensitive: [],
    omitted: []
  };

  if (!allowPrivate) context.omitted.push("private_context");
  if (Array.isArray(profile.sensitive) && profile.sensitive.length > 0) {
    context.omitted.push("sensitive");
  }

  appendAudit(brainRoot, {
    event: "user_ontology_read",
    userId,
    channel,
    channelMode,
    included: ["role_and_workstyle", "project_context"].concat(allowPrivate ? ["private_context"] : []),
    omitted: context.omitted
  });

  return context;
}

module.exports = {
  ensureProfile,
  getAllowedUserContext,
  channelModeFromChannel,
  profilePath
};
