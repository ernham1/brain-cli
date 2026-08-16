"use strict";

const crypto = require("crypto");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { ensureDir, isoNow, readJsonl, writeJsonl } = require("./utils");
const { listProjectPromotionExports, upsertGrowthSignal } = require("./growth-signal");

const CONSUMPTION_SCHEMA_VERSION = "project-promotion-consumption/v1";
const ADAPTER_REGISTRY_SCHEMA_VERSION = "project-adapter-registry/v1";
const APPLY_VERIFICATION_SCHEMA_VERSION = "project-apply-verification/v1";
const SUPPORTED_ADAPTER_FORMATS = new Set(["jsonl", "json_array", "markdown", "typescript", "ts", "yaml", "yml"]);
const PASSED_CHECK_STATUSES = new Set(["passed", "success", "ok"]);
const FAILED_CHECK_STATUSES = new Set(["failed", "error"]);
const DEFAULT_VERIFICATION_TIMEOUT_MS = 30000;
const MAX_VERIFICATION_EVIDENCE_LENGTH = 4000;

function projectPromotionConsumptionsPath(brainRoot) {
  return path.join(brainRoot, "47_growth", "promotion-consumptions.jsonl");
}

function projectAdapterRegistryPath(brainRoot) {
  return path.join(brainRoot, "47_growth", "project-adapter-registry.json");
}

function stableConsumptionId(scopeId, promotionId, mode, createdAt) {
  const digest = crypto
    .createHash("sha1")
    .update(`promotion-consumption:${scopeId}:${promotionId}:${mode}:${createdAt}`)
    .digest("hex")
    .slice(0, 12);
  return `gpc_${digest}`;
}

function normalizeMode(mode) {
  if (mode === "dry-run") return "dry_run";
  return mode || "dry_run";
}

function normalizeBoolean(value) {
  return value === true || value === "true" || value === "1" || value === 1;
}

function ensureRequest(request = {}) {
  const scopeId = request.scopeId || request.scope;
  const projectRoot = request.projectRoot || request.project_root;
  const mode = normalizeMode(request.mode);
  if (!scopeId) throw new Error("scopeId가 필요합니다.");
  if (!projectRoot) throw new Error("projectRoot가 필요합니다.");
  if (!["dry_run", "apply"].includes(mode)) throw new Error("mode는 dry_run 또는 apply여야 합니다.");
  if (mode === "apply" && !request.approvalId && !request.approval_id) {
    throw new Error("apply 모드는 approvalId가 필요합니다.");
  }
  return {
    ...request,
    scopeId,
    projectRoot: path.resolve(projectRoot),
    mode,
    promotionId: request.promotionId || request.promotion,
    candidateType: request.candidateType || request.candidate_type,
    approvalId: request.approvalId || request.approval_id,
    adapterRegistryPath: request.adapterRegistryPath || request.adapter_registry_path,
    adapterRegistry: request.adapterRegistry || request.adapter_registry,
    verificationPath: request.verificationPath || request.verification_path,
    verification: request.verification || null,
    postApplyVerificationPath: request.postApplyVerificationPath || request.post_apply_verification_path,
    postApplyVerification: request.postApplyVerification || request.post_apply_verification || request.postVerification || null,
    runVerification: normalizeBoolean(request.runVerification || request.run_verification),
    verificationTimeoutMs: request.verificationTimeoutMs || request.verification_timeout_ms,
    pipelinePolicy: request.pipelinePolicy || request.pipeline_policy || request.applyPipeline || request.apply_pipeline || null,
    requireVerification: normalizeBoolean(request.requireVerification || request.require_verification),
    requestedBy: request.requestedBy || request.requested_by || "unknown",
    reason: request.reason || ""
  };
}

function assertInsideProjectRoot(projectRoot, targetPath) {
  const relative = path.relative(projectRoot, targetPath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`projectRoot 밖 경로는 쓸 수 없습니다: ${targetPath}`);
}

function loadProjectAdapterRegistry(brainRoot, request = {}) {
  if (request.adapterRegistry && typeof request.adapterRegistry === "object") return request.adapterRegistry;
  const registryPath = request.adapterRegistryPath
    ? path.resolve(request.adapterRegistryPath)
    : projectAdapterRegistryPath(brainRoot);
  if (!fs.existsSync(registryPath)) {
    return {
      schemaVersion: ADAPTER_REGISTRY_SCHEMA_VERSION,
      projects: {}
    };
  }
  try {
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
    if (registry.schemaVersion && registry.schemaVersion !== ADAPTER_REGISTRY_SCHEMA_VERSION) {
      throw new Error(`지원하지 않는 adapter registry schemaVersion입니다: ${registry.schemaVersion}`);
    }
    return registry;
  } catch (err) {
    throw new Error(`adapter registry를 읽을 수 없습니다: ${err.message}`);
  }
}

function projectConfigFromRegistry(registry, scopeId) {
  return registry.projects?.[scopeId] || registry.scopes?.[scopeId] || null;
}

function targetConfigFromRegistry(registry, scopeId, targetType) {
  const project = projectConfigFromRegistry(registry, scopeId);
  return project?.targets?.[targetType] || null;
}

function normalizeCheckNames(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  return [String(value).trim()].filter(Boolean);
}

function normalizeRunChecks(value) {
  if (!value) return [];
  const checks = Array.isArray(value) ? value : [value];
  return checks.map((check, index) => {
    if (typeof check === "string") {
      return {
        name: check,
        command: check,
        args: [],
        timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS
      };
    }
    const args = Array.isArray(check.args) ? check.args.map(item => String(item)) : [];
    const timeoutMs = Number(check.timeoutMs || check.timeout_ms || DEFAULT_VERIFICATION_TIMEOUT_MS);
    return {
      name: String(check.name || check.id || check.command || `verification_check_${index + 1}`),
      id: check.id,
      command: check.command,
      args,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_VERIFICATION_TIMEOUT_MS
    };
  });
}

