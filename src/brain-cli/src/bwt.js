"use strict";

const fs = require("fs");
const path = require("path");
const {
  calculateHash,
  calculateHashFromString,
  readJsonl,
  writeJsonl,
  safeReadJson,
  generateDigestLine,
  isoNow,
  ensureDir
} = require("./utils");
const { validateIntent, ORIGINAL_CHUNK_MAX_LENGTH } = require("./schemas");
const { validate } = require("./validate");
const { autoLink, addLink } = require("./links");
const { _loadDigest } = require("./search");

const RETRYABLE_RENAME_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
const BWT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

function renameWithRetry(sourcePath, destinationPath, maxAttempts = 6) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fs.renameSync(sourcePath, destinationPath);
      return;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_RENAME_ERRORS.has(error.code) || attempt === maxAttempts) throw error;
      const delayMs = 25 * (2 ** (attempt - 1));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  throw lastError;
}

function copyFileWithRetry(sourcePath, destinationPath, maxAttempts = 6) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fs.copyFileSync(sourcePath, destinationPath);
      return;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_RENAME_ERRORS.has(error.code) || attempt === maxAttempts) throw error;
      const delayMs = 25 * (2 ** (attempt - 1));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  throw lastError;
}

/**
 * BWT (Brain Write Transaction) Engine
 *
 * 9단계 실행 흐름:
 * [LLM] 1) Intent JSON 파싱
 * [CLI] 2) .bak 백업 생성
 * [CLI] 3) 폴더 생성 (필요시)
 * [CLI] 4) 문서를 *.tmp로 저장
 * [CLI] 5) contentHash 계산 + records.jsonl.tmp 갱신
 * [CLI] 6) manifest.json.tmp 갱신
 * [CLI] 7) records_digest.txt.tmp 갱신
 * [CLI] 8) validate 실행
 * [CLI] 9) atomic rename 또는 rollback
 */
class BWTEngine {
  /**
   * @param {string} brainRoot - Brain/ 절대 경로
   */
  constructor(brainRoot) {
    this.brainRoot = brainRoot;
    this.indexDir = path.join(brainRoot, "90_index");
    this.bakFiles = [];
    this.tmpFiles = [];
    this.transactionWarnings = [];
  }

