"use strict";

const fs = require("fs");
const path = require("path");
const {
  calculateHash,
  calculateHashFromString,
  generateRecordId,
  readJsonl,
  writeJsonl,
  safeReadJson,
  generateDigestLine,
  isoNow,
  ensureDir
} = require("./utils");
const { validateIntent, validateRecord } = require("./schemas");
const { validate } = require("./validate");

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
  }

  /**
   * BWT 메인 실행 함수
   * @param {Object} intent - LLM이 생성한 Intent JSON
   * @returns {{ success: boolean, recordId?: string, report: Object }}
   */
  execute(intent) {
    try {
      // 동시성 방지: .tmp 잔류 파일 확인
      this._checkResidualTmp();

      // Step 1: Intent 파싱 및 검증
      const parsed = this._parseIntent(intent);

      // Step 2: .bak 백업 생성
      this._createBackups(parsed);

      // Step 3: 폴더 생성 (필요시)
      this._ensureFolders(parsed);

      // Step 4: 문서를 .tmp로 저장
      this._writeDocumentTmp(parsed);

      // Step 5: contentHash + records.jsonl.tmp
      this._updateRecordsTmp(parsed);

      // Step 6: manifest.json.tmp
      this._updateManifestTmp(parsed);

      // Step 7: records_digest.txt.tmp
      this._updateDigestTmp(parsed);

      // Step 8: validate
      const validation = validate(this.brainRoot, { tmpMode: true });
      if (!validation.passed) {
        this._rollback();
        return {
          success: false,
          report: {
            step: 8,
            message: "validate 실패",
            errors: validation.errors,
            warnings: validation.warnings
          }
        };
      }

      // Step 9: atomic rename
      this._commit();
      return {
        success: true,
        recordId: parsed.recordId,
        report: {
          action: parsed.action,
          recordId: parsed.recordId,
          warnings: validation.warnings
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
    }
  }

  // --- Step 0: 잔류 .tmp 확인 ---
  _checkResidualTmp() {
    const indexFiles = fs.readdirSync(this.indexDir);
    const tmpFiles = indexFiles.filter(f => f.endsWith(".tmp"));
    if (tmpFiles.length > 0) {
      const err = new Error(`잔류 .tmp 파일 감지: ${tmpFiles.join(", ")} — 이전 BWT가 미완료 상태입니다. 정리 후 재시도하세요.`);
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

    if (intent.action === "create") {
      // recordId 생성
      const existingRecords = readJsonl(path.join(this.indexDir, "records.jsonl"));
      parsed.recordId = generateRecordId(
        intent.record.scopeType,
        intent.record.scopeId,
        existingRecords
      );
    }

    return parsed;
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
    if (parsed.action === "create" && parsed.sourceRef) {
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
        if (parsed.content) {
          records[idx].contentHash = calculateHashFromString(parsed.content);
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

      data.files.push({
        path: parsed.sourceRef,
        hash: hash,
        size: size,
        updatedAt: now,
        category: category
      });
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
  _updateDigestTmp(parsed) {
    const recordsTmpPath = path.join(this.indexDir, "records.jsonl.tmp");
    const digestPath = path.join(this.indexDir, "records_digest.txt");
    const tmpPath = digestPath + ".tmp";

    const records = readJsonl(recordsTmpPath);
    const header = "# Brain records_digest.txt\n# Format: recordId | title | summary | tags | status\n# Auto-generated by brain-cli BWT. Do not edit manually.\n";
    const lines = records.map(r => generateDigestLine(r));

    this.tmpFiles.push(tmpPath);
    fs.writeFileSync(tmpPath, header + lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf-8");
  }

  // --- Step 9a: commit ---
  _commit() {
    // 모든 .tmp를 원본으로 rename (부분 실패 시 되돌림)
    const committed = [];
    for (const tmpFile of this.tmpFiles) {
      const originalPath = tmpFile.replace(/\.tmp$/, "");
      try {
        fs.renameSync(tmpFile, originalPath);
        committed.push({ tmp: tmpFile, original: originalPath });
      } catch (err) {
        // 이미 rename된 파일들을 .tmp로 되돌림
        for (const { tmp, original } of committed.reverse()) {
          try { fs.renameSync(original, tmp); } catch { /* best effort */ }
        }
        throw err; // execute()의 catch → _rollback() 호출
      }
    }
    // .bak 정리
    for (const { bak } of this.bakFiles) {
      try {
        fs.unlinkSync(bak);
      } catch {
        // .bak 정리 실패는 다음 부트에서 감지/정리
      }
    }
    this.bakFiles = [];
    this.tmpFiles = [];
  }

  // --- Step 9b: rollback ---
  _rollback() {
    // .tmp 삭제
    for (const tmpFile of this.tmpFiles) {
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch { /* ignore */ }
    }
    // .bak -> 원본 복원
    for (const { original, bak } of this.bakFiles) {
      try {
        if (fs.existsSync(bak)) {
          fs.copyFileSync(bak, original);
          fs.unlinkSync(bak);
        }
      } catch { /* 최선의 노력 복구 */ }
    }
    this.bakFiles = [];
    this.tmpFiles = [];
  }

  // --- 헬퍼: 영향받는 파일 목록 ---
  _getAffectedFiles(parsed) {
    const files = [
      path.join(this.indexDir, "records.jsonl"),
      path.join(this.indexDir, "manifest.json"),
      path.join(this.indexDir, "records_digest.txt")
    ];

    if (parsed.sourceRef && (parsed.action === "update" || parsed.action === "delete")) {
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
    if (sourceRef.startsWith("90_index/")) return "index";
    if (sourceRef.startsWith("99_policy/")) return "policy";
    return "other";
  }

  // --- 헬퍼: summary 재계산 ---
  _computeSummary(files) {
    const summary = {
      totalFiles: files.length,
      byCategory: { policy: 0, user: 0, project: 0, agent: 0, topic: 0, index: 0 }
    };
    for (const f of files) {
      if (summary.byCategory[f.category] !== undefined) {
        summary.byCategory[f.category]++;
      }
    }
    return summary;
  }
}

module.exports = { BWTEngine };
