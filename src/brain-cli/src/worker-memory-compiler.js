"use strict";

const path = require("path");
const { isoNow, readJsonl } = require("./utils");

const PROFILE_VERSION = "1.0";
const SUPPORTED_RECORD_TYPES = new Set(["log", "decision", "rule"]);

const EVIDENCE_CLASS_RULES = [
  {
    evidenceClass: "quality_gate",
    pattern: /(test|tests|lint|build|smoke|검증|테스트|스모크|통과|증거|확인)/i
  },
  {
    evidenceClass: "decision_pattern",
    pattern: /(decision|decide|chosen|선택|결정|판단|이유|방향)/i
  },
  {
    evidenceClass: "anti_pattern",
    pattern: /(fail|failure|error|bug|blocked|reject|금지|실패|오류|버그|반려|누락|오염|stale)/i
  },
  {
    evidenceClass: "workflow_step",
    pattern: /(workflow|pipeline|step|procedure|protocol|절차|순서|단계|먼저|착수|완료 전)/i
  }
];

const TASK_TYPE_RULES = [
  { taskType: "design_verification", pattern: /(design|spec|review|verify|설계서|기획서|검증|검토)/i },
  { taskType: "implementation", pattern: /(implement|code|fix|build|구현|수정|코드|빌드)/i },
  { taskType: "documentation", pattern: /(doc|document|readme|changelog|문서|지시서|설계서)/i },
  { taskType: "operations", pattern: /(deploy|restart|pm2|server|운영|재시작|배포|서버)/i }
];

function recordsPath(brainRoot) {
  return path.join(brainRoot, "90_index", "records.jsonl");
}

function compileWorkerMemoryProfile(brainRoot, options = {}) {
  const workerId = options.workerId || "unknown";
  const records = Array.isArray(options.records)
    ? options.records
    : readJsonl(recordsPath(brainRoot));

  const targets = selectTargetRecords(records, options);
  const evidence = [];
  for (const record of targets) {
    evidence.push(...extractWorkerEvidence(record));
  }

  const usableEvidence = evidence.filter(item => item.sourceRef);
  const taskPatterns = buildTaskPatterns(usableEvidence);
  const decisionPatterns = buildPatternSummaries(usableEvidence, "decision_pattern", "decisionPattern");
  const workflowTemplates = buildWorkflowTemplates(usableEvidence);
  const antiPatterns = buildPatternSummaries(usableEvidence, "anti_pattern", "antiPattern");
  const qualityGates = buildQualityGates(usableEvidence);
  const openRisks = buildOpenRisks(evidence, options);

  return {
    workerId,
    profileVersion: PROFILE_VERSION,
    generatedAt: options.generatedAt || isoNow(),
    scope: {
      teamId: options.teamId || null,
      projectIds: normalizeArray(options.projectIds || options.scopeId),
      period: {
        from: options.from || null,
        to: options.to || null
      }
    },
    confidenceLevel: calculateConfidenceLevel({
      usableEvidenceCount: usableEvidence.length,
      workflowTemplateCount: workflowTemplates.length,
      qualityGateCount: qualityGates.length,
      confirmedEvidenceCount: usableEvidence.filter(item => item.strength === "confirmed").length
    }),
    taskPatterns,
    decisionPatterns,
    workflowTemplates,
    antiPatterns,
    qualityGates,
    evidence,
    openRisks
  };
}

function selectTargetRecords(records, options = {}) {
  const scopeIds = new Set(normalizeArray(options.scopeId || options.scopeIds));
  const projectIds = new Set(normalizeArray(options.projectIds));
  const allowedScopeIds = new Set([...scopeIds, ...projectIds]);
  const fromTime = options.from ? Date.parse(options.from) : null;
  const toTime = options.to ? Date.parse(options.to) : null;

  return records.filter(record => {
    if (!SUPPORTED_RECORD_TYPES.has(record.type)) return false;
    if (record.status && record.status !== "active") return false;
    if (allowedScopeIds.size > 0 && !allowedScopeIds.has(record.scopeId)) return false;
    if (fromTime || toTime) {
      const recordTime = Date.parse(record.updatedAt || "");
      if (Number.isNaN(recordTime)) return false;
      if (fromTime && recordTime < fromTime) return false;
      if (toTime && recordTime > toTime) return false;
    }
    return true;
  });
}

function extractWorkerEvidence(record) {
  const text = recordText(record);
  const taskType = inferTaskType(record);
  const classes = inferEvidenceClasses(record, text);

  return classes.map((evidenceClass, index) => ({
    evidenceId: buildEvidenceId(record, evidenceClass, index),
    sourceType: "brain_record",
    sourceRef: record.sourceRef || null,
    recordId: record.recordId || null,
    taskType,
    evidenceClass,
    summary: record.summary || record.title || "",
    strength: inferStrength(record),
    extractedAt: isoNow()
  }));
}

function inferEvidenceClasses(record, text = recordText(record)) {
  const classes = new Set(["task_pattern"]);
  if (record.type === "decision") classes.add("decision_pattern");
  if (record.type === "rule") classes.add("workflow_step");

  for (const rule of EVIDENCE_CLASS_RULES) {
    if (rule.pattern.test(text)) classes.add(rule.evidenceClass);
  }

  return Array.from(classes);
}

