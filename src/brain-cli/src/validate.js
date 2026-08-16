"use strict";

const fs = require("fs");
const path = require("path");
const { readJsonl, safeReadJson, calculateHash, generateDigestLine } = require("./utils");
const { validateRecord } = require("./schemas");

/**
 * Brain 디렉토리의 정합성을 검증한다.
 * @param {string} brainRoot - Brain/ 절대 경로
 * @param {Object} options
 * @param {boolean} options.tmpMode - .tmp 파일 대상 검증 여부
 * @param {boolean} options.full - 전체 검증 (B08에서 확장)
 * @param {string|null} options.changedSourceRef - tmpMode에서 이번 트랜잭션 문서만 엄격 검증
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
  let records = [];
  try {
    records = readJsonl(recordsPath);
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
    const seenIds = new Set();
    const duplicateIds = new Set();
    for (const record of records) {
      if (seenIds.has(record.recordId)) duplicateIds.add(record.recordId);
      else seenIds.add(record.recordId);
    }
    if (duplicateIds.size > 0) {
      errors.push(`recordId 중복: ${[...duplicateIds].join(", ")}`);
    }

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record.sourceRef || record.status !== "active") continue;
      if (options.tmpMode && options.changedSourceRef && record.sourceRef !== options.changedSourceRef) continue;

      const filePath = path.join(brainRoot, record.sourceRef);
      const tmpFilePath = filePath + ".tmp";
      const checkPath = options.tmpMode && fs.existsSync(tmpFilePath) ? tmpFilePath : filePath;
      if (!fs.existsSync(checkPath)) {
        warnings.push(`record sourceRef 파일 없음: ${record.recordId} -> ${record.sourceRef}`);
      }
    }

  } catch (err) {
    if (fs.existsSync(recordsPath)) {
      errors.push(`records.jsonl 파싱 실패: ${err.message}`);
    }
  }

  if (!options.tmpMode) {
    _validateStoreConsistency(brainRoot, indexDir, records, errors, warnings);
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
  const { isManifestHashExcluded, readSourceContract } = require("./integrity-monitor");
  const sourceContract = readSourceContract(brainRoot);
  if (sourceContract.error) warnings.push(sourceContract.error);
  if (manifestResult.ok && manifestResult.data.files) {
    for (const entry of manifestResult.data.files) {
      if (options.tmpMode && options.changedSourceRef && entry.path !== options.changedSourceRef) continue;
      if (isManifestHashExcluded(sourceContract, entry.path)) continue;
      const filePath = path.join(brainRoot, entry.path);
      const tmpFilePath = filePath + ".tmp";

      // tmpMode에서는 .tmp 파일이 아직 rename 전이므로 .tmp 버전도 확인
      const checkPath = options.tmpMode && fs.existsSync(tmpFilePath) ? tmpFilePath : filePath;

      if (!fs.existsSync(checkPath)) {
        // 현재 트랜잭션이 이 파일을 쓰는 경우(.tmp 존재)만 error — 나머지는 기존 불일치이므로 warning
        if (options.tmpMode && fs.existsSync(tmpFilePath)) {
          errors.push(`manifest 참조 파일 없음: ${entry.path}`);
        } else {
          warnings.push(`manifest 참조 파일 없음 (수동 삭제?): ${entry.path}`);
        }
        continue;
      }
      const actualHash = calculateHash(checkPath);
      if (actualHash !== entry.hash) {
        if (options.tmpMode && fs.existsSync(tmpFilePath)) {
          // 이번 트랜잭션이 변경한 파일(.tmp 존재)만 엄격 검증
          errors.push(`해시 불일치: ${entry.path} (expected: ${entry.hash}, actual: ${actualHash})`);
        } else {
          // 트랜잭션 무관 파일 또는 non-tmpMode → warning
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
    } catch {
      // records 파싱 실패는 이미 위에서 보고됨
    }
  }

  // 5-K4. 오염 감지 — lifecycle.detectContamination 위임
  const k4Events = [];
  if (!options.tmpMode) {
    try {
      const { detectContamination } = require("./lifecycle");
      const contaminationResult = detectContamination(brainRoot);
      for (const item of contaminationResult.contaminated) {
        warnings.push(`[K4 오염] ${item.recordId} (type=${item.type}, sourceType=${item.sourceType}) — user_confirmed 없이 SSOT 승격`);
        k4Events.push({ recordId: item.recordId, type: item.type, sourceType: item.sourceType });
      }
    } catch {
      // lifecycle 모듈 실패는 무시
    }
  }

  // 5.5. Cascade Deprecation — deprecated 레코드를 참조하는 active 레코드 탐지
  if (!options.tmpMode) {
    try {
      const { detectDeprecatedReferences } = require("./lifecycle");
      const depRefs = detectDeprecatedReferences(brainRoot);
      for (const ref of depRefs) {
        warnings.push(`[고아 참조] ${ref.message}`);
      }
    } catch {
      // lifecycle 모듈 실패는 무시
    }
  }

  // 6. .bak/.tmp 잔류 파일 검사
  try {
    const indexFiles = fs.readdirSync(indexDir);
    const residual = indexFiles.filter(f => f.endsWith(".bak") || f.endsWith(".tmp"));
    if (residual.length > 0 && !options.tmpMode) {
      warnings.push(`잔류 파일 감지: ${residual.join(", ")} — 이전 BWT 미완료 가능성`);
    }
  } catch {
    // indexDir 읽기 실패는 무시
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    k4Events
  };
}

/**
 * records.jsonl 기반으로 records_digest.txt를 8컬럼 포맷으로 재생성한다.
 * 기존 파일은 .bak으로 백업한다.
 * @param {string} brainRoot - Brain/ 절대 경로
 * @returns {{ success: boolean, recordCount: number, backupPath: string|null }}
 */