  /**
   * BWT 메인 실행 함수
   * @param {Object} intent - LLM이 생성한 Intent JSON
   * @returns {{ success: boolean, recordId?: string, report: Object }}
   */
  execute(intent) {
    const { acquireLock } = require("./lock");
    const lock = acquireLock(this.brainRoot, { staleMs: 30000, timeoutMs: BWT_LOCK_TIMEOUT_MS });
    this.transactionWarnings = [];
    try {
      // 동시성 방지: .tmp 잔류 파일 확인 (락 이후 이중 안전장치)
      this._checkResidualTmp();

      // Step 1: Intent 파싱 및 검증
      const parsed = this._parseIntent(intent);

      // Step 2: .bak 백업 생성
      this._createBackups(parsed);

      // Step 3: 폴더 생성 (필요시)
      this._ensureFolders(parsed);

      // Step 4: 문서를 .tmp로 저장
      this._writeDocumentTmp(parsed);
      this._assertSourceRefDocumentAvailable(parsed);

      // Step 5: contentHash + records.jsonl.tmp
      this._updateRecordsTmp(parsed);

      // Step 6: manifest.json.tmp
      this._updateManifestTmp(parsed);

      // Step 7: records_digest.txt.tmp
      this._updateDigestTmp(parsed);

      // Step 8: validate
      const validation = validate(this.brainRoot, {
        tmpMode: true,
        changedSourceRef: parsed.sourceRef || null
      });
      if (!validation.passed) {
        this._rollback();
        return {
          success: false,
          report: {
            step: 8,
            message: "validate 실패",
            errors: validation.errors,
            warnings: [...this.transactionWarnings, ...validation.warnings]
          }
        };
      }

      // Step 9: atomic rename
      this._commit(parsed);

      // Step 9.5: 링크 생성 (create 시, best-effort)
      let autoLinked = 0;
      let explicitLinked = 0;
      if (parsed.action === "create") {
        // 9.5a: LLM이 명시한 explicit links 먼저 처리
        if (parsed.links && parsed.links.length > 0) {
          for (const link of parsed.links) {
            try {
              const result = addLink(this.brainRoot, parsed.recordId, link.toId, link.linkType);
              if (result.added) explicitLinked++;
            } catch { /* best-effort */ }
          }
        }

        // 9.5b: autoLink fallback (추가 발견용 — 중복은 addLink이 자동 방지)
        try {
          const digestPath = path.join(this.indexDir, "records_digest.txt");
          const existingDigest = _loadDigest(digestPath);
          const newRecord = {
            recordId: parsed.recordId,
            title: parsed.record.title || "",
            tags: parsed.record.tags || [],
            type: parsed.record.type || null,
            status: "active"
          };
          autoLinked = autoLink(this.brainRoot, newRecord, existingDigest);
        } catch { /* 링크 실패는 무시 — 핵심 트랜잭션에 영향 없음 */ }
      }

      // Step 9.6: create 시 자동 positive feedback (30분 이내 전략 매칭)
      if (parsed.action === "create") {
        try {
          const lastStratPath = path.join(this.indexDir, ".meta_last_strategy");
          if (fs.existsSync(lastStratPath)) {
            const lastStrat = JSON.parse(fs.readFileSync(lastStratPath, "utf8"));
            const ageMs = Date.now() - new Date(lastStrat.timestamp).getTime();
            if (ageMs < 30 * 60 * 1000 && lastStrat.primary) {
              const { logFeedback } = require("./feedback-log");
              const { updateEffectivenessScore } = require("./meta-strategy");
              logFeedback(this.brainRoot, {
                strategyName: lastStrat.primary.name,
                feedbackType: "positive",
                message: lastStrat.message,
                score: lastStrat.primary.score
              });
              updateEffectivenessScore(this.brainRoot, lastStrat.primary.name, 0.1);
            }
          }
        } catch { /* feedback 실패는 무시 */ }
      }

      // Step 9.7: deprecate 시 replaced_by 링크 자동 생성
      if (parsed.action === "deprecate" && parsed.replacedBy && parsed.replacedBy !== "obsolete") {
        try {
          addLink(this.brainRoot, parsed.replacedBy, parsed.recordId, "replaced_by");
        } catch { /* best-effort */ }
      }

      return {
        success: true,
        recordId: parsed.recordId,
        report: {
          action: parsed.action,
          recordId: parsed.recordId,
          warnings: [...this.transactionWarnings, ...validation.warnings],
          explicitLinked,
          autoLinked
        }
      };

    } catch (error) {
      this._rollback();
      return {
        success: false,
        report: {
          step: error.step ?? "unknown",
          message: error.message,
          errors: [error.message]
        }
      };
    } finally {
      lock.release();
    }
  }

  // --- Step 0: 잔류 .tmp 확인 + 자동 정리 ---
  _checkResidualTmp() {
    const cleaned = [];
    const failed = [];

    // 1. 인덱스 dir .tmp 정리
    const indexFiles = fs.readdirSync(this.indexDir);
    for (const f of indexFiles.filter(f => f.endsWith(".tmp"))) {
      try {
        fs.unlinkSync(path.join(this.indexDir, f));
        cleaned.push(f);
      } catch {
        failed.push(f);
      }
    }

    // 2. 문서 .tmp 정리 — manifest에 등록된 파일의 잔류 .tmp 확인
    // 부분 commit 실패 시 문서 .tmp가 인덱스 dir 밖에 남아 이후 모든 BWT를 차단하는 버그 방지
    try {
      const manifest = safeReadJson(path.join(this.indexDir, "manifest.json"));
      if (manifest.ok && Array.isArray(manifest.data.files)) {
        for (const entry of manifest.data.files) {
          const tmpPath = path.join(this.brainRoot, entry.path) + ".tmp";
          if (fs.existsSync(tmpPath)) {
            try {
              fs.unlinkSync(tmpPath);
              cleaned.push(entry.path + ".tmp");
            } catch {
              failed.push(entry.path + ".tmp");
            }
          }
        }
      }
    } catch { /* manifest 읽기 실패는 무시 */ }

    if (cleaned.length === 0 && failed.length === 0) return;

    if (failed.length > 0) {
      const err = new Error(`잔류 .tmp 정리 실패: ${failed.join(", ")} — 수동 삭제 후 재시도하세요.`);
      err.step = 0;
      throw err;
    }
  }