function normalizePipelinePolicy(policy = {}) {
  const requiredChecks = normalizeCheckNames(policy.requiredChecks || policy.required_checks);
  const minPassedChecks = Number(policy.minPassedChecks || policy.min_passed_checks || 0);
  return {
    required: normalizeBoolean(policy.required),
    requiredChecks,
    minPassedChecks: Number.isFinite(minPassedChecks) && minPassedChecks > 0 ? minPassedChecks : 0,
    runChecks: normalizeRunChecks(policy.runChecks || policy.run_checks)
  };
}

function normalizePostApplyPolicy(policy = {}) {
  const requiredChecks = normalizeCheckNames(policy.postApplyRequiredChecks || policy.post_apply_required_checks);
  const minPassedChecks = Number(policy.postApplyMinPassedChecks || policy.post_apply_min_passed_checks || 0);
  return {
    required: normalizeBoolean(policy.postApplyRequired || policy.post_apply_required),
    requiredChecks,
    minPassedChecks: Number.isFinite(minPassedChecks) && minPassedChecks > 0 ? minPassedChecks : 0,
    runChecks: normalizeRunChecks(policy.postApplyRunChecks || policy.post_apply_run_checks)
  };
}

function resolveApplyPipelinePolicy(request, registry) {
  if (request.pipelinePolicy) return normalizePipelinePolicy(request.pipelinePolicy);
  if (request.requireVerification) {
    return {
      required: true,
      requiredChecks: [],
      minPassedChecks: 1,
      runChecks: normalizeRunChecks(request.pipelinePolicy?.runChecks || request.pipeline_policy?.run_checks)
    };
  }
  const project = projectConfigFromRegistry(registry, request.scopeId);
  return normalizePipelinePolicy(project?.applyPipeline || {});
}

function resolvePostApplyPipelinePolicy(request, registry) {
  if (request.pipelinePolicy) return normalizePostApplyPolicy(request.pipelinePolicy);
  const project = projectConfigFromRegistry(registry, request.scopeId);
  return normalizePostApplyPolicy(project?.applyPipeline || {});
}

function loadApplyVerification(request) {
  if (request.verification && typeof request.verification === "object") return request.verification;
  if (!request.verificationPath) return null;
  const verificationPath = path.resolve(request.verificationPath);
  try {
    return JSON.parse(fs.readFileSync(verificationPath, "utf-8"));
  } catch (err) {
    throw new Error(`apply verification을 읽을 수 없습니다: ${err.message}`);
  }
}

function loadPostApplyVerification(request) {
  if (request.postApplyVerification && typeof request.postApplyVerification === "object") return request.postApplyVerification;
  if (!request.postApplyVerificationPath) return null;
  const verificationPath = path.resolve(request.postApplyVerificationPath);
  try {
    return JSON.parse(fs.readFileSync(verificationPath, "utf-8"));
  } catch (err) {
    throw new Error(`post-apply verification을 읽을 수 없습니다: ${err.message}`);
  }
}

function normalizeApplyVerification(verification) {
  if (!verification) return null;
  if (Array.isArray(verification)) {
    return {
      schemaVersion: APPLY_VERIFICATION_SCHEMA_VERSION,
      checks: verification
    };
  }
  return {
    ...verification,
    schemaVersion: verification.schemaVersion || APPLY_VERIFICATION_SCHEMA_VERSION,
    checks: Array.isArray(verification.checks) ? verification.checks : []
  };
}

function truncateEvidence(value) {
  const text = String(value || "").trim();
  if (text.length <= MAX_VERIFICATION_EVIDENCE_LENGTH) return text;
  return `${text.slice(0, MAX_VERIFICATION_EVIDENCE_LENGTH)}...<truncated>`;
}

function commandDisplay(command, args = []) {
  return [command, ...args].filter(Boolean).join(" ");
}

