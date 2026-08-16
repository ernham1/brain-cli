"use strict";

/**
 * SQLite FTS5 인덱스 모듈
 *
 * - records.jsonl이 소스 오브 트루스 (기존 BWT 유지)
 * - records.db는 검색 인덱스 (FTS5 + B-tree)
 * - DB 없으면 자동으로 기존 digest 방식으로 폴백
 */

const fs = require("fs");
const path = require("path");

const EMBEDDING_TEXT_MAX_LENGTH = 4000;

function _dbPath(brainRoot) {
  return path.join(brainRoot, "90_index", "records.db");
}

/**
 * DB 파일 존재 여부 확인 (설치 전 폴백용)
 */
function isDbAvailable(brainRoot) {
  try {
    require("better-sqlite3");
    return fs.existsSync(_dbPath(brainRoot));
  } catch {
    return false;
  }
}

/**
 * SQLite DB 연결 + 스키마 보장
 */
function getDb(brainRoot) {
  const Database = require("better-sqlite3");
  const db = new Database(_dbPath(brainRoot));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  _ensureSchema(db);
  return db;
}

function _ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      record_id          TEXT PRIMARY KEY,
      scope_type         TEXT,
      scope_id           TEXT,
      type               TEXT,
      title              TEXT NOT NULL DEFAULT '',
      summary            TEXT NOT NULL DEFAULT '',
      tags               TEXT DEFAULT '[]',
      source_ref         TEXT DEFAULT '',
      source_type        TEXT DEFAULT 'candidate',
      status             TEXT DEFAULT 'active',
      replaced_by        TEXT,
      deprecation_reason TEXT,
      updated_at         TEXT,
      content_hash       TEXT,
      original_chunk     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_records_status   ON records(status);
    CREATE INDEX IF NOT EXISTS idx_records_scope    ON records(scope_id, scope_type);
    CREATE INDEX IF NOT EXISTS idx_records_type     ON records(type);
    CREATE INDEX IF NOT EXISTS idx_records_updated  ON records(updated_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
      record_id  UNINDEXED,
      title,
      summary,
      tags,
      tokenize = 'unicode61 remove_diacritics 1'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS original_chunks_fts USING fts5(
      record_id  UNINDEXED,
      original_chunk,
      tokenize = 'unicode61 remove_diacritics 1'
    );
  `);

  // v3 마이그레이션: original_chunk 컬럼 추가 (선택 필드, FTS에 넣지 않음)
  _migrateOriginalChunk(db);
}

function _migrateOriginalChunk(db) {
  const columns = db.pragma("table_info(records)");
  const hasColumn = columns.some(c => c.name === "original_chunk");
  if (!hasColumn) {
    db.exec("ALTER TABLE records ADD COLUMN original_chunk TEXT");
  }
}

/**
 * 레코드 upsert (BWT 완료 후 동기화)
 * @param {object} db - better-sqlite3 DB 인스턴스
 * @param {object} record - records.jsonl 레코드 객체
 */
function upsertRecord(db, record) {
  const upsert = db.prepare(`
    INSERT INTO records
      (record_id, scope_type, scope_id, type, title, summary,
       tags, source_ref, source_type, status, replaced_by,
       deprecation_reason, updated_at, content_hash, original_chunk)
    VALUES
      (@record_id, @scope_type, @scope_id, @type, @title, @summary,
       @tags, @source_ref, @source_type, @status, @replaced_by,
       @deprecation_reason, @updated_at, @content_hash, @original_chunk)
    ON CONFLICT(record_id) DO UPDATE SET
      scope_type         = excluded.scope_type,
      scope_id           = excluded.scope_id,
      type               = excluded.type,
      title              = excluded.title,
      summary            = excluded.summary,
      tags               = excluded.tags,
      source_ref         = excluded.source_ref,
      source_type        = excluded.source_type,
      status             = excluded.status,
      replaced_by        = excluded.replaced_by,
      deprecation_reason = excluded.deprecation_reason,
      updated_at         = excluded.updated_at,
      content_hash       = excluded.content_hash,
      original_chunk     = excluded.original_chunk
  `);

  // FTS5 가상 테이블은 ON CONFLICT 미지원 → DELETE + INSERT 방식
  const deleteFts = db.prepare(`DELETE FROM records_fts WHERE record_id = ?`);
  const insertFts = db.prepare(`
    INSERT INTO records_fts (record_id, title, summary, tags)
    VALUES (@record_id, @title, @summary, @tags)
  `);
  const deleteOriginalFts = db.prepare(`DELETE FROM original_chunks_fts WHERE record_id = ?`);
  const insertOriginalFts = db.prepare(`
    INSERT INTO original_chunks_fts (record_id, original_chunk)
    VALUES (@record_id, @original_chunk)
  `);

  const row = {
    record_id:          record.recordId,
    scope_type:         record.scopeType ?? null,
    scope_id:           record.scopeId ?? null,
    type:               record.type ?? null,
    title:              record.title ?? "",
    summary:            record.summary ?? "",
    tags:               JSON.stringify(record.tags ?? []),
    source_ref:         record.sourceRef ?? "",
    source_type:        record.sourceType ?? "candidate",
    status:             record.status ?? "active",
    replaced_by:        record.replacedBy ?? null,
    deprecation_reason: record.deprecationReason ?? null,
    updated_at:         record.updatedAt ?? null,
    content_hash:       record.contentHash ?? null,
    original_chunk:     record.originalChunk ?? null,
  };

  db.transaction(() => {
    upsert.run(row);
    deleteFts.run(row.record_id);
    insertFts.run({
      record_id: row.record_id,
      title:     row.title,
      summary:   row.summary,
      tags:      Array.isArray(record.tags) ? record.tags.join(" ") : "",
    });
    deleteOriginalFts.run(row.record_id);
    if (row.original_chunk) {
      insertOriginalFts.run({
        record_id: row.record_id,
        original_chunk: row.original_chunk,
      });
    }
  })();
}

/**
 * 쓰기용 DB를 열고, 완전히 비어 있는 신규 DB만 기존 JSONL로 초기화한다.
 * 이후 recordId 발번은 반드시 이 DB의 전체 이력을 기준으로 한다.
 */
function getWriteDb(brainRoot) {
  const db = getDb(brainRoot);
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM records").get();
  if (count > 0) return db;

  const recordsPath = path.join(brainRoot, "90_index", "records.jsonl");
  if (!fs.existsSync(recordsPath)) return db;

  const { readJsonl } = require("./utils");
  for (const record of readJsonl(recordsPath)) {
    upsertRecord(db, record);
  }
  return db;
}

/**
 * records.db의 같은 scope/date 최대 순번 다음 recordId를 반환한다.
 */
function getNextRecordId(db, scopeType, scopeId) {
  const { generateRecordId } = require("./utils");
  const firstId = generateRecordId(scopeType, scopeId, []);
  const prefix = firstId.slice(0, -4);
  const { maxSequence } = db.prepare(`
    SELECT COALESCE(MAX(CAST(SUBSTR(record_id, ?) AS INTEGER)), 0) AS maxSequence
    FROM records
    WHERE record_id >= ? AND record_id < ?
  `).get(prefix.length + 1, prefix, `${prefix}\uffff`);

  return `${prefix}${String(maxSequence + 1).padStart(4, "0")}`;
}

function recordExists(db, recordId) {
  return Boolean(db.prepare("SELECT 1 FROM records WHERE record_id = ?").get(recordId));
}

/**
 * 신규 레코드 전용 INSERT. 기존 recordId는 절대 갱신하지 않는다.
 */
function insertRecord(db, record) {
  const insert = db.prepare(`
    INSERT INTO records
      (record_id, scope_type, scope_id, type, title, summary,
       tags, source_ref, source_type, status, replaced_by,
       deprecation_reason, updated_at, content_hash, original_chunk)
    VALUES
      (@record_id, @scope_type, @scope_id, @type, @title, @summary,
       @tags, @source_ref, @source_type, @status, @replaced_by,
       @deprecation_reason, @updated_at, @content_hash, @original_chunk)
  `);
  const deleteFts = db.prepare("DELETE FROM records_fts WHERE record_id = ?");
  const insertFts = db.prepare(`
    INSERT INTO records_fts (record_id, title, summary, tags)
    VALUES (@record_id, @title, @summary, @tags)
  `);
  const deleteOriginalFts = db.prepare("DELETE FROM original_chunks_fts WHERE record_id = ?");
  const insertOriginalFts = db.prepare(`
    INSERT INTO original_chunks_fts (record_id, original_chunk)
    VALUES (@record_id, @original_chunk)
  `);
  const row = {
    record_id:          record.recordId,
    scope_type:         record.scopeType ?? null,
    scope_id:           record.scopeId ?? null,
    type:               record.type ?? null,
    title:              record.title ?? "",
    summary:            record.summary ?? "",
    tags:               JSON.stringify(record.tags ?? []),
    source_ref:         record.sourceRef ?? "",
    source_type:        record.sourceType ?? "candidate",
    status:             record.status ?? "active",
    replaced_by:        record.replacedBy ?? null,
    deprecation_reason: record.deprecationReason ?? null,
    updated_at:         record.updatedAt ?? null,
    content_hash:       record.contentHash ?? null,
    original_chunk:     record.originalChunk ?? null,
  };

  db.transaction(() => {
    if (recordExists(db, row.record_id)) {
      const error = new Error(`recordId 충돌: ${row.record_id} — 기존 레코드를 덮어쓰지 않습니다.`);
      error.code = "BRAIN_RECORD_ID_COLLISION";
      throw error;
    }
    insert.run(row);
    deleteFts.run(row.record_id);
    insertFts.run({
      record_id: row.record_id,
      title: row.title,
      summary: row.summary,
      tags: Array.isArray(record.tags) ? record.tags.join(" ") : "",
    });
    deleteOriginalFts.run(row.record_id);
    if (row.original_chunk) {
      insertOriginalFts.run({
        record_id: row.record_id,
        original_chunk: row.original_chunk,
      });
    }
  })();
}
function insertRecords(db, records) {
  db.transaction(items => {
    for (const record of items) insertRecord(db, record);
  })(records);
}
/**
 * FTS5 키워드 검색
 * @param {object} db
 * @param {string} keyword - 검색어
 * @param {object} opts - { scopeType, scopeId, type, topK }
 * @returns {Array} 검색 결과 (digest 형식으로 변환)
 */
function searchOriginalChunks(db, keyword, opts = {}) {
  const { scopeType, scopeId, type, topK = 30 } = opts;
  const safeKeyword = _toSafeFtsQuery(keyword);
  if (!safeKeyword) return [];

  const conditions = ["r.status = 'active'", "r.original_chunk IS NOT NULL", "r.original_chunk != ''"];
  const params = [];

  if (scopeType) {
    const abbrev = _scopeAbbrev(scopeType);
    conditions.push(`r.record_id LIKE ?`);
    params.push(`%_${abbrev}_%`);
    if (scopeId) {
      conditions.push(`r.scope_id = ?`);
      params.push(scopeId);
    }
  }
  if (type) {
    conditions.push(`r.type = ?`);
    params.push(type);
  }

  const whereClause = conditions.map(c => `(${c})`).join(" AND ");

  try {
    const rows = db.prepare(`
      SELECT r.record_id, r.scope_type, r.scope_id, r.type,
             r.title, r.summary, r.tags, r.source_type,
             r.status, r.updated_at, r.original_chunk,
             fts.rank AS original_rank
      FROM original_chunks_fts fts
      JOIN records r ON r.record_id = fts.record_id
      WHERE original_chunks_fts MATCH ?
        AND ${whereClause}
      ORDER BY fts.rank
      LIMIT ?
    `).all(safeKeyword, ...params, topK);

    return rows.map(r => ({
      recordId:   r.record_id,
      scopeType:  r.scope_type,
      scopeId:    r.scope_id,
      type:       r.type,
      title:      r.title,
      summary:    r.summary,
      tags:       _parseTags(r.tags),
      sourceType: r.source_type,
      status:     r.status,
      updatedAt:  r.updated_at,
      originalChunk: r.original_chunk ?? null,
      originalRank: r.original_rank,
    }));
  } catch {
    return [];
  }
}
function searchFts(db, keyword, opts = {}) {
  const { scopeType, scopeId, type, topK = 30 } = opts;

  // FTS5 MATCH용 쿼리 — 특수문자 이스케이프
  const safeKeyword = keyword.replace(/["']/g, " ").trim();
  if (!safeKeyword) return [];

  const conditions = ["r.status = 'active'"];
  const params = [];

  if (scopeType) {
    // recordId에 scope 약어 포함 방식 유지
    const abbrev = _scopeAbbrev(scopeType);
    conditions.push(`r.record_id LIKE ?`);
    params.push(`%_${abbrev}_%`);
    if (scopeId) {
      conditions.push(`r.scope_id = ?`);
      params.push(scopeId);
    }
  }
  if (type) {
    conditions.push(`r.type = ?`);
    params.push(type);
  }

  const whereClause = conditions.map(c => `(${c})`).join(" AND ");

  try {
    const rows = db.prepare(`
      SELECT r.record_id, r.scope_type, r.scope_id, r.type,
             r.title, r.summary, r.tags, r.source_type,
             r.status, r.updated_at, r.original_chunk,
             fts.rank AS fts_rank
      FROM records_fts fts
      JOIN records r ON r.record_id = fts.record_id
      WHERE records_fts MATCH ?
        AND ${whereClause}
      ORDER BY fts.rank
      LIMIT ?
    `).all(safeKeyword, ...params, topK);

    return rows.map(r => ({
      recordId:   r.record_id,
      scopeType:  r.scope_type,
      scopeId:    r.scope_id,
      type:       r.type,
      title:      r.title,
      summary:    r.summary,
      tags:       _parseTags(r.tags),
      sourceType: r.source_type,
      status:     r.status,
      updatedAt:  r.updated_at,
      originalChunk: r.original_chunk ?? null,
      ftsRank:    r.fts_rank,
    }));
  } catch {
    // MATCH 구문 오류 시 빈 배열 반환 (폴백은 호출부에서)
    return [];
  }
}

/**
 * records.jsonl → SQLite 전체 마이그레이션
 * @param {string} brainRoot
 * @returns {{ migrated: number, skipped: number }}
 */
function migrateFromJsonl(brainRoot) {
  const { readJsonl } = require("./utils");
  const recordsPath = path.join(brainRoot, "90_index", "records.jsonl");

  if (!fs.existsSync(recordsPath)) {
    throw new Error(`records.jsonl 없음: ${recordsPath}`);
  }

  const db = getDb(brainRoot);
  const records = readJsonl(recordsPath);
  let migrated = 0;
  let skipped = 0;

  const batchUpsert = db.transaction((recs) => {
    for (const rec of recs) {
      try {
        upsertRecord(db, rec);
        migrated++;
      } catch {
        skipped++;
      }
    }
  });

  batchUpsert(records);
  db.close();

  return { migrated, skipped };
}

// ============================================================
// Phase 2 — 임베딩 벡터 검색 (sqlite-vec + multilingual-e5-small)
// 활성화 조건: brain-cli db embed 실행 후 record_vectors 테이블 존재
// ============================================================

/**
 * sqlite-vec 확장 로드 + vec0 테이블 생성
 * @param {object} db - better-sqlite3 인스턴스
 */
function _ensureVectorSchema(db) {
  try {
    const sqliteVec = require("sqlite-vec");
    sqliteVec.load(db);
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS record_vectors USING vec0(
        record_id TEXT PRIMARY KEY,
        embedding FLOAT[384]
      );
    `);
    return true;
  } catch {
    return false; // sqlite-vec 없거나 지원 안 되면 조용히 건너뜀
  }
}