  // --- Step 1: Intent 파싱 ---
  _parseIntent(intent) {
    const result = validateIntent(intent);
    if (!result.valid) {
      const err = new Error(`Intent 검증 실패: ${result.errors.join("; ")}`);
      err.step = 1;
      throw err;
    }

    const parsed = { ...intent };
    if (Object.prototype.hasOwnProperty.call(intent, "originalChunk")) {
      parsed.originalChunk = this._normalizeOriginalChunk(intent.originalChunk);
    }
    if (intent.record) {
      parsed.record = { ...intent.record };
      this._forceConfirmedSourceType(parsed.record);
    }

    if (["update", "deprecate"].includes(intent.action)) {
      this._inheritExistingSourceRef(parsed);
    }

    if (intent.action === "create") {
      parsed.recordId = this._allocateCreateRecordId(
        intent.record.scopeType,
        intent.record.scopeId
      );
    }

    return parsed;
  }

  _inheritExistingSourceRef(parsed) {
    const records = readJsonl(path.join(this.indexDir, "records.jsonl"));
    const existing = records.find(record => record.recordId === parsed.recordId);
    if (!existing) return;

    const isUpdate = parsed.action === "update";
    const requestedRef = parsed.sourceRef || (parsed.record && parsed.record.sourceRef);
    if (isUpdate && requestedRef && existing.sourceRef && requestedRef !== existing.sourceRef) {
      const error = new Error(
        "update sourceRef 변경 금지: " + existing.sourceRef + " -> " + requestedRef
      );
      error.step = 1;
      throw error;
    }

    parsed.sourceRef = existing.sourceRef || requestedRef || "";
    if (isUpdate && parsed.record && Object.prototype.hasOwnProperty.call(parsed.record, "sourceRef")) {
      delete parsed.record.sourceRef;
    }
    if (isUpdate && parsed.content !== undefined && !parsed.sourceRef) {
      const error = new Error("update content 저장 대상 sourceRef가 없습니다.");
      error.step = 1;
      throw error;
    }
  }
  _allocateCreateRecordId(scopeType, scopeId) {
    const { getWriteDb, getNextRecordId, recordExists } = require("./db");
    const db = getWriteDb(this.brainRoot);
    try {
      const recordId = getNextRecordId(db, scopeType, scopeId);
      if (recordExists(db, recordId)) {
        const error = new Error(`recordId 충돌: ${recordId} — 기존 레코드를 덮어쓰지 않습니다.`);
        error.step = 1;
        throw error;
      }
      return recordId;
    } finally {
      db.close();
    }
  }

  _normalizeOriginalChunk(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return String(value).slice(0, ORIGINAL_CHUNK_MAX_LENGTH);
  }

  _forceConfirmedSourceType(record) {
    if (!record || (record.type !== "decision" && record.type !== "rule")) return;
    if (record.sourceType === "user_confirmed") return;

    const warning = `[K4-AUTO] type=${record.type} 이므로 sourceType을 user_confirmed로 강제`;
    record.sourceType = "user_confirmed";
    this.transactionWarnings.push(warning);
    console.warn(warning);
  }

  // --- Step 2: .bak 백업 ---
  _createBackups(parsed) {
    const targets = this._getAffectedFiles(parsed);
    for (const filePath of targets) {
      if (fs.existsSync(filePath)) {
        const bakPath = filePath + ".bak";
        try {
          fs.copyFileSync(filePath, bakPath);
          this.bakFiles.push({ original: filePath, bak: bakPath });
        } catch (err) {
          const error = new Error(`.bak 생성 실패: ${filePath} — ${err.message}`);
          error.step = 2;
          throw error;
        }
      }
    }
  }

  // --- Step 3: 폴더 생성 ---
  _ensureFolders(parsed) {
    if ((parsed.action === "create" || parsed.action === "update") && parsed.sourceRef) {
      const docDir = path.dirname(path.join(this.brainRoot, parsed.sourceRef));
      ensureDir(docDir);
    }
  }

  // --- Step 4: 문서 .tmp 저장 ---
  _writeDocumentTmp(parsed) {
    if (parsed.action === "create" || parsed.action === "update") {
      if (parsed.content !== undefined && parsed.sourceRef) {
        const docPath = path.join(this.brainRoot, parsed.sourceRef);
        const tmpPath = docPath + ".tmp";
        try {
          this.tmpFiles.push(tmpPath);
          fs.writeFileSync(tmpPath, parsed.content, "utf-8");
        } catch (err) {
          const error = new Error(`.tmp 작성 실패: ${tmpPath} — ${err.message}`);
          error.step = 4;
          throw error;
        }
      }
    }
  }