function runVerificationChecks(projectRoot, runChecks, request = {}, missingEvidence) {
  if (runChecks.length === 0) {
    return {
      schemaVersion: APPLY_VERIFICATION_SCHEMA_VERSION,
      generatedBy: "project-promotion-consumer",
      checks: [{
        name: "verification runner",
        command: "",
        status: "failed",
        evidence: missingEvidence
      }]
    };
  }
  const defaultTimeoutMs = Number(request.verificationTimeoutMs || DEFAULT_VERIFICATION_TIMEOUT_MS);
  const checks = runChecks.map(check => {
    const startedAt = Date.now();
    if (!check.command) {
      return {
        name: check.name,
        command: "",
        status: "failed",
        durationMs: 0,
        evidence: "runCheck.command가 필요합니다."
      };
    }
    const timeoutMs = check.timeoutMs || (Number.isFinite(defaultTimeoutMs) && defaultTimeoutMs > 0
      ? defaultTimeoutMs
      : DEFAULT_VERIFICATION_TIMEOUT_MS);
    const result = spawnSync(String(check.command), check.args || [], {
      cwd: projectRoot,
      encoding: "utf-8",
      shell: false,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    const durationMs = Date.now() - startedAt;
    const evidenceParts = [];
    if (result.stdout) evidenceParts.push(`stdout:\n${result.stdout}`);
    if (result.stderr) evidenceParts.push(`stderr:\n${result.stderr}`);
    if (result.error) evidenceParts.push(`error: ${result.error.message}`);
    const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM";
    const exitCode = typeof result.status === "number" ? result.status : null;
    const status = !result.error && exitCode === 0 ? "passed" : "failed";
    return {
      name: check.name,
      id: check.id,
      command: commandDisplay(check.command, check.args),
      status,
      exitCode,
      signal: result.signal || null,
      timedOut,
      durationMs,
      evidence: truncateEvidence(evidenceParts.join("\n\n"))
    };
  });
  return {
    schemaVersion: APPLY_VERIFICATION_SCHEMA_VERSION,
    generatedBy: "project-promotion-consumer",
    generatedAt: isoNow(),
    checks
  };
}

function runApplyVerificationChecks(projectRoot, policy, request = {}) {
  const normalizedPolicy = normalizePipelinePolicy(policy);
  return runVerificationChecks(
    projectRoot,
    policy.runChecks || normalizedPolicy.runChecks || [],
    request,
    "runVerification=true 이지만 applyPipeline.runChecks가 없습니다."
  );
}

function runPostApplyVerificationChecks(projectRoot, policy, request = {}) {
  const normalizedPolicy = normalizePostApplyPolicy(policy);
  return runVerificationChecks(
    projectRoot,
    policy.runChecks || normalizedPolicy.runChecks || [],
    request,
    "runVerification=true 이지만 applyPipeline.postApplyRunChecks가 없습니다."
  );
}

function checkIdentity(check) {
  return String(check.name || check.command || check.id || "unnamed_check").trim();
}

function normalizeCheckStatus(check) {
  return String(check.status || "").trim().toLowerCase();
}

function checkMatchesRequirement(check, requirement) {
  return check.name === requirement || check.command === requirement || check.id === requirement;
}

function evaluateApplyPipelineGate(policy, verificationInput) {
  const normalizedPolicy = normalizePipelinePolicy(policy);
  const verification = normalizeApplyVerification(verificationInput);
  const base = {
    required: normalizedPolicy.required,
    status: normalizedPolicy.required ? "missing" : "not_required",
    schemaVersion: APPLY_VERIFICATION_SCHEMA_VERSION,
    requiredChecks: normalizedPolicy.requiredChecks,
    minPassedChecks: normalizedPolicy.minPassedChecks,
    checks: [],
    passedChecks: [],
    failedChecks: [],
    missingChecks: [],
    reasons: []
  };
  if (!normalizedPolicy.required) return base;
  const checks = verification?.checks || [];
  const checkSummaries = checks.map(check => ({
    name: checkIdentity(check),
    command: check.command || "",
    status: normalizeCheckStatus(check),
    exitCode: typeof check.exitCode === "number" ? check.exitCode : null,
    durationMs: typeof check.durationMs === "number" ? check.durationMs : null,
    evidence: truncateEvidence(check.evidence || "")
  }));
  const withChecks = {
    ...base,
    checks: checkSummaries
  };
  if (checks.length === 0) {
    return {
      ...withChecks,
      reasons: ["verification_required"]
    };
  }
  const failedChecks = checks.filter(check => FAILED_CHECK_STATUSES.has(normalizeCheckStatus(check)));
  if (failedChecks.length > 0) {
    return {
      ...withChecks,
      status: "failed",
      failedChecks: failedChecks.map(checkIdentity),
      reasons: failedChecks.map(check => `verification_check_failed:${checkIdentity(check)}`)
    };
  }
  const passedChecks = checks.filter(check => PASSED_CHECK_STATUSES.has(normalizeCheckStatus(check)));
  const requiredChecks = normalizedPolicy.requiredChecks;
  if (requiredChecks.length > 0) {
    const missingChecks = requiredChecks.filter(requirement => {
      return !passedChecks.some(check => checkMatchesRequirement(check, requirement));
    });
    if (missingChecks.length > 0) {
      return {
        ...withChecks,
        passedChecks: passedChecks.map(checkIdentity),
        missingChecks,
        reasons: missingChecks.map(check => `verification_check_missing:${check}`)
      };
    }
  }
  const minPassedChecks = normalizedPolicy.minPassedChecks || (requiredChecks.length === 0 ? 1 : 0);
  if (passedChecks.length < minPassedChecks) {
    return {
      ...withChecks,
      passedChecks: passedChecks.map(checkIdentity),
      reasons: ["verification_min_passed_not_met"]
    };
  }
  return {
    ...withChecks,
    status: "passed",
    passedChecks: passedChecks.map(checkIdentity)
  };
}

function defaultTargetConfig(targetType) {
  const fileByType = {
    capability_registry: "capabilities.jsonl",
    playbook: "playbooks.jsonl",
    workflow: "workflows.jsonl",
    workflow_backlog: "workflow-backlog.jsonl"
  };
  const fileName = fileByType[targetType];
  if (!fileName) return null;
  return {
    path: path.join(".brain-growth", fileName),
    format: "jsonl",
    mode: targetType === "workflow_backlog" ? "append" : "upsert",
    key: targetType === "playbook" ? "promotionId" : "id",
    native: false
  };
}

function targetPathFromConfig(projectRoot, config) {
  if (!config?.path) throw new Error("adapter registry target path가 필요합니다.");
  const targetPath = path.isAbsolute(config.path)
    ? path.resolve(config.path)
    : path.resolve(projectRoot, config.path);
  assertInsideProjectRoot(projectRoot, targetPath);
  return targetPath;
}

function payloadForPromotion(promotion) {
  if (promotion.target?.targetType === "capability_registry") return promotion.payload?.capability || {};
  if (promotion.target?.targetType === "playbook") return promotion.payload?.playbook || {};
  if (promotion.target?.targetType === "workflow") return promotion.payload?.workflow || {};
  if (promotion.target?.targetType === "workflow_backlog") return promotion.payload?.workflow || promotion.payload || {};
  return promotion.payload || {};
}

function defaultCollectionName(targetType) {
  if (targetType === "capability_registry") return "capabilities";
  if (targetType === "playbook") return "playbooks";
  if (targetType === "workflow" || targetType === "workflow_backlog") return "workflows";
  return "promotions";
}

function hasDraftPayload(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasDraftPayload);
  return Object.entries(value).some(([key, child]) => {
    if ((key === "draftText" || key === "rawDraft") && typeof child === "string" && child.trim()) return true;
    return hasDraftPayload(child);
  });
}

function resolveProjectPromotionTarget(projectRoot, promotion, registry = null) {
  if (!promotion || promotion.status !== "ready_for_project_consumer") {
    return {
      blocked: true,
      reason: "promotion_not_ready_for_project_consumer"
    };
  }
  const targetType = promotion.target?.targetType || "unknown";
  const registryConfig = registry ? targetConfigFromRegistry(registry, promotion.scopeId, targetType) : null;
  const targetConfig = registryConfig || defaultTargetConfig(targetType);
  if (!targetConfig) {
    return {
      blocked: true,
      reason: `unknown_target_type:${targetType}`,
      targetType
    };
  }
  let targetPath;
  try {
    targetPath = targetPathFromConfig(projectRoot, targetConfig);
  } catch (err) {
    return {
      blocked: true,
      reason: err.message,
      targetType
    };
  }
  const format = targetConfig.format || "jsonl";
  if (!SUPPORTED_ADAPTER_FORMATS.has(format)) {
    return {
      blocked: true,
      reason: `unsupported_adapter_format:${format}`,
      targetType
    };
  }
  return {
    blocked: false,
    targetType,
    targetPath,
    action: targetConfig.mode || (targetType === "workflow_backlog" ? "append_backlog" : "upsert"),
    format,
    key: targetConfig.key || (targetType === "playbook" ? "promotionId" : "id"),
    exportName: targetConfig.exportName || targetConfig.export_name || defaultCollectionName(targetType),
    collectionKey: targetConfig.collectionKey || targetConfig.collection_key || defaultCollectionName(targetType),
    native: !!registryConfig
  };
}

function buildChange(request, promotion, registry) {
  if (promotion.scopeId !== request.scopeId) {
    return {
      blocked: {
        promotionId: promotion.promotionId,
        reason: "scope_mismatch",
        expectedScopeId: request.scopeId,
        actualScopeId: promotion.scopeId
      }
    };
  }
  if (hasDraftPayload(promotion.payload)) {
    return {
      blocked: {
        promotionId: promotion.promotionId,
        reason: "draft_payload_not_allowed"
      }
    };
  }
  const target = resolveProjectPromotionTarget(request.projectRoot, promotion, registry);
  if (target.blocked) {
    return {
      blocked: {
        promotionId: promotion.promotionId,
        reason: target.reason,
        targetType: target.targetType
      }
    };
  }
  const payload = payloadForPromotion(promotion);
  return {
    change: {
      promotionId: promotion.promotionId,
      proposalId: promotion.proposalId,
      scopeId: promotion.scopeId,
      candidateType: promotion.candidateType,
      title: promotion.title,
      targetType: target.targetType,
      action: target.action,
      format: target.format,
      key: target.key,
      exportName: target.exportName,
      collectionKey: target.collectionKey,
      native: target.native,
      path: target.targetPath,
      relativePath: path.relative(request.projectRoot, target.targetPath),
      payload,
      evidenceRefs: promotion.evidenceRefs || []
    }
  };
}

function findPromotions(brainRoot, request) {
  if (request.exportPacket && Array.isArray(request.exportPacket.promotions)) {
    let promotions = request.exportPacket.promotions;
    if (request.candidateType) {
      promotions = promotions.filter(promotion => promotion.candidateType === request.candidateType);
    }
    if (request.promotionId) {
      promotions = promotions.filter(promotion => promotion.promotionId === request.promotionId);
    }
    return promotions;
  }
  const packet = listProjectPromotionExports(brainRoot, {
    scopeId: request.scopeId,
    candidateType: request.candidateType
  });
  let promotions = packet.promotions;
  if (request.promotionId) {
    promotions = promotions.filter(promotion => promotion.promotionId === request.promotionId);
  }
  return promotions;
}

function listAppliedConsumptionRecords(brainRoot, scopeId) {
  return readJsonl(projectPromotionConsumptionsPath(brainRoot))
    .filter(record => record.scopeId === scopeId && record.status === "applied");
}

function buildProjectPromotionPreview(brainRoot, requestInput = {}) {
  const request = ensureRequest(requestInput);
  const registry = loadProjectAdapterRegistry(brainRoot, request);
  const pipelinePolicy = resolveApplyPipelinePolicy(request, registry);
  const postApplyPolicy = resolvePostApplyPipelinePolicy(request, registry);
  const pipelineGate = evaluateApplyPipelineGate(pipelinePolicy, loadApplyVerification(request));
  const postApplyGate = evaluateApplyPipelineGate(postApplyPolicy, loadPostApplyVerification(request));
  const promotions = findPromotions(brainRoot, request);
  const applied = new Set(listAppliedConsumptionRecords(brainRoot, request.scopeId).map(record => record.promotionId));
  const changes = [];
  const blocked = [];
  for (const promotion of promotions) {
    if (applied.has(promotion.promotionId)) {
      blocked.push({
        promotionId: promotion.promotionId,
        reason: "already_consumed"
      });
      continue;
    }
    const result = buildChange(request, promotion, registry);
    if (result.blocked) blocked.push(result.blocked);
    if (result.change) changes.push(result.change);
  }
  const evidenceRefs = Array.from(new Set(changes.flatMap(change => change.evidenceRefs || [])));
  let status = "preview_ready";
  if (changes.length === 0 && blocked.length === 0) status = "empty";
  else if (changes.length === 0 && blocked.length > 0) status = blocked.every(item => item.reason === "already_consumed")
    ? "already_consumed"
    : "blocked";
  return {
    schemaVersion: CONSUMPTION_SCHEMA_VERSION,
    scopeId: request.scopeId,
    mode: request.mode,
    status,
    requiresApproval: request.mode !== "apply",
    requiresVerification: pipelineGate.required,
    requiresPostApplyVerification: postApplyGate.required,
    pipelineGate,
    postApplyGate,
    projectRoot: request.projectRoot,
    changes,
    blocked,
    evidenceRefs,
    generatedAt: isoNow()
  };
}

function upsertJsonlRecord(filePath, record, idKey) {
  ensureDir(path.dirname(filePath));
  const records = readJsonl(filePath);
  const index = records.findIndex(item => item[idKey] === record[idKey]);
  if (index >= 0) records[index] = { ...records[index], ...record };
  else records.push(record);
  writeJsonl(filePath, records);
}

function readJsonArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) throw new Error(`JSON array 파일이 아닙니다: ${filePath}`);
  return parsed;
}