/**
 * 벡터 테이블 존재 여부 (Phase 2 활성화 여부 판단)
 */
function isVectorAvailable(db) {
  try {
    if (!_ensureVectorSchema(db)) return false;
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='record_vectors'"
    ).get();
    return !!row;
  } catch {
    return false;
  }
}

/**
 * 텍스트 → 임베딩 벡터 생성 (multilingual-e5-small)
 * - 첫 호출 시 모델 자동 다운로드 (~120MB, ~/.cache/huggingface)
 * - 이후 캐시에서 즉시 로드
 * @param {string} text
 * @param {'query'|'passage'} role - e5 모델 접두사 구분
 * @returns {Promise<Float32Array>}
 */
async function embedText(text, role = "query") {
  const { pipeline } = await import("@huggingface/transformers");
  // 싱글톤 파이프라인 캐시
  if (!embedText._pipe) {
    embedText._pipe = await pipeline(
      "feature-extraction",
      "Xenova/multilingual-e5-small",
      { progress_callback: null }
    );
  }
  // multilingual-e5는 query:/passage: 접두사 필요
  const prefixed = `${role}: ${text}`;
  const output = await embedText._pipe(prefixed, { pooling: "mean", normalize: true });
  return output.data; // Float32Array (384차원)
}
embedText._pipe = null;