  _assertSourceRefDocumentAvailable(parsed) {
    if (parsed.action !== "create" || !parsed.sourceRef) return;

    const docTmpPath = path.join(this.brainRoot, parsed.sourceRef) + ".tmp";
    if (fs.existsSync(docTmpPath)) return;

    const error = new Error(`sourceRef 문서 생성 실패: ${parsed.sourceRef} — content 없이 레코드만 저장할 수 없습니다.`);
    error.step = 4;
    throw error;
  }

  // --- Step 5: records.jsonl.tmp 갱신 ---
  _updateRecordsTmp(parsed) {
    const recordsPath = path.join(this.indexDir, "records.jsonl");
    const tmpPath = recordsPath + ".tmp";
    const records = readJsonl(recordsPath);
    const now = isoNow();

    switch (parsed.action) {
      case "create": {
        const docPath = parsed.sourceRef
          ? path.join(this.brainRoot, parsed.sourceRef)
          : null;
        const contentHash = parsed.content
          ? calculateHashFromString(parsed.content)
          : (docPath && fs.existsSync(docPath + ".tmp") ? calculateHash(docPath + ".tmp") : "sha256:empty");

        const originalChunk = this._normalizeOriginalChunk(parsed.originalChunk);
        const newRecord = {
          recordId: parsed.recordId,
          scopeType: parsed.record.scopeType,
          scopeId: parsed.record.scopeId,
          type: parsed.record.type,
          title: parsed.record.title,
          summary: parsed.record.summary || "",
          tags: parsed.record.tags || [],
          sourceType: parsed.record.sourceType,
          sourceRef: parsed.sourceRef || "",
          status: "active",
          replacedBy: null,
          deprecationReason: null,
          updatedAt: now,
          contentHash: contentHash
        };
        if (originalChunk !== undefined) {
          newRecord.originalChunk = originalChunk;
        }

        if (records.some(record => record.recordId === parsed.recordId)) {
          const error = new Error(`recordId 충돌: ${parsed.recordId} — records.jsonl에도 추가하지 않습니다.`);
          error.step = 5;
          throw error;
        }
        records.push(newRecord);
        break;
      }
      case "update": {
        const idx = records.findIndex(r => r.recordId === parsed.recordId);
        if (idx === -1) {
          const err = new Error(`레코드 미발견: ${parsed.recordId}`);
          err.step = 5;
          throw err;
        }

        // 부분 갱신
        if (parsed.record) {
          for (const [key, value] of Object.entries(parsed.record)) {
            records[idx][key] = value;
          }
        }
        if (parsed.content !== undefined) {
          records[idx].contentHash = calculateHashFromString(parsed.content);
        }
        if (Object.prototype.hasOwnProperty.call(parsed, "originalChunk")) {
          records[idx].originalChunk = this._normalizeOriginalChunk(parsed.originalChunk);
        }
        records[idx].updatedAt = now;
        break;
      }
      case "deprecate": {
        const idx = records.findIndex(r => r.recordId === parsed.recordId);
        if (idx === -1) {
          const err = new Error(`레코드 미발견: ${parsed.recordId}`);
          err.step = 5;
          throw err;
        }
        records[idx].status = "deprecated";
        records[idx].replacedBy = parsed.replacedBy;
        records[idx].deprecationReason = parsed.deprecationReason || null;
        records[idx].updatedAt = now;
        break;
      }
      case "delete": {
        const idx = records.findIndex(r => r.recordId === parsed.recordId);
        if (idx === -1) {
          const err = new Error(`레코드 미발견: ${parsed.recordId}`);
          err.step = 5;
          throw err;
        }
        records.splice(idx, 1);
        break;
      }
    }

    this.tmpFiles.push(tmpPath);
    writeJsonl(tmpPath, records);
  }