function upsertJsonArrayRecord(filePath, record, idKey) {
  ensureDir(path.dirname(filePath));
  const records = readJsonArray(filePath);
  const index = records.findIndex(item => item[idKey] === record[idKey]);
  if (index >= 0) records[index] = { ...records[index], ...record };
  else records.push(record);
  fs.writeFileSync(filePath, `${JSON.stringify(records, null, 2)}\n`, "utf-8");
}

function renderMarkdownPromotionSection(record) {
  const title = record.title || record.summary || record.rule || record.id || record.promotionId;
  const lines = [
    `<!-- brain-promotion:${record.promotionId} -->`,
    `## ${title}`,
    "",
    `- promotionId: ${record.promotionId}`,
    `- proposalId: ${record.proposalId || ""}`,
    `- targetType: ${record.targetType}`,
    `- summary: ${record.summary || record.rule || ""}`,
    `- sourceRefs: ${(record.sourceRefs || []).join(", ")}`,
    `- consumedAt: ${record.consumedAt}`,
    "<!-- /brain-promotion -->",
    ""
  ];
  return lines.join("\n");
}

function upsertMarkdownPromotionSection(filePath, record) {
  ensureDir(path.dirname(filePath));
  const nextSection = renderMarkdownPromotionSection(record);
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
  const marker = `<!-- brain-promotion:${record.promotionId} -->`;
  const endMarker = "<!-- /brain-promotion -->";
  const start = existing.indexOf(marker);
  if (start < 0) {
    const separator = existing && !existing.endsWith("\n") ? "\n\n" : "";
    fs.writeFileSync(filePath, `${existing}${separator}${nextSection}`, "utf-8");
    return;
  }
  const end = existing.indexOf(endMarker, start);
  if (end < 0) throw new Error(`markdown promotion section 종료 marker가 없습니다: ${filePath}`);
  const afterEnd = end + endMarker.length;
  const suffixStart = existing[afterEnd] === "\n" ? afterEnd + 1 : afterEnd;
  const nextContent = `${existing.slice(0, start)}${nextSection}${existing.slice(suffixStart)}`;
  fs.writeFileSync(filePath, nextContent, "utf-8");
}

