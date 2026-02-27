"use strict";

// records.jsonl v1 스키마 (14개 필드)
const RECORD_FIELDS = [
  "recordId", "scopeType", "scopeId", "type", "title",
  "summary", "tags", "sourceType", "sourceRef", "status",
  "replacedBy", "deprecationReason", "updatedAt", "contentHash"
];

const SCOPE_TYPES = ["project", "agent", "user", "topic"];
const RECORD_TYPES = ["rule", "decision", "profile", "log", "ref", "note", "candidate", "reminder", "project_state"];
const SOURCE_TYPES = ["user_confirmed", "candidate", "chat_log", "external_doc", "inference"];
const STATUS_VALUES = ["active", "deprecated", "archived"];

const SCOPE_ABBREV = {
  project: "proj",
  agent: "agent",
  user: "user",
  topic: "topic"
};

const RECORD_ID_REGEX = /^rec_(proj|agent|user|topic)_[a-z0-9_-]+_\d{8}_\d{4}$/;

const INTENT_ACTIONS = ["create", "update", "delete", "deprecate"];

/**
 * records.jsonl 레코드 1건을 검증한다.
 * @param {Object} record
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateRecord(record) {
  const errors = [];

  // 필수 필드 존재 확인
  for (const field of RECORD_FIELDS) {
    if (!(field in record)) {
      errors.push(`필수 필드 누락: ${field}`);
    }
  }

  if (errors.length > 0) return { valid: false, errors };

  // recordId 형식
  if (!RECORD_ID_REGEX.test(record.recordId)) {
    errors.push(`recordId 형식 오류: ${record.recordId} (expected: rec_{scope}_{id}_{YYYYMMDD}_{NNNN})`);
  }

  // enum 값 검증
  if (!SCOPE_TYPES.includes(record.scopeType)) {
    errors.push(`scopeType 값 오류: ${record.scopeType} (allowed: ${SCOPE_TYPES.join(", ")})`);
  }
  if (!RECORD_TYPES.includes(record.type)) {
    errors.push(`type 값 오류: ${record.type} (allowed: ${RECORD_TYPES.join(", ")})`);
  }
  if (!SOURCE_TYPES.includes(record.sourceType)) {
    errors.push(`sourceType 값 오류: ${record.sourceType} (allowed: ${SOURCE_TYPES.join(", ")})`);
  }
  if (!STATUS_VALUES.includes(record.status)) {
    errors.push(`status 값 오류: ${record.status} (allowed: ${STATUS_VALUES.join(", ")})`);
  }

  // tags 배열 확인
  if (!Array.isArray(record.tags)) {
    errors.push("tags는 배열이어야 합니다");
  }

  // deprecated 시 replacedBy 필수
  if (record.status === "deprecated" && (record.replacedBy === null || record.replacedBy === undefined)) {
    errors.push("deprecated 상태에서 replacedBy는 필수입니다");
  }

  // obsolete 시 deprecationReason 필수
  if (record.replacedBy === "obsolete" && !record.deprecationReason) {
    errors.push("replacedBy=obsolete일 때 deprecationReason은 필수입니다");
  }

  // contentHash 형식
  if (record.contentHash && !record.contentHash.startsWith("sha256:")) {
    errors.push(`contentHash 형식 오류: sha256: 접두사 필요`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Intent JSON을 검증한다.
 * @param {Object} intent
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateIntent(intent) {
  const errors = [];

  if (!intent.action || !INTENT_ACTIONS.includes(intent.action)) {
    errors.push(`action 값 오류: ${intent.action} (allowed: ${INTENT_ACTIONS.join(", ")})`);
    return { valid: false, errors };
  }

  switch (intent.action) {
    case "create":
      if (!intent.record) errors.push("create 시 record 필드 필수");
      if (!intent.sourceRef) errors.push("create 시 sourceRef 필드 필수");
      if (intent.content === undefined && intent.content !== "") errors.push("create 시 content 필드 필수");
      if (intent.record) {
        if (!intent.record.scopeType) errors.push("record.scopeType 필수");
        if (!intent.record.scopeId) errors.push("record.scopeId 필수");
        if (!intent.record.type) errors.push("record.type 필수");
        if (!intent.record.title) errors.push("record.title 필수");
        if (!intent.record.sourceType) errors.push("record.sourceType 필수");
      }
      break;
    case "update":
      if (!intent.recordId) errors.push("update 시 recordId 필드 필수");
      break;
    case "delete":
      if (!intent.recordId) errors.push("delete 시 recordId 필드 필수");
      break;
    case "deprecate":
      if (!intent.recordId) errors.push("deprecate 시 recordId 필드 필수");
      if (intent.replacedBy === undefined) errors.push("deprecate 시 replacedBy 필드 필수");
      break;
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  RECORD_FIELDS,
  SCOPE_TYPES,
  RECORD_TYPES,
  SOURCE_TYPES,
  STATUS_VALUES,
  SCOPE_ABBREV,
  RECORD_ID_REGEX,
  INTENT_ACTIONS,
  validateRecord,
  validateIntent
};