  // --- Step 6: manifest.json.tmp 갱신 ---
  _updateManifestTmp(parsed) {
    const manifestPath = path.join(this.indexDir, "manifest.json");
    const tmpPath = manifestPath + ".tmp";
    const manifest = safeReadJson(manifestPath);
    const data = manifest.ok ? manifest.data : { version: "1.0", files: [] };
    const now = isoNow();

    if (parsed.action === "create" && parsed.sourceRef) {
      const docTmpPath = path.join(this.brainRoot, parsed.sourceRef) + ".tmp";
      const hash = fs.existsSync(docTmpPath)
        ? calculateHash(docTmpPath)
        : calculateHashFromString(parsed.content || "");
      const size = fs.existsSync(docTmpPath)
        ? fs.statSync(docTmpPath).size
        : Buffer.byteLength(parsed.content || "", "utf-8");

      // 카테고리 결정
      const category = this._categorize(parsed.sourceRef);

      // 동일 path가 이미 있으면 덮어쓰기 (중복 방지)
      const existing = data.files.find(f => f.path === parsed.sourceRef);
      if (existing) {
        existing.hash = hash;
        existing.size = size;
        existing.updatedAt = now;
        existing.category = category;
      } else {
        data.files.push({
          path: parsed.sourceRef,
          hash: hash,
          size: size,
          updatedAt: now,
          category: category
        });
      }
    } else if (parsed.action === "update" && parsed.sourceRef) {
      const entry = data.files.find(f => f.path === parsed.sourceRef);
      if (entry) {
        const docTmpPath = path.join(this.brainRoot, parsed.sourceRef) + ".tmp";
        if (fs.existsSync(docTmpPath)) {
          entry.hash = calculateHash(docTmpPath);
          entry.size = fs.statSync(docTmpPath).size;
        }
        entry.updatedAt = now;
      }
    } else if (parsed.action === "delete" && parsed.sourceRef) {
      data.files = data.files.filter(f => f.path !== parsed.sourceRef);
    }

    // summary 재계산
    data.updatedAt = now;
    data.summary = this._computeSummary(data.files);

    this.tmpFiles.push(tmpPath);
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  }