function rebuildDigest(brainRoot) {
  const indexDir = path.join(brainRoot, "90_index");
  const recordsPath = path.join(indexDir, "records.jsonl");
  const digestPath = path.join(indexDir, "records_digest.txt");

  const records = readJsonl(recordsPath);

  // 기존 digest 백업
  let backupPath = null;
  if (fs.existsSync(digestPath)) {
    backupPath = digestPath + ".bak";
    fs.copyFileSync(digestPath, backupPath);
  }

  // 8컬럼 digest 재생성
  const header = "# Brain records_digest.txt\n# Format: recordId | title | summary | tags | status | type | sourceType | updatedAt\n# Auto-generated by brain-cli rebuild-digest. Do not edit manually.\n";
  const lines = records.map(r => generateDigestLine(r));
  fs.writeFileSync(digestPath, header + lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf-8");

  return { success: true, recordCount: records.length, backupPath };
}

/**
 * 레코드 분포 리포트를 생성한다.
 * @param {Array} records - records.jsonl 전체 레코드
 * @returns {{ byScopeType: Object, byScopeId: Array, staleRecords: Array }}
 */
function generateDistributionReport(records) {
  const byScopeType = {};
  const byScopeId = {};
  const staleRecords = [];
  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  for (const r of records) {
    // scopeType별 카운트
    byScopeType[r.scopeType] = (byScopeType[r.scopeType] || 0) + 1;

    // scopeId별 카운트
    byScopeId[r.scopeId] = (byScopeId[r.scopeId] || 0) + 1;

    // 30일 이상 미갱신 active 레코드
    if (r.status === "active" && r.updatedAt) {
      const updatedAt = new Date(r.updatedAt).getTime();
      if (now - updatedAt > thirtyDaysMs) {
        staleRecords.push({ recordId: r.recordId, title: r.title, updatedAt: r.updatedAt });
      }
    }
  }

  // scopeId를 내림차순 정렬
  const sortedScopeId = Object.entries(byScopeId)
    .sort((a, b) => b[1] - a[1])
    .map(([scopeId, count]) => ({ scopeId, count }));

  return { byScopeType, byScopeId: sortedScopeId, staleRecords };
}

/**
 * manifest.json의 해시 불일치 항목을 현재 파일 기준으로 수정한다.
 * - 파일이 존재하면 현재 해시로 갱신
 * - 파일이 없으면 manifest에서 해당 항목 제거
 * @param {string} brainRoot
 * @returns {{ fixed: string[], removed: string[] }}
 */
function reconcileManifest(brainRoot) {
  const manifestPath = path.join(brainRoot, "90_index", "manifest.json");
  const result = safeReadJson(manifestPath);
  if (!result.ok || !Array.isArray(result.data.files)) {
    throw new Error("manifest.json 읽기 실패");
  }

  const fixed = [];
  const removed = [];
  const data = result.data;

  data.files = data.files.filter(entry => {
    const filePath = path.join(brainRoot, entry.path);
    if (!fs.existsSync(filePath)) {
      removed.push(entry.path);
      return false;
    }
    const actualHash = calculateHash(filePath);
    if (actualHash !== entry.hash) {
      entry.hash = actualHash;
      fixed.push(entry.path);
    }
    return true;
  });

  const tmpPath = manifestPath + ".reconcile.tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmpPath, manifestPath);

  return { fixed, removed };
}

function _parseDigestIds(digestPath) {
  if (!fs.existsSync(digestPath)) return [];
  return fs.readFileSync(digestPath, "utf-8")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"))
    .map(line => line.split(" | "))
    .filter(parts => parts.length >= 5)
    .map(parts => parts[0].trim())
    .filter(recordId => /^rec_[a-z0-9_-]+$/i.test(recordId))
    .filter(Boolean);
}

function _sampleIds(ids) {
  return ids.slice(0, 5).join(", ");
}

function _validateStoreConsistency(brainRoot, indexDir, records, errors, warnings) {
  const jsonIds = new Set(records.map(record => record.recordId).filter(Boolean));
  const digestIds = new Set(_parseDigestIds(path.join(indexDir, "records_digest.txt")));
  const digestMissing = [...jsonIds].filter(id => !digestIds.has(id));
  const digestExtra = [...digestIds].filter(id => !jsonIds.has(id));
  if (digestMissing.length > 0) {
    errors.push(`digest 누락: JSONL 레코드 ${digestMissing.length}건 없음 (${_sampleIds(digestMissing)})`);
  }
  if (digestExtra.length > 0) {
    errors.push(`digest 초과: JSONL에 없는 레코드 ${digestExtra.length}건 (${_sampleIds(digestExtra)})`);
  }

  const dbPath = path.join(indexDir, "records.db");
  if (!fs.existsSync(dbPath)) return;
  let db;
  try {
    const Database = require("better-sqlite3");
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare("SELECT record_id, source_ref FROM records").all();
    const dbIds = new Set(rows.map(row => row.record_id));
    const rawBackedDbIds = rows
      .filter(row => row.source_ref && fs.existsSync(path.join(brainRoot, row.source_ref)))
      .map(row => row.record_id);
    const dbMissingInJson = rawBackedDbIds.filter(id => !jsonIds.has(id));
    const jsonMissingInDb = [...jsonIds].filter(id => !dbIds.has(id));
    if (dbMissingInJson.length > 0) {
      errors.push(`DB→JSONL 누락: Raw가 존재하는 레코드 ${dbMissingInJson.length}건 (${_sampleIds(dbMissingInJson)})`);
    }
    if (jsonMissingInDb.length > 0) {
      errors.push(`JSONL→DB 누락: ${jsonMissingInDb.length}건 (${_sampleIds(jsonMissingInDb)})`);
    }
  } catch (error) {
    warnings.push(`SQLite 교차 검증 실패: ${error.message}`);
  } finally {
    if (db) db.close();
  }
}

module.exports = { validate, rebuildDigest, generateDistributionReport, reconcileManifest };