function safeIdentifier(value, fallback) {
  const name = String(value || fallback || "").trim();
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return name;
  throw new Error(`TypeScript exportName은 식별자여야 합니다: ${value}`);
}

function safeYamlKey(value, fallback) {
  const key = String(value || fallback || "").trim();
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) return key;
  throw new Error(`YAML collectionKey는 안전한 키여야 합니다: ${value}`);
}

function managedBlockMarkers(commentPrefix, name) {
  return {
    start: `${commentPrefix} brain-promotion-managed:start ${name}`,
    records: `${commentPrefix} brain-promotion-records:`,
    end: `${commentPrefix} brain-promotion-managed:end ${name}`
  };
}

function readManagedRecords(existing, markers) {
  const start = existing.indexOf(markers.start);
  if (start < 0) return [];
  const end = existing.indexOf(markers.end, start);
  if (end < 0) throw new Error(`promotion managed block 종료 marker가 없습니다: ${markers.end}`);
  const block = existing.slice(start, end);
  const line = block.split(/\r?\n/).find(item => item.trim().startsWith(markers.records));
  if (!line) return [];
  const json = line.trim().slice(markers.records.length).trim();
  if (!json) return [];
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("promotion managed records는 JSON array여야 합니다.");
  return parsed;
}

function replaceManagedBlock(existing, markers, nextBlock) {
  const start = existing.indexOf(markers.start);
  if (start < 0) {
    const separator = existing && !existing.endsWith("\n") ? "\n\n" : "";
    return `${existing}${separator}${nextBlock}`;
  }
  const end = existing.indexOf(markers.end, start);
  if (end < 0) throw new Error(`promotion managed block 종료 marker가 없습니다: ${markers.end}`);
  const afterEnd = end + markers.end.length;
  const suffixStart = existing[afterEnd] === "\n" ? afterEnd + 1 : afterEnd;
  return `${existing.slice(0, start)}${nextBlock}${existing.slice(suffixStart)}`;
}

function upsertManagedRecord(records, record, idKey) {
  const index = records.findIndex(item => item?.[idKey] === record[idKey]);
  if (index >= 0) records[index] = { ...records[index], ...record };
  else records.push(record);
  return records;
}

function renderTypeScriptManagedBlock(exportName, records) {
  const markers = managedBlockMarkers("//", exportName);
  return [
    markers.start,
    `${markers.records} ${JSON.stringify(records)}`,
    `export const ${exportName} = ${JSON.stringify(records, null, 2)};`,
    markers.end,
    ""
  ].join("\n");
}

function loadEspreeParser() {
  try {
    return require("espree");
  } catch {
    return null;
  }
}

function astKeyName(key) {
  if (!key) return null;
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal") return String(key.value);
  return null;
}

function astLiteralValue(node) {
  if (!node) return undefined;
  if (node.type === "Literal") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map(quasi => quasi.value.cooked).join("");
  }
  if (node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+")) {
    const value = astLiteralValue(node.argument);
    return typeof value === "number" ? Number(`${node.operator}${value}`) : undefined;
  }
  if (node.type === "ArrayExpression") {
    const values = [];
    for (const element of node.elements) {
      const value = astLiteralValue(element);
      if (value === undefined) return undefined;
      values.push(value);
    }
    return values;
  }
  if (node.type === "ObjectExpression") {
    const value = {};
    for (const property of node.properties) {
      if (property.type !== "Property" || property.computed) return undefined;
      const key = astKeyName(property.key);
      if (!key) return undefined;
      const child = astLiteralValue(property.value);
      if (child === undefined) return undefined;
      value[key] = child;
    }
    return value;
  }
  return undefined;
}