  // --- Step 7: records_digest.txt.tmp 갱신 ---
  _updateDigestTmp() {
    const recordsTmpPath = path.join(this.indexDir, "records.jsonl.tmp");
    const digestPath = path.join(this.indexDir, "records_digest.txt");
    const tmpPath = digestPath + ".tmp";

    const records = readJsonl(recordsTmpPath);
    const header = "# Brain records_digest.txt\n# Format: recordId | title | summary | tags | status | type | sourceType | updatedAt\n# Auto-generated by brain-cli BWT. Do not edit manually.\n";
    const lines = records.map(r => generateDigestLine(r));

    this.tmpFiles.push(tmpPath);
    fs.writeFileSync(tmpPath, header + lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf-8");
  }

  // --- Step 9a: commit ---
  _commit(parsed) {
    // 모든 .tmp를 원본으로 rename (부분 실패 시 되돌림)
    const committed = [];
    for (const tmpFile of this.tmpFiles) {
      const originalPath = tmpFile.replace(/\.tmp$/, "");
      try {
        renameWithRetry(tmpFile, originalPath);
        committed.push({ tmp: tmpFile, original: originalPath });
      } catch (err) {
        // 원본을 .tmp로 되돌리면 다음 BWT의 잔류 tmp 정리가 정본을 삭제할 수 있다.
        // 백업이 없는 신규 파일만 제거하고, 기존 파일은 outer rollback이 .bak에서 복원한다.
        for (const { original } of committed) {
          const backup = this.bakFiles.find(item => item.original === original);
          if (!backup) {
            try { if (fs.existsSync(original)) fs.unlinkSync(original); } catch { /* rollback에서 보고 */ }
          }
        }
        throw err; // execute()의 catch → _rollback() 호출
      }
    }

    try {
      this._syncToSqlite(parsed);
    } catch (error) {
      error.step = 9;
      throw error;
    }

    // DB까지 반영된 뒤 .bak을 정리한다.
    for (const { bak } of this.bakFiles) {
      try {
        fs.unlinkSync(bak);
      } catch {
        // .bak 정리 실패는 다음 부트에서 감지/정리
      }
    }
    this.bakFiles = [];
    this.tmpFiles = [];

    // links.jsonl 자동 compact (1MB 초과 시)
    this._autoCompactLinks();
  }
  // --- links.jsonl 자동 compact ---
  _autoCompactLinks() {
    try {
      const { isCompactNeeded, compactLinks } = require("./links");
      if (!isCompactNeeded(this.brainRoot)) return;

      const recordsPath = path.join(this.indexDir, "records.jsonl");
      const records = readJsonl(recordsPath);
      const { before, after } = compactLinks(this.brainRoot, records);

      const savedKB = Math.round((before - after) * 150 / 1024); // 링크당 ~150bytes 추정
      process.stdout.write(
        `\n⚡ links 자동 정리: ${before.toLocaleString()}개 → ${after.toLocaleString()}개 (약 ${savedKB}KB 절약)\n`
      );
    } catch {
      // compact 실패는 조용히 무시 — 핵심 트랜잭션에 영향 없음
    }
  }

  // --- SQLite 동기화 ---
  _syncToSqlite(parsed) {
    if (parsed.action === "delete") return;

    const { isDbAvailable, getDb, insertRecord, upsertRecord } = require("./db");
    if (!isDbAvailable(this.brainRoot)) {
      if (parsed.action === "create") {
        throw new Error("records.db가 없어 신규 recordId를 안전하게 저장할 수 없습니다.");
      }
      return;
    }

    const records = readJsonl(path.join(this.indexDir, "records.jsonl"));
    const record = records.find(item => item.recordId === parsed.recordId);
    if (!record) {
      throw new Error(`SQLite 동기화 대상 레코드 미발견: ${parsed.recordId}`);
    }

    const db = getDb(this.brainRoot);
    try {
      if (parsed.action === "create") {
        insertRecord(db, record);
      } else {
        upsertRecord(db, record);
      }
    } finally {
      db.close();
    }
  }
  // --- Step 9b: rollback ---
  _rollback() {
    const restoreFailures = [];
    const restoredBackups = new Set();

    // .bak -> 원본 복원을 먼저 끝낸 뒤 .tmp를 정리한다.
    for (const { original, bak } of this.bakFiles) {
      try {
        if (fs.existsSync(bak)) {
          copyFileWithRetry(bak, original);
          if (!fs.existsSync(original) || fs.statSync(original).size !== fs.statSync(bak).size) {
            throw new Error(`백업 복원 크기 불일치: ${original}`);
          }
          fs.unlinkSync(bak);
          restoredBackups.add(bak);
        }
      } catch (error) {
        restoreFailures.push(`${original}: ${error.message}`);
      }
    }

    for (const tmpFile of this.tmpFiles) {
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch (error) {
        restoreFailures.push(`${tmpFile}: ${error.message}`);
      }
   }

    this.bakFiles = this.bakFiles.filter(item => !restoredBackups.has(item.bak));
    if (restoreFailures.length === 0) {
      this.bakFiles = [];
    }
    this.tmpFiles = [];
    return restoreFailures;
  }

  // --- 헬퍼: 영향받는 파일 목록 ---
  _getAffectedFiles(parsed) {
    const files = [
      path.join(this.indexDir, "records.jsonl"),
      path.join(this.indexDir, "manifest.json"),
      path.join(this.indexDir, "records_digest.txt")
    ];

    if (parsed.sourceRef && ["create", "update", "delete"].includes(parsed.action)) {
      const docPath = path.join(this.brainRoot, parsed.sourceRef);
      if (fs.existsSync(docPath)) {
        files.push(docPath);
      }
    }

    return files;
  }

  // --- 헬퍼: 카테고리 결정 ---
  _categorize(sourceRef) {
    if (sourceRef.startsWith("00_user/")) return "user";
    if (sourceRef.startsWith("10_projects/")) return "project";
    if (sourceRef.startsWith("20_agents/")) return "agent";
    if (sourceRef.startsWith("30_topics/")) return "topic";
    if (sourceRef.startsWith("40_wiki/")) return "wiki";
    if (sourceRef.startsWith("90_index/")) return "index";
    if (sourceRef.startsWith("99_policy/")) return "policy";
    return "other";
  }

  // --- 헬퍼: summary 재계산 ---
  _computeSummary(files) {
    const summary = {
      totalFiles: files.length,
      byCategory: { policy: 0, user: 0, project: 0, agent: 0, topic: 0, wiki: 0, index: 0 }
    };
    for (const f of files) {
      if (summary.byCategory[f.category] !== undefined) {
        summary.byCategory[f.category]++;
      }
    }
    return summary;
  }
}

module.exports = { BWTEngine, BWT_LOCK_TIMEOUT_MS };