async function disposeEmbeddingPipeline() {
  const activePipeline = embedText._pipe;
  embedText._pipe = null;
  if (activePipeline && typeof activePipeline.dispose === "function") {
    await activePipeline.dispose();
  }
}

/**
 * 레코드 임베딩 저장
 */
function upsertVector(db, recordId, embedding) {
  // vec0 가상 테이블은 UPSERT 미지원 → DELETE + INSERT
  db.prepare(`DELETE FROM record_vectors WHERE record_id = ?`).run(recordId);
  db.prepare(`INSERT INTO record_vectors (record_id, embedding) VALUES (?, ?)`).run(recordId, embedding);
}

/**
 * 벡터 유사도 검색 (코사인 → vec0의 L2 distance로 근사)
 * @param {object} db
 * @param {Float32Array} queryEmbedding
 * @param {object} opts - { topK, status }
 * @returns {Array} - { recordId, distance }
 */
function searchVector(db, queryEmbedding, opts = {}) {
  const { topK = 30, scopeType, scopeId, type } = opts;
  try {
    if (!_ensureVectorSchema(db)) return [];

    const conditions = ["v.embedding MATCH ?", "k = ?", "r.status = 'active'"];
    const params = [queryEmbedding, topK];
    if (scopeType) {
      conditions.push("r.scope_type = ?");
      params.push(scopeType);
    }
    if (scopeId) {
      conditions.push("r.scope_id = ?");
      params.push(scopeId);
    }
    if (type) {
      conditions.push("r.type = ?");
      params.push(type);
    }

    const rows = db.prepare(`
      SELECT v.record_id, v.distance,
             r.scope_type, r.scope_id, r.type,
             r.title, r.summary, r.tags, r.source_type,
             r.status, r.updated_at, r.original_chunk
      FROM record_vectors v
      JOIN records r ON r.record_id = v.record_id
      WHERE ${conditions.join(" AND ")}
    `).all(...params);

    return rows.map(r => ({
      recordId:   r.record_id,
      scopeType:  r.scope_type,
      scopeId:    r.scope_id,
      type:       r.type,
      title:      r.title,
      summary:    r.summary,
      tags:       _parseTags(r.tags),
      sourceType: r.source_type,
      status:     r.status,
      updatedAt:  r.updated_at,
      originalChunk: r.original_chunk ?? null,
      vecDistance: r.distance,
    }));
  } catch {
    return [];
  }
}
/**
 * 전체 레코드 임베딩 배치 생성 (brain-cli db embed)
 * @param {string} brainRoot
 * @param {function} onProgress - (done, total) => void
 * @returns {Promise<{ embedded: number, skipped: number }>}
 */
