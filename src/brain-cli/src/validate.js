"use strict";

const fs = require("fs");
const path = require("path");
const { readJsonl, safeReadJson, calculateHash } = require("./utils");
const { validateRecord, RECORD_ID_REGEX } = require("./schemas");

/**
 * Brain 디렉토리의 정합성을 검증한다.
 * @param {string} brainRoot - Brain/ 절대 경로
 * @param {Object} options
 * @param {boolean} options.tmpMode - .tmp 파일 대상 검증 여부
 * @param {boolean} options.full - 전체 검증 (B08에서 확장)
 * @returns {{ passed: boolean, errors: string[], warnings: string[] }}
 */
function validate(brainRoot, options = {}) {
  const errors = [];
  const warnings = [];
  const indexDir = path.join(brainRoot, "90_index");

  // 1. 필수 파일 존재 검사
  const requiredFiles = [
    "99_policy/brainPolicy.md",
    "90_index/manifest.json",
    "90_index/tags.json",
    "90_index/folderRegistry.json"
  ];

  for (const relPath of requiredFiles) {
    const fullPath = path.join(brainRoot, relPath);
    if (!fs.existsSync(fullPath)) {
      errors.push(`필수 파일 없음: ${relPath}`);
    }
  }

  // records.jsonl은 빈 파일도 허용
  const recordsPath = path.join(indexDir, options.tmpMode ? "records.jsonl.tmp" : "records.jsonl");
  if (!options.tmpMode && !fs.existsSync(path.join(indexDir, "records.jsonl"))) {
    errors.push("필수 파일 없음: 90_index/records.jsonl");
  }

  if (errors.length > 0 && !options.tmpMode) {
    return { passed: false, errors, warnings };
  }

  // 2. records.jsonl 스키마 검증
  try {
    const records = readJsonl(recordsPath);
    for (let i = 0; i < records.length; i++) {
      const result = validateRecord(records[i]);
      if (!result.valid) {
        for (const err of result.errors) {
          errors.push(`records[${i}] (${records[i].recordId || "unknown"}): ${err}`);
        }
      }
    }

    // 레코드 수 경고 (>100)
    if (records.length > 100) {
      warnings.push(`레코드 수 ${records.length}개 — 100개 초과. 임베딩 기반 검색 도입 검토 필요`);
    }

    // recordId 중복 검사
    const ids = records.map(r => r.recordId);
    const dupes = ids.filter((id, idx) => ids.indexOf(id) !== idx);
    if (dupes.length > 0) {
      errors.push(`recordId 중복: ${[...new Set(dupes)].join(", ")}`);
    }

  } catch (err) {
    if (fs.existsSync(recordsPath)) {
      errors.push(`records.jsonl 파싱 실패: ${err.message}`);
    }
  }

  // 3. tags.json 검증
  const tagsResult = safeReadJson(path.join(indexDir, "tags.json"));
  if (tagsResult.ok) {
    const tags = tagsResult.data;
    if (!tags.axes || !Array.isArray(tags.axes)) {
      errors.push("tags.json: axes 필드 누락 또는 배열 아님");
    } else if (tags.axes.length !== 2 || !tags.axes.includes("domain") || !tags.axes.includes("intent")) {
      errors.push("tags.json: axes는 [domain, intent] 2축이어야 합니다");
    }
  }

  // 4. manifest 해시 검증 (파일-인덱스 정합성)
  const manifestPath = path.join(indexDir, options.tmpMode ? "manifest.json.tmp" : "manifest.json");
  const manifestResult = safeReadJson(manifestPath);
  if (manifestResult.ok && manifestResult.data.files) {
    for (const entry of manifestResult.data.files) {
      const filePath = path.join(brainRoot, entry.path);
      const tmpFilePath = filePath + ".tmp";

      // tmpMode에서는 .tmp 파일이 아직 rename 전이므로 .tmp 버전도 확인
      const checkPath = options.tmpMode && fs.existsSync(tmpFilePath) ? tmpFilePath : filePath;

      if (!fs.existsSync(checkPath)) {
        errors.push(`manifest 참조 파일 없음: ${entry.path}`);
        continue;
      }
      const actualHash = calculateHash(checkPath);
      if (actualHash !== entry.hash) {
        if (options.tmpMode) {
          errors.push(`해시 불일치: ${entry.path} (expected: ${entry.hash}, actual: ${actualHash})`);
        } else {
          warnings.push(`해시 불일치 (수동 변경?): ${entry.path}`);
        }
      }
    }
  }

  // 5. deprecated 역참조 탐지 (full 모드)
  if (options.full) {
    try {
      const records = readJsonl(path.join(indexDir, "records.jsonl"));
      const deprecatedIds = records
        .filter(r => r.status === "deprecated")
        .map(r => r.recordId);

      if (deprecatedIds.length > 0) {
        const activeRecords = records.filter(r => r.status === "active");
        for (const activeRec of activeRecords) {
          const text = `${activeRec.sourceRef || ""} ${activeRec.summary || ""}`;
          for (const depId of deprecatedIds) {
            if (text.includes(depId)) {
              warnings.push(`[리뷰 필요] ${activeRec.recordId}(active)가 ${depId}(deprecated)를 참조 중`);
            }
          }
        }
      }
    } catch (err) {
      // records 파싱 실패는 이미 위에서 보고됨
    }
  }

  // 6. .bak/.tmp 잔류 파일 검사
  try {
    const indexFiles = fs.readdirSync(indexDir);
    const residual = indexFiles.filter(f => f.endsWith(".bak") || f.endsWith(".tmp"));
    if (residual.length > 0 && !options.tmpMode) {
      warnings.push(`잔류 파일 감지: ${residual.join(", ")} — 이전 BWT 미완료 가능성`);
    }
  } catch (err) {
    // indexDir 읽기 실패는 무시
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings
  };
}

module.exports = { validate };
