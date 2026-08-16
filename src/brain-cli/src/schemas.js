"use strict";

// records.jsonl v1 스키마 (14개 필드)
const RECORD_FIELDS = [
  "recordId", "scopeType", "scopeId", "type", "title",
  "summary", "tags", "sourceType", "sourceRef", "status",
  "replacedBy", "deprecationReason", "updatedAt", "contentHash"
];

// v3.1 선택 필드: 기존 레코드에는 없어도 된다.
const OPTIONAL_RECORD_FIELDS = ["originalChunk"];
const ORIGINAL_CHUNK_MAX_LENGTH = 2000;

const SCOPE_TYPES = ["project", "agent", "user", "topic"];
const RECORD_TYPES = ["rule", "decision", "profile", "log", "ref", "note", "candidate", "reminder", "project_state", "meta_strategy", "wiki"];
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

  const originalChunkErrors = validateOriginalChunk(record.originalChunk, "record.originalChunk", { optional: true });
  errors.push(...originalChunkErrors);

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

  if ((intent.action === "create" || intent.action === "update") && intent.record !== undefined) {
    errors.push(...validateIntentRecord(intent.record));
  }

  if ((intent.action === "create" || intent.action === "update") && intent.sourceRef) {
    const sourceRefErrors = validateSourceRef(intent.sourceRef);
    errors.push(...sourceRefErrors);
  }

  errors.push(...validateOriginalChunk(intent.originalChunk, "originalChunk", { optional: true }));

  // links 검증 (optional, create/update 시)
  if (intent.links !== undefined && (intent.action === "create" || intent.action === "update")) {
    if (!Array.isArray(intent.links)) {
      errors.push("links는 배열이어야 합니다");
    } else {
      const { LINK_TYPES } = require("./links");
      for (let i = 0; i < intent.links.length; i++) {
        const link = intent.links[i];
        if (!link.toId) errors.push(`links[${i}]: toId 필수`);
        if (!link.linkType || !LINK_TYPES.includes(link.linkType)) {
          errors.push(`links[${i}]: linkType 오류 (allowed: ${LINK_TYPES.join(", ")})`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateIntentRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return ["record는 객체여야 합니다"];
  }

  const errors = [];
  if (Object.prototype.hasOwnProperty.call(record, "scopeType") && !SCOPE_TYPES.includes(record.scopeType)) {
    errors.push(`record.scopeType 값 오류: ${record.scopeType} (allowed: ${SCOPE_TYPES.join(", ")})`);
  }
  if (Object.prototype.hasOwnProperty.call(record, "type") && !RECORD_TYPES.includes(record.type)) {
    errors.push(`record.type 값 오류: ${record.type} (allowed: ${RECORD_TYPES.join(", ")})`);
  }
  if (Object.prototype.hasOwnProperty.call(record, "sourceType") && !SOURCE_TYPES.includes(record.sourceType)) {
    errors.push(`record.sourceType 값 오류: ${record.sourceType} (allowed: ${SOURCE_TYPES.join(", ")})`);
  }
  if (Object.prototype.hasOwnProperty.call(record, "status") && !STATUS_VALUES.includes(record.status)) {
    errors.push(`record.status 값 오류: ${record.status} (allowed: ${STATUS_VALUES.join(", ")})`);
  }
  if (Object.prototype.hasOwnProperty.call(record, "tags") && !Array.isArray(record.tags)) {
    errors.push("record.tags는 배열이어야 합니다");
  }
  errors.push(...validateOriginalChunk(record.originalChunk, "record.originalChunk", { optional: true }));
  return errors;
}

function validateOriginalChunk(value, fieldName = "originalChunk", _options = {}) {
  const errors = [];
  if (value === undefined) return errors;
  if (value === null) return errors;
  if (typeof value !== "string") {
    errors.push(`${fieldName}는 문자열 또는 null이어야 합니다`);
    return errors;
  }

  return errors;
}

function validateSourceRef(sourceRef) {
  const errors = [];
  if (typeof sourceRef !== "string") {
    return ["sourceRef는 문자열이어야 합니다"];
  }

  const normalized = sourceRef.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("/") || normalized.includes(":")) {
    errors.push(`sourceRef는 Brain 내부 상대경로여야 합니다: ${sourceRef}`);
  }
  if (normalized.split("/").some(part => part === ".." || part === "")) {
    errors.push(`sourceRef에 빈 경로 또는 상위경로(..)를 사용할 수 없습니다: ${sourceRef}`);
  }
  return errors;
}

module.exports = {
  RECORD_FIELDS,
  OPTIONAL_RECORD_FIELDS,
  ORIGINAL_CHUNK_MAX_LENGTH,
  SCOPE_TYPES,
  RECORD_TYPES,
  SOURCE_TYPES,
  STATUS_VALUES,
  SCOPE_ABBREV,
  RECORD_ID_REGEX,
  INTENT_ACTIONS,
  validateRecord,
  validateIntentRecord,
  validateIntent,
  validateOriginalChunk,
  validateSourceRef
};