function findTypeScriptExportArray(existing, exportName) {
  const parser = loadEspreeParser();
  if (!parser) return null;
  let ast;
  try {
    ast = parser.parse(existing, {
      ecmaVersion: "latest",
      sourceType: "module",
      range: true
    });
  } catch {
    return null;
  }
  for (const node of ast.body || []) {
    if (node.type !== "ExportNamedDeclaration") continue;
    const declaration = node.declaration;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const declarator of declaration.declarations || []) {
      if (declarator.id?.type !== "Identifier" || declarator.id.name !== exportName) continue;
      if (declarator.init?.type !== "ArrayExpression") continue;
      const records = astLiteralValue(declarator.init);
      if (!Array.isArray(records)) return null;
      return {
        range: node.range,
        records
      };
    }
  }
  return null;
}

function replaceTypeScriptBlock(existing, markers, nextBlock, adoptedExport) {
  if (existing.includes(markers.start)) {
    return replaceManagedBlock(existing, markers, nextBlock);
  }
  if (adoptedExport?.range) {
    const [start, end] = adoptedExport.range;
    const suffixStart = existing[end] === "\n" ? end + 1 : end;
    return `${existing.slice(0, start)}${nextBlock}${existing.slice(suffixStart)}`;
  }
  return replaceManagedBlock(existing, markers, nextBlock);
}

function upsertTypeScriptPromotionRecord(filePath, record, idKey, exportNameInput) {
  const exportName = safeIdentifier(exportNameInput, "promotions");
  ensureDir(path.dirname(filePath));
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
  const markers = managedBlockMarkers("//", exportName);
  const managedRecords = readManagedRecords(existing, markers);
  const adoptedExport = managedRecords.length === 0 ? findTypeScriptExportArray(existing, exportName) : null;
  const records = upsertManagedRecord(
    managedRecords.length > 0 ? managedRecords : adoptedExport?.records || [],
    record,
    idKey
  );
  const nextContent = replaceTypeScriptBlock(
    existing,
    markers,
    renderTypeScriptManagedBlock(exportName, records),
    adoptedExport
  );
  fs.writeFileSync(filePath, nextContent, "utf-8");
}