/**
 * 하이브리드 검색: FTS5 + 벡터 → RRF 병합
 * RRF(Reciprocal Rank Fusion): score = Σ 1/(k + rank_i)
 * @param {object} db
 * @param {string} keyword
 * @param {Float32Array} queryEmbedding
 * @param {object} opts - { topK, scopeType, scopeId, type }
 * @returns {Array}
 */
function hybridSearch(db, keyword, queryEmbedding, opts = {}) {
  const { topK = 20, scopeType, scopeId, type } = opts;
  const K = 60;

  const ftsResults = searchFts(db, keyword, { scopeType, scopeId, type, topK: topK * 2 });
  const vecResults = searchVector(db, queryEmbedding, { topK: topK * 2, scopeType, scopeId, type });

  const scores = new Map();
  const meta = new Map();

  ftsResults.forEach((r, i) => {
    scores.set(r.recordId, (scores.get(r.recordId) ?? 0) + 1 / (K + i + 1));
    if (!meta.has(r.recordId)) meta.set(r.recordId, r);
  });
  vecResults.forEach((r, i) => {
    scores.set(r.recordId, (scores.get(r.recordId) ?? 0) + 1 / (K + i + 1));
    if (!meta.has(r.recordId)) meta.set(r.recordId, r);
  });

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([recordId, rrfScore]) => ({ ...meta.get(recordId), rrfScore }));
}
function _recordEmbeddingText(record) {
  return [record?.title, record?.summary, record?.original_chunk]
    .filter(value => typeof value === "string" && value.trim())
    .join("\n\n")
    .slice(0, EMBEDDING_TEXT_MAX_LENGTH)
    .trim();
}
async function batchEmbed(brainRoot, onProgress) {
  const db = getDb(brainRoot);
  if (!_ensureVectorSchema(db)) {
    db.close();
    throw new Error("sqlite-vec 로드 실패 — npm install sqlite-vec 확인");
  }

  // 아직 임베딩 없는 active 레코드만 처리
  const pending = db.prepare(`
    SELECT r.record_id, r.title, r.summary, r.original_chunk
    FROM records r
    LEFT JOIN record_vectors v ON r.record_id = v.record_id
    WHERE r.status = 'active' AND v.record_id IS NULL
  `).all();

  let embedded = 0;
  let skipped = 0;

  for (const rec of pending) {
    try {
      const text = _recordEmbeddingText(rec);
      const embedding = await embedText(text, "passage");
      upsertVector(db, rec.record_id, embedding);
      embedded++;
      if (onProgress) onProgress({ done: embedded + skipped, total: pending.length, recordId: rec.record_id });
    } catch {
      skipped++;
    }
  }

  db.close();
  return { embedded, skipped };
}