function inferTaskType(record) {
  const text = recordText(record);
  const matched = TASK_TYPE_RULES.find(rule => rule.pattern.test(text));
  return matched ? matched.taskType : "general_work";
}

function buildTaskPatterns(evidence) {
  const grouped = groupByTaskType(evidence);
  return Array.from(grouped.entries()).map(([taskType, items]) => ({
    taskType,
    count: items.length,
    sourceEvidenceIds: unique(items.map(item => item.evidenceId)),
    sourceRefs: unique(items.map(item => item.sourceRef))
  }));
}

function buildPatternSummaries(evidence, evidenceClass, idPrefix) {
  const targets = evidence.filter(item => item.evidenceClass === evidenceClass);
  const grouped = groupByTaskType(targets);
  return Array.from(grouped.entries()).map(([taskType, items], index) => ({
    patternId: `${idPrefix}_${taskType}_${String(index + 1).padStart(3, "0")}`,
    taskType,
    summary: summarizeItems(items),
    sourceEvidenceIds: unique(items.map(item => item.evidenceId)),
    sourceRefs: unique(items.map(item => item.sourceRef))
  }));
}

function buildWorkflowTemplates(evidence) {
  const targets = evidence.filter(item => item.evidenceClass === "workflow_step");
  const grouped = groupByTaskType(targets);
  return Array.from(grouped.entries()).map(([taskType, items], index) => ({
    templateId: `wwt_${taskType}_${String(index + 1).padStart(3, "0")}`,
    taskType,
    name: `${taskType} workflow`,
    orderedSteps: items.slice(0, 5).map((item, stepIndex) => ({
      stepId: `${taskType}_step_${String(stepIndex + 1).padStart(2, "0")}`,
      instruction: item.summary,
      requiredEvidence: item.evidenceClass === "quality_gate" ? ["test_output"] : ["source_ref"]
    })),
    sourceEvidenceIds: unique(items.map(item => item.evidenceId)),
    sourceRefs: unique(items.map(item => item.sourceRef))
  }));
}

function buildQualityGates(evidence) {
  const targets = evidence.filter(item => item.evidenceClass === "quality_gate");
  const grouped = groupByTaskType(targets);
  return Array.from(grouped.entries()).map(([taskType, items], index) => ({
    gateId: `wqg_${taskType}_${String(index + 1).padStart(3, "0")}`,
    taskType,
    checks: items.slice(0, 5).map((item, checkIndex) => ({
      checkId: `${taskType}_check_${String(checkIndex + 1).padStart(2, "0")}`,
      description: item.summary,
      required: true,
      passEvidence: ["test_output", "source_ref"]
    })),
    minimumVerdict: "revise_required",
    sourceEvidenceIds: unique(items.map(item => item.evidenceId)),
    sourceRefs: unique(items.map(item => item.sourceRef))
  }));
}

function calculateConfidenceLevel(stats = {}) {
  if (stats.usableEvidenceCount < 3) return "L0";
  if (stats.usableEvidenceCount < 6) return "L1";
  if (stats.confirmedEvidenceCount >= 10 && stats.qualityGateCount >= 3) return "L4";
  if (stats.workflowTemplateCount > 0 && stats.qualityGateCount > 0 && stats.usableEvidenceCount >= 10) return "L3";
  if (stats.workflowTemplateCount > 0 && stats.usableEvidenceCount >= 6) return "L2";
  return "L1";
}

function buildOpenRisks(evidence, options = {}) {
  const risks = [];
  if (evidence.length === 0) {
    risks.push("컴파일 대상 기록이 없습니다.");
  }
  const missingSourceRefCount = evidence.filter(item => !item.sourceRef).length;
  if (missingSourceRefCount > 0) {
    risks.push(`sourceRef 없는 evidence ${missingSourceRefCount}건은 profile aggregate에서 제외했습니다.`);
  }
  if (!options.workerId) {
    risks.push("workerId가 지정되지 않아 unknown으로 생성했습니다.");
  }
  return risks;
}

function inferStrength(record) {
  if (record.sourceType === "user_confirmed") return "confirmed";
  if (record.sourceRef) return "medium";
  return "weak";
}

function buildEvidenceId(record, evidenceClass, index) {
  const base = record.recordId || "unknown_record";
  return `wev_${base}_${evidenceClass}_${String(index + 1).padStart(2, "0")}`;
}

function groupByTaskType(evidence) {
  const grouped = new Map();
  for (const item of evidence) {
    const key = item.taskType || "general_work";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  return grouped;
}

function summarizeItems(items) {
  if (items.length === 0) return "";
  return items[0].summary || "";
}

function recordText(record = {}) {
  const tags = Array.isArray(record.tags) ? record.tags.join(" ") : "";
  return `${record.type || ""} ${record.title || ""} ${record.summary || ""} ${tags}`;
}

function normalizeArray(value) {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value];
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

module.exports = {
  PROFILE_VERSION,
  compileWorkerMemoryProfile,
  selectTargetRecords,
  extractWorkerEvidence,
  inferEvidenceClasses,
  inferTaskType,
  calculateConfidenceLevel
};