function yamlScalar(value) {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  if (/^[A-Za-z0-9_./:@-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function renderYamlValue(value, indent) {
  const space = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value.map(item => {
      if (item && typeof item === "object") {
        const rendered = renderYamlObject(item, indent + 2);
        return `${space}- ${rendered.trimStart()}`;
      }
      return `${space}- ${yamlScalar(item)}`;
    }).join("\n");
  }
  if (value && typeof value === "object") {
    return `\n${renderYamlObject(value, indent)}`;
  }
  return yamlScalar(value);
}

function renderYamlObject(value, indent) {
  const space = " ".repeat(indent);
  return Object.entries(value).map(([key, child]) => {
    if (Array.isArray(child)) {
      return child.length === 0
        ? `${space}${key}: []`
        : `${space}${key}:\n${renderYamlValue(child, indent + 2)}`;
    }
    if (child && typeof child === "object") {
      return `${space}${key}:${renderYamlValue(child, indent + 2)}`;
    }
    return `${space}${key}: ${yamlScalar(child)}`;
  }).join("\n");
}

function renderYamlManagedBlock(collectionKey, records) {
  const markers = managedBlockMarkers("#", collectionKey);
  const body = records.length === 0
    ? `${collectionKey}: []`
    : `${collectionKey}:\n${records.map(record => `  - ${renderYamlObject(record, 4).trimStart()}`).join("\n")}`;
  return [
    markers.start,
    `${markers.records} ${JSON.stringify(records)}`,
    body,
    markers.end,
    ""
  ].join("\n");
}

function loadYamlParser() {
  try {
    return require("js-yaml");
  } catch {
    return null;
  }
}

function plainYamlRecords(value) {
  if (!Array.isArray(value)) return null;
  if (!value.every(item => item && typeof item === "object" && !Array.isArray(item))) return null;
  return JSON.parse(JSON.stringify(value));
}

function findYamlCollection(existing, collectionKey) {
  const yaml = loadYamlParser();
  if (!yaml) return null;
  let parsed;
  try {
    parsed = yaml.load(existing);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const records = plainYamlRecords(parsed[collectionKey]);
  if (!records) return null;
  const range = findTopLevelYamlCollectionRange(existing, collectionKey);
  if (!range) return null;
  return {
    range,
    records
  };
}

function findTopLevelYamlCollectionRange(existing, collectionKey) {
  const lines = existing.match(/.*(?:\r?\n|$)/g).filter(line => line.length > 0);
  let offset = 0;
  let startOffset = -1;
  let endOffset = -1;
  const escapedKey = collectionKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyPattern = new RegExp(`^${escapedKey}\\s*:(?:\\s*.*)?$`);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const content = line.replace(/\r?\n$/, "");
    if (startOffset < 0) {
      if (keyPattern.test(content)) {
        startOffset = offset;
      }
    } else if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(content) && !/^\s/.test(content)) {
      endOffset = offset;
      break;
    }
    offset += line.length;
  }
  if (startOffset < 0) return null;
  if (endOffset < 0) endOffset = existing.length;
  return [startOffset, endOffset];
}

function replaceYamlBlock(existing, markers, nextBlock, adoptedCollection) {
  if (existing.includes(markers.start)) {
    return replaceManagedBlock(existing, markers, nextBlock);
  }
  if (adoptedCollection?.range) {
    const [start, end] = adoptedCollection.range;
    return `${existing.slice(0, start)}${nextBlock}${existing.slice(end)}`;
  }
  return replaceManagedBlock(existing, markers, nextBlock);
}

function upsertYamlPromotionRecord(filePath, record, idKey, collectionKeyInput) {
  const collectionKey = safeYamlKey(collectionKeyInput, "promotions");
  ensureDir(path.dirname(filePath));
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
  const markers = managedBlockMarkers("#", collectionKey);
  const hasManagedBlock = existing.includes(markers.start);
  const managedRecords = readManagedRecords(existing, markers);
  const adoptedCollection = !hasManagedBlock ? findYamlCollection(existing, collectionKey) : null;
  const records = upsertManagedRecord(
    hasManagedBlock ? managedRecords : adoptedCollection?.records || [],
    record,
    idKey
  );
  const nextContent = replaceYamlBlock(
    existing,
    markers,
    renderYamlManagedBlock(collectionKey, records),
    adoptedCollection
  );
  fs.writeFileSync(filePath, nextContent, "utf-8");
}

function writeNativePromotionRecord(change, record) {
  if (change.format === "jsonl") {
    upsertJsonlRecord(change.path, record, change.key || "id");
    return;
  }
  if (change.format === "json_array") {
    upsertJsonArrayRecord(change.path, record, change.key || "id");
    return;
  }
  if (change.format === "markdown") {
    upsertMarkdownPromotionSection(change.path, record);
    return;
  }
  if (change.format === "typescript" || change.format === "ts") {
    upsertTypeScriptPromotionRecord(change.path, record, change.key || "id", change.exportName);
    return;
  }
  if (change.format === "yaml" || change.format === "yml") {
    upsertYamlPromotionRecord(change.path, record, change.key || "id", change.collectionKey);
    return;
  }
  throw new Error(`지원하지 않는 adapter target format입니다: ${change.format}`);
}

function snapshotTargetFiles(changes) {
  const snapshots = new Map();
  for (const change of changes) {
    if (snapshots.has(change.path)) continue;
    snapshots.set(change.path, {
      path: change.path,
      existed: fs.existsSync(change.path),
      content: fs.existsSync(change.path) ? fs.readFileSync(change.path, "utf-8") : null
    });
  }
  return snapshots;
}

function restoreTargetSnapshots(snapshots) {
  const restored = [];
  for (const snapshot of snapshots.values()) {
    if (snapshot.existed) {
      ensureDir(path.dirname(snapshot.path));
      fs.writeFileSync(snapshot.path, snapshot.content, "utf-8");
    } else if (fs.existsSync(snapshot.path)) {
      fs.rmSync(snapshot.path, { force: true });
    }
    restored.push(snapshot.path);
  }
  return restored;
}

function uniqueStrings(values) {
  return Array.from(new Set((values || []).filter(Boolean).map(value => String(value))));
}

function relativeProjectPath(projectRoot, filePath) {
  const relative = path.relative(projectRoot, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : filePath;
}

function createPostApplyRemediationSignal(brainRoot, request, preview, postApplyGate, rolledBackPaths) {
  const failedChecks = postApplyGate.failedChecks?.length > 0
    ? postApplyGate.failedChecks
    : postApplyGate.missingChecks || [];
  const checkSummary = failedChecks.length > 0 ? failedChecks.join(", ") : postApplyGate.status;
  const targetTypes = uniqueStrings(preview.changes.map(change => change.targetType));
  const promotionIds = uniqueStrings(preview.changes.map(change => change.promotionId));
  const rolledBackRefs = uniqueStrings(
    rolledBackPaths.map(item => `rolledBack:${relativeProjectPath(request.projectRoot, item)}`)
  );
  const checkRefs = uniqueStrings((postApplyGate.checks || []).map(check => {
    const name = check.name || check.command || "unnamed_check";
    return `postApplyCheck:${name}:${check.status || "unknown"}`;
  }));
  const evidenceRefs = uniqueStrings([
    ...(preview.evidenceRefs || []),
    ...promotionIds.map(id => `promotion:${id}`),
    ...checkRefs,
    ...rolledBackRefs
  ]);
  const summary = `Post-apply verification failed for ${request.scopeId}: ${checkSummary}`;

  return upsertGrowthSignal(brainRoot, {
    scopeId: request.scopeId,
    source: "project_promotion_consumer",
    failureType: "post_apply_verification_failed",
    summary,
    evidenceRefs,
    guardReasons: ["post_apply_verification_failed"],
    detectorStatus: "review_before_retry",
    detectorReasons: postApplyGate.reasons || [],
    recommendedUse: {
      requireReview: true,
      status: "review_before_retry"
    },
    suggestedFix: "post-apply verification 실패 원인을 확인하고 native target 또는 검증 명령을 보정한 뒤 다시 apply한다.",
    promotionCandidate: {
      candidateType: "playbook_patch",
      status: "candidate",
      reason: summary,
      evidenceRefs,
      createdFrom: "project_promotion_consumer",
      targetTypes,
      promotionIds
    }
  });
}

function appendConsumptionLog(brainRoot, request, preview, changedPaths) {
  const filePath = projectPromotionConsumptionsPath(brainRoot);
  ensureDir(path.dirname(filePath));
  const records = readJsonl(filePath);
  const createdAt = isoNow();
  const targetPromotionIds = [
    ...preview.changes.map(change => change.promotionId),
    ...preview.blocked.map(item => item.promotionId)
  ].filter(Boolean);
  const promotionId = targetPromotionIds[0] || request.promotionId || null;
  const record = {
    consumptionId: stableConsumptionId(request.scopeId, promotionId || "none", request.mode, createdAt),
    schemaVersion: CONSUMPTION_SCHEMA_VERSION,
    promotionId,
    promotionIds: Array.from(new Set(targetPromotionIds)),
    scopeId: request.scopeId,
    mode: request.mode,
    status: preview.status,
    targetType: preview.changes[0]?.targetType || preview.blocked[0]?.targetType || null,
    changedPaths,
    rolledBackPaths: preview.rolledBackPaths || [],
    evidenceRefs: preview.evidenceRefs || [],
    pipelineGate: preview.pipelineGate || null,
    postApplyGate: preview.postApplyGate || null,
    approvalId: request.approvalId || null,
    requestedBy: request.requestedBy,
    reason: request.reason,
    createdAt
  };
  records.push(record);
  writeJsonl(filePath, records);
  return record;
}

function applyProjectPromotionPreview(brainRoot, requestInput = {}) {
  const request = ensureRequest(requestInput);
  const registry = loadProjectAdapterRegistry(brainRoot, request);
  let preview = buildProjectPromotionPreview(brainRoot, request);
  if (preview.status === "already_consumed") {
    const log = appendConsumptionLog(brainRoot, request, preview, []);
    return { ...preview, mode: "apply", status: "already_consumed", requiresApproval: false, consumptionLog: log };
  }
  if (preview.status !== "preview_ready") {
    const log = appendConsumptionLog(brainRoot, request, preview, []);
    return { ...preview, mode: "apply", requiresApproval: false, consumptionLog: log };
  }
  if (preview.pipelineGate.required && preview.pipelineGate.status !== "passed" && request.runVerification) {
    const pipelinePolicy = resolveApplyPipelinePolicy(request, registry);
    request.verification = runApplyVerificationChecks(request.projectRoot, pipelinePolicy, request);
    preview = buildProjectPromotionPreview(brainRoot, request);
  }
  if (preview.pipelineGate.required && preview.pipelineGate.status !== "passed") {
    const gateStatus = preview.pipelineGate.status === "failed" ? "verification_failed" : "verification_required";
    const blockedPreview = {
      ...preview,
      mode: "apply",
      status: gateStatus,
      requiresApproval: false,
      blocked: [
        ...preview.blocked,
        {
          reason: gateStatus,
          pipelineGate: preview.pipelineGate
        }
      ]
    };
    const log = appendConsumptionLog(brainRoot, request, blockedPreview, []);
    return { ...blockedPreview, consumptionLog: log };
  }
  const postApplyPolicy = resolvePostApplyPipelinePolicy(request, registry);
  if (postApplyPolicy.required && !request.runVerification && preview.postApplyGate.status !== "passed") {
    const blockedPreview = {
      ...preview,
      mode: "apply",
      status: "post_verification_required",
      requiresApproval: false,
      blocked: [
        ...preview.blocked,
        {
          reason: "post_verification_required",
          postApplyGate: preview.postApplyGate
        }
      ]
    };
    const log = appendConsumptionLog(brainRoot, request, blockedPreview, []);
    return { ...blockedPreview, consumptionLog: log };
  }
  if (postApplyPolicy.required && request.runVerification && postApplyPolicy.runChecks.length === 0) {
    request.postApplyVerification = runPostApplyVerificationChecks(request.projectRoot, postApplyPolicy, request);
    preview = buildProjectPromotionPreview(brainRoot, request);
    const blockedPreview = {
      ...preview,
      mode: "apply",
      status: "post_verification_required",
      requiresApproval: false,
      blocked: [
        ...preview.blocked,
        {
          reason: "post_verification_required",
          postApplyGate: preview.postApplyGate
        }
      ]
    };
    const log = appendConsumptionLog(brainRoot, request, blockedPreview, []);
    return { ...blockedPreview, consumptionLog: log };
  }
  const changedPaths = [];
  const targetSnapshots = snapshotTargetFiles(preview.changes);
  for (const change of preview.changes) {
    assertInsideProjectRoot(request.projectRoot, change.path);
    const record = {
      ...change.payload,
      title: change.title,
      scopeId: change.scopeId,
      promotionId: change.promotionId,
      proposalId: change.proposalId,
      candidateType: change.candidateType,
      targetType: change.targetType,
      consumedAt: isoNow(),
      approvalId: request.approvalId,
      consumedBy: request.requestedBy
    };
    const idKey = change.key || (change.targetType === "playbook" ? "promotionId" : "id");
    if (!record[idKey]) record[idKey] = `${change.scopeId}.growth.${change.promotionId}`;
    writeNativePromotionRecord(change, record);
    changedPaths.push(change.path);
  }
  if (postApplyPolicy.required) {
    request.postApplyVerification = runPostApplyVerificationChecks(request.projectRoot, postApplyPolicy, request);
    const postApplyGate = evaluateApplyPipelineGate(postApplyPolicy, request.postApplyVerification);
    if (postApplyGate.status !== "passed") {
      const rolledBackPaths = restoreTargetSnapshots(targetSnapshots);
      const remediationSignal = createPostApplyRemediationSignal(
        brainRoot,
        request,
        preview,
        postApplyGate,
        rolledBackPaths
      );
      const failedPreview = {
        ...preview,
        mode: "apply",
        status: "post_verification_failed",
        requiresApproval: false,
        postApplyGate,
        remediationSignal,
        rolledBackPaths,
        changedPaths: [],
        blocked: [
          ...preview.blocked,
          {
            reason: "post_verification_failed",
            postApplyGate
          }
        ]
      };
      const log = appendConsumptionLog(brainRoot, request, failedPreview, []);
      return { ...failedPreview, consumptionLog: log };
    }
    preview = {
      ...preview,
      postApplyGate
    };
  }
  const appliedPreview = {
    ...preview,
    mode: "apply",
    status: "applied",
    requiresApproval: false,
    changedPaths
  };
  const log = appendConsumptionLog(brainRoot, request, appliedPreview, changedPaths);
  return {
    ...appliedPreview,
    consumptionLog: log
  };
}

function consumeProjectPromotionExport(brainRoot, requestInput = {}) {
  const request = ensureRequest(requestInput);
  if (request.mode === "apply") return applyProjectPromotionPreview(brainRoot, request);
  const preview = buildProjectPromotionPreview(brainRoot, request);
  const log = appendConsumptionLog(brainRoot, request, preview, []);
  return {
    ...preview,
    consumptionLog: log
  };
}

module.exports = {
  CONSUMPTION_SCHEMA_VERSION,
  ADAPTER_REGISTRY_SCHEMA_VERSION,
  APPLY_VERIFICATION_SCHEMA_VERSION,
  projectPromotionConsumptionsPath,
  projectAdapterRegistryPath,
  loadProjectAdapterRegistry,
  runApplyVerificationChecks,
  evaluateApplyPipelineGate,
  resolveProjectPromotionTarget,
  buildProjectPromotionPreview,
  applyProjectPromotionPreview,
  consumeProjectPromotionExport
};