async function embedRecordById(brainRoot, recordId) {
  if (!recordId) return { embedded: 0, skipped: 1, reason: "record_id_missing" };

  const db = getDb(brainRoot);
  try {
    if (!_ensureVectorSchema(db)) {
      throw new Error("sqlite-vec 로드 실패 — npm install sqlite-vec 확인");
    }

    const record = db.prepare(`
      SELECT record_id, title, summary, original_chunk, status
      FROM records
      WHERE record_id = ?
    `).get(recordId);

    if (!record || record.status !== "active") {
      return { embedded: 0, skipped: 1, reason: "record_not_active", recordId };
    }

    const text = _recordEmbeddingText(record);
    if (!text) return { embedded: 0, skipped: 1, reason: "empty_embedding_text", recordId };

    const embedding = await embedText(text, "passage");
    upsertVector(db, record.record_id, embedding);
    return { embedded: 1, skipped: 0, recordId };
  } finally {
    db.close();
  }
}
function _toSafeFtsQuery(value) {
  return String(value || "")
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(token => token.length >= 2)
    .slice(0, 12)
    .map(token => /[A-Za-z0-9_]/.test(token) ? `${token}*` : token)
    .join(" ");
}
function _parseTags(tagsStr) {
  try { return JSON.parse(tagsStr); } catch { return []; }
}

function _scopeAbbrev(scopeType) {
  const map = { project: "proj", user: "user", agent: "agent", topic: "topic" };
  return map[scopeType] ?? scopeType;
}

module.exports = {
  isDbAvailable, getDb, getWriteDb, getNextRecordId, recordExists, insertRecord, insertRecords,
  upsertRecord, searchFts, migrateFromJsonl, searchOriginalChunks,
  // Phase 2
  isVectorAvailable, embedText, disposeEmbeddingPipeline, upsertVector, searchVector, hybridSearch, batchEmbed, embedRecordById,
};
