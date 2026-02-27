"use strict";

const path = require("path");
const { readJsonl, writeJsonl, isoNow } = require("./utils");

/**
 * Brain Lifecycle 관리
 *
 * - 4가지 상태 전환 경로
 * - 물리 삭제 3조건 게이트
 * - 오염 감지 (inference/candidate → hardRules 혼입)
 * - SSOT 승격 게이트 (user_confirmed만 허용)
 * - 폴더 자동 생성 제한 (30_topics/만 허용)
 */

// 허용된 상태 전환 맵
const ALLOWED_TRANSITIONS = {
  active: ["deprecated", "archived"],
  deprecated: ["active"], // 복원 가능
  archived: [] // v1에서는 archived → 다른 상태 전환 없음
};

/**
 * 상태 전환 검증
 * @param {string} from - 현재 상태
 * @param {string} to - 목표 상태
 * @returns {{ allowed: boolean, reason?: string }}
 */
function validateTransition(from, to) {
  if (!ALLOWED_TRANSITIONS[from]) {
    return { allowed: false, reason: `알 수 없는 현재 상태: ${from}` };
  }
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return { allowed: false, reason: `허용되지 않은 전환: ${from} → ${to}` };
  }
  return { allowed: true };
}

/**
 * 물리 삭제 3조건 게이트
 *
 * 1) 1세션 경과 (deprecated 후 현재 세션이 아닌 이전 세션에서 deprecated됨)
 * 2) replacedBy 유효 (null이 아님)
 * 3) 사용자 확인 (userConfirmed=true)
 *
 * @param {Object} record - 삭제 대상 레코드
 * @param {Object} options
 * @param {boolean} options.userConfirmed - 사용자 확인 여부
 * @param {string} options.currentSessionStart - 현재 세션 시작 ISO timestamp
 * @returns {{ allowed: boolean, unmet: string[] }}
 */
function checkDeleteGate(record, options = {}) {
  const unmet = [];

  // 조건 0: deprecated 상태여야 함
  if (record.status !== "deprecated") {
    return { allowed: false, unmet: ["레코드가 deprecated 상태가 아닙니다"] };
  }

  // 조건 1: 1세션 경과
  if (options.currentSessionStart && record.updatedAt) {
    if (record.updatedAt >= options.currentSessionStart) {
      unmet.push("1세션 경과: 현재 세션에서 deprecated된 레코드는 즉시 삭제할 수 없습니다");
    }
  } else {
    // 세션 정보 없으면 보수적으로 거부
    unmet.push("1세션 경과: 세션 시작 시간 정보가 없습니다");
  }

  // 조건 2: replacedBy 유효
  if (!record.replacedBy) {
    unmet.push("replacedBy: null — 대체 레코드 또는 'obsolete' 지정 필요");
  }

  // 조건 3: 사용자 확인
  if (!options.userConfirmed) {
    unmet.push("사용자 확인: 삭제를 위한 사용자 확인이 필요합니다");
  }

  return {
    allowed: unmet.length === 0,
    unmet
  };
}

/**
 * 오염 감지
 *
 * inference 또는 candidate sourceType의 레코드가
 * hardRules/knownDecisions 영역에 혼입되었는지 검사
 *
 * @param {string} brainRoot - Brain/ 절대 경로
 * @returns {{ contaminated: Array, clean: boolean }}
 */
function detectContamination(brainRoot) {
  const indexDir = path.join(brainRoot, "90_index");
  const records = readJsonl(path.join(indexDir, "records.jsonl"));
  const contaminated = [];

  // SSOT(hardRules/knownDecisions)에 혼입 가능한 금지 sourceType
  const bannedForSSOT = ["inference", "candidate"];

  for (const record of records) {
    if (record.status !== "active") continue;

    // type이 rule 또는 decision이면 SSOT 영역
    const isSSOTType = record.type === "rule" || record.type === "decision";
    if (!isSSOTType) continue;

    // sourceType이 inference 또는 candidate이면 오염
    if (bannedForSSOT.includes(record.sourceType)) {
      contaminated.push({
        recordId: record.recordId,
        type: record.type,
        sourceType: record.sourceType,
        title: record.title,
        action: "즉시 deprecated 전환 + 사용자 알림 필요"
      });
    }
  }

  return {
    contaminated,
    clean: contaminated.length === 0
  };
}

/**
 * SSOT 승격 게이트 검증
 *
 * user_confirmed만 SSOT(rule/decision)로 승격 허용
 *
 * @param {string} sourceType - 승격 대상의 sourceType
 * @returns {{ allowed: boolean, reason?: string }}
 */
function checkSSOTPromotionGate(sourceType) {
  if (sourceType === "user_confirmed") {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `sourceType '${sourceType}'은 SSOT 승격 불가. user_confirmed만 허용됩니다.`
  };
}

/**
 * 폴더 자동 생성 가능 여부 확인
 *
 * 30_topics/만 자동 생성 허용, 나머지는 사용자 승인 필수
 *
 * @param {string} sourceRef - 대상 경로
 * @returns {{ autoAllowed: boolean, reason?: string }}
 */
function checkFolderAutoCreate(sourceRef) {
  if (sourceRef.startsWith("30_topics/")) {
    return { autoAllowed: true };
  }
  return {
    autoAllowed: false,
    reason: `'${sourceRef}' 경로는 자동 폴더 생성이 제한됩니다. 30_topics/만 자동 생성 허용.`
  };
}

/**
 * deprecated 역참조 탐지
 *
 * active 레코드의 sourceRef/summary에서 deprecated recordId를 참조하는지 검사
 *
 * @param {string} brainRoot - Brain/ 절대 경로
 * @returns {Array} - 역참조 경고 목록
 */
function detectDeprecatedReferences(brainRoot) {
  const indexDir = path.join(brainRoot, "90_index");
  const records = readJsonl(path.join(indexDir, "records.jsonl"));
  const warnings = [];

  const deprecatedIds = records
    .filter(r => r.status === "deprecated")
    .map(r => r.recordId);

  if (deprecatedIds.length === 0) return warnings;

  const activeRecords = records.filter(r => r.status === "active");
  for (const activeRec of activeRecords) {
    const text = `${activeRec.sourceRef || ""} ${activeRec.summary || ""}`;
    for (const depId of deprecatedIds) {
      if (text.includes(depId)) {
        warnings.push({
          activeRecordId: activeRec.recordId,
          referencedDeprecated: depId,
          message: `${activeRec.recordId}(active)가 ${depId}(deprecated)를 참조 중`
        });
      }
    }
  }

  return warnings;
}

module.exports = {
  validateTransition,
  checkDeleteGate,
  detectContamination,
  checkSSOTPromotionGate,
  checkFolderAutoCreate,
  detectDeprecatedReferences
};
