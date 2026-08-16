"use strict";

const fs = require("fs");
const path = require("path");
const { readJsonl, loadSynonyms, normalizeTokens, stemKorean, normalizeScopeIdForRecordId } = require("./utils");
const { getLinkedBoosts, readLinks } = require("./links");

// REQ-054: sourceType별 신뢰도 계수
const TRUST_COEFFICIENTS = {
  user_confirmed: 1.5,
  candidate: 1.0,
  inference: 0.7,
  chat_log: 0.5,
  external_doc: 1.0
};

const ORIGINAL_CHUNK_PREVIEW_LENGTH = 200;

// 레이어 에스컬레이션 임계값 (실제 점수 분포 기반)
// L0: 16~22점 = 강한 히트, L1: 3~5점 = 양호한 히트
const LAYER_THRESHOLDS = {
  L0: { minScore: 8.0 },
  L1: { minScore: 3.0 },
};

const QUERY_TYPES = new Set(["temporal", "factual", "relational", "exploratory"]);

const SEARCH_CONFIGS = {
  temporal: {
    queryType: "temporal",
    timeDecayRate: 0.04,
    exactBoost: 0.75,
    factLedgerFirst: false,
    graphTraversal: false,
    linkSeedCount: 3
  },
  factual: {
    queryType: "factual",
    timeDecayRate: 0.01,
    exactBoost: 1.5,
    factLedgerFirst: true,
    graphTraversal: false,
    linkSeedCount: 3
  },
  relational: {
    queryType: "relational",
    timeDecayRate: 0.015,
    exactBoost: 0.75,
    factLedgerFirst: true,
    graphTraversal: true,
    linkSeedCount: 5
  },
  exploratory: {
    queryType: "exploratory",
    timeDecayRate: 0.01,
    exactBoost: 0.5,
    factLedgerFirst: false,
    graphTraversal: false,
    linkSeedCount: 3
  }
};

/**
 * 멀티레이어 검색 (L0 -> L1 -> L1.5-lite -> L2 에스컬레이션)
 *
 * L0: records_digest.txt 스캔 (~1ms) — 강한 히트 시 즉시 반환
 * L1: SQLite FTS5 (~10ms) — L0 부족 시 실행
 * L1.5-lite: Fact Ledger/links.jsonl 기반 관계 확장 — factual/relational query에서 실행
 * L2: FTS5 + 벡터 하이브리드 (~100ms) — L1.5까지 부족 시 실행
 *
 * @param {string} brainRoot - Brain/ 절대 경로
 * @param {Object} query
 * @param {string} query.scopeType - 스코프 타입
 * @param {string} [query.scopeId] - 스코프 ID
 * @param {string} [query.currentGoal] - 검색 목표 텍스트
 * @param {number} [query.topK] - 상위 N건 (기본 10)
 * @param {string} [query.type] - 레코드 타입 필터
 * @param {Array} [query.queryEmbedding] - 벡터 임베딩 (L2용)
 * @param {number} [query.forceLayer] - 강제 레이어 지정 (0|1|2, 디버깅용)
 * @param {string} [query.queryType] - 강제 query type 지정
 * @param {Object} [sessionContext] - 세션 컨텍스트
 * @returns {{ candidates: Array, total: number, queryType: string, searchPlan: Object }}
 */
function search(brainRoot, query = {}, sessionContext) {
  const currentGoal = _getSearchGoal(query);
  const goalTokens = normalizeTokens(currentGoal);
  const topK = (query.topK > 0)
    ? query.topK
    : _adaptiveTopK(goalTokens);
  const synonymMap = loadSynonyms(brainRoot);
  const expandedTokens = _expandTokens(goalTokens, synonymMap);
  const forceLayer = query.forceLayer ?? null;
  const queryType = _normalizeQueryType(query.queryType) || _classifyQueryType(currentGoal, goalTokens);
  const searchConfig = _getSearchConfig(queryType);
  const finish = (scored) => _finishSearch(scored, topK, brainRoot, sessionContext, queryType, searchConfig);
  if (/^rec_[a-z0-9_-]+$/i.test(currentGoal)) {
    const exactRecord = getRecordDetail(brainRoot, currentGoal);
    if (exactRecord && _passesQueryFilters(exactRecord, query)) {
      return finish([{
        ..._recordToCandidate(exactRecord), score: 1000000, _layer: "ID"
      }]);
    }
  }

  const factResults = currentGoal && searchConfig.factLedgerFirst
    ? _searchFactLedger(brainRoot, { ...query, currentGoal }, expandedTokens, sessionContext, topK, searchConfig)
    : [];

  // L0: digest 스캔 (항상 실행)
  const l0Results = _searchL0(brainRoot, query, expandedTokens, sessionContext, searchConfig);

  const mergedFactL0 = _mergeByRecordId([factResults, l0Results]);
  const stopAtL0 = !currentGoal
    || forceLayer === 0
    || (!searchConfig.graphTraversal && _isSufficient(mergedFactL0, LAYER_THRESHOLDS.L0, topK));

  if (stopAtL0) {
    return finish(mergedFactL0);
  }

  // L1: SQLite FTS5 (DB 있을 때)
  let l1Results = [];
  let db = null;
  let dbModule = null;

  try {
    dbModule = require("./db");
  } catch {
    // db 모듈 없으면 L1/L2 skip
  }

  if (dbModule && dbModule.isDbAvailable(brainRoot)) {
    try {
      db = dbModule.getDb(brainRoot);
      l1Results = _searchL1(db, { ...query, currentGoal }, expandedTokens, sessionContext, topK, dbModule.searchFts, searchConfig);
    } catch {
      if (db) {
        try { db.close(); } catch { /* ignore */ }
      }
      db = null;
      l1Results = [];
    }
  }

  let originalChunkResults = [];
  if (db && currentGoal && dbModule.searchOriginalChunks && forceLayer !== 0) {
    originalChunkResults = _searchOriginalChunks(
      db,
      { ...query, currentGoal },
      expandedTokens,
      sessionContext,
      topK,
      dbModule.searchOriginalChunks,
      searchConfig
    );
  }

  const merged01 = _mergeByRecordId([factResults, l0Results, l1Results, originalChunkResults]);

  let l15Results = [];
  const shouldSearchL15 = currentGoal
    && forceLayer !== 0
    && forceLayer !== 1
    && (searchConfig.graphTraversal || !_isSufficient(merged01, LAYER_THRESHOLDS.L1, topK));

  if (shouldSearchL15) {
    const linkResults = _searchL15Lite(brainRoot, merged01, { ...query, currentGoal }, expandedTokens, sessionContext, topK, searchConfig);
    const graphResults = _searchMemoryGraph(brainRoot, merged01, { ...query, currentGoal }, expandedTokens, sessionContext, topK, searchConfig);
    l15Results = _mergeByRecordId([linkResults, graphResults]);
  }

  const merged0115 = _mergeByRecordId([merged01, l15Results]);

  const stopAtL1 = forceLayer === 1
    || !db
    || !query.queryEmbedding;

  if (stopAtL1) {
    if (db) db.close();
    return finish(merged0115);
  }

  // L2: 벡터 하이브리드 (임베딩 있을 때)
  let l2Results = [];
  if (dbModule.isVectorAvailable(db)) {
    l2Results = _searchL2(db, { ...query, currentGoal }, expandedTokens, sessionContext, topK, dbModule.hybridSearch, searchConfig);
  }
  db.close();

  const merged012 = _mergeByRecordId([factResults, l0Results, l1Results, originalChunkResults, l15Results, l2Results]);
  return finish(merged012);
}

function _getSearchGoal(query) {
  return String(query.currentGoal ?? query.goal ?? "").trim();
}

/**
 * L0: records_digest.txt 스캔
 */
function _searchL0(brainRoot, query, expandedTokens, sessionContext, searchConfig = SEARCH_CONFIGS.exploratory) {
  const digestPath = path.join(brainRoot, "90_index", "records_digest.txt");
  let records = _loadDigest(digestPath);

  records = records.filter(d => _passesQueryFilters(d, query));

  const scored = records.map(d => ({
    ...d,
    score: _scoreRecord(d, expandedTokens, sessionContext, searchConfig),
    _layer: "L0"
  }));

  return scored;
}

/**
 * L1: SQLite FTS5 검색
 */
function _searchL1(db, query, expandedTokens, sessionContext, topK, searchFts, searchConfig = SEARCH_CONFIGS.exploratory) {
  const opts = {
    scopeType: query.scopeType,
    scopeId: query.scopeId,
    type: query.type,
    topK: topK * 3
  };
  const rawResults = searchFts(db, query.currentGoal, opts);

  return rawResults.map(d => ({
    ...d,
    score: _scoreRecord(d, expandedTokens, sessionContext, searchConfig),
    _layer: "L1"
  }));
}

/**
 * L2: FTS5 + 벡터 하이브리드 검색
 */
function _searchL2(db, query, expandedTokens, sessionContext, topK, hybridSearch, searchConfig = SEARCH_CONFIGS.exploratory) {
  const opts = {
    scopeType: query.scopeType,
    scopeId: query.scopeId,
    type: query.type,
    topK: topK * 3
  };
  const rawResults = hybridSearch(db, query.currentGoal, query.queryEmbedding, opts);

  return rawResults.map(d => ({
    ...d,
    score: _scoreRecord(d, expandedTokens, sessionContext, searchConfig),
    _layer: "L2"
  }));
}

function _searchOriginalChunks(db, query, expandedTokens, sessionContext, topK, searchOriginalChunks, searchConfig = SEARCH_CONFIGS.exploratory) {
  const opts = {
    scopeType: query.scopeType,
    scopeId: query.scopeId,
    type: query.type,
    topK: topK * 3
  };
  const rawResults = searchOriginalChunks(db, query.currentGoal, opts);

  return rawResults.map(d => ({
    ...d,
    score: (_scoreRecord(d, expandedTokens, sessionContext, searchConfig) * 0.35) + _scoreOriginalChunk(d, expandedTokens),
    _layer: "ORIGINAL"
  }));
}
function _searchFactLedger(brainRoot, query, expandedTokens, sessionContext, topK, searchConfig = SEARCH_CONFIGS.factual) {
  try {
    const { listFacts } = require("./fact-ledger");
    const facts = listFacts(brainRoot, { scopeId: query.scopeId, status: "active" });
    if (facts.length === 0) return [];

    const indexes = _loadRecordIndexes(brainRoot);
    const candidates = [];
    for (const fact of facts) {
      if (query.scopeType && fact.scopeType && fact.scopeType !== query.scopeType) continue;
      const factScore = _scoreFact(fact, expandedTokens, query.currentGoal);
      if (factScore <= 0) continue;

      const records = _recordsForFact(fact, indexes).filter(record => _passesQueryFilters(record, query));
      for (const record of records) {
        const candidate = _recordToCandidate(record);
        const score = _scoreRecord(candidate, expandedTokens, sessionContext, searchConfig) + factScore + 6.0;
        candidates.push({
          ...candidate,
          score,
          _layer: "FACT",
          _factBoost: factScore,
          factIds: [fact.factId].filter(Boolean)
        });
      }
    }
    return _mergeByRecordId([candidates]).slice(0, topK * 3);
  } catch {
    return [];
  }
}

function _searchL15Lite(brainRoot, seedResults, query, expandedTokens, sessionContext, topK, searchConfig = SEARCH_CONFIGS.relational) {
  try {
    const seeds = seedResults
      .filter(item => item && item.recordId && item.status !== "deprecated" && (item.score || 0) > 0)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, searchConfig.linkSeedCount || 3);
    if (seeds.length === 0) return [];

    const links = readLinks(brainRoot);
    if (links.length === 0) return [];

    const seedById = new Map(seeds.map(seed => [seed.recordId, seed]));
    const seedIds = new Set(seedById.keys());
    const { byId } = _loadRecordIndexes(brainRoot);
    const candidates = [];

    for (const link of links) {
      const fromSeed = seedIds.has(link.fromId);
      const toSeed = seedIds.has(link.toId);
      if (!fromSeed && !toSeed) continue;

      const linkedId = fromSeed ? link.toId : link.fromId;
      if (seedIds.has(linkedId)) continue;
      const linkedRecord = byId.get(linkedId);
      if (!linkedRecord || !_passesQueryFilters(linkedRecord, query)) continue;

      const seed = seedById.get(fromSeed ? link.fromId : link.toId);
      const candidate = _recordToCandidate(linkedRecord);
      const relationWeight = _linkTypeWeight(link.linkType);
      const relevance = _scoreRecord(candidate, expandedTokens, sessionContext, searchConfig);
      candidates.push({
        ...candidate,
        score: ((seed.score || 0) * 0.55) + relationWeight + (relevance * 0.35),
        _layer: "L1.5",
        linkedFrom: [seed.recordId],
        linkType: link.linkType || "related"
      });
    }

    return _mergeByRecordId([candidates]).slice(0, topK * 3);
  } catch {
    return [];
  }
}

function _searchMemoryGraph(brainRoot, seedResults, query, expandedTokens, sessionContext, topK, searchConfig = SEARCH_CONFIGS.relational) {
  try {
    const { buildMemoryGraphBrief } = require("./memory-graph");
    const graph = buildMemoryGraphBrief(brainRoot, {
      scopeId: query.scopeId,
      project: query.scopeId,
      goal: query.currentGoal,
      topK: Math.max(topK * 2, 8),
      logActivation: false
    });
    const indexes = _loadRecordIndexes(brainRoot);
    const seedScore = seedResults
      .filter(seed => seed && seed.recordId)
      .reduce((max, seed) => Math.max(max, seed.score || 0), 0);
    const candidates = [];

    for (const node of graph.activatedNodes || []) {
      const records = _recordsForGraphNode(node, indexes).filter(record => _passesQueryFilters(record, query));
      for (const record of records) {
        const candidate = _recordToCandidate(record);
        const graphScore = Number(node.activationScore || 0) * 8;
        candidates.push({
          ...candidate,
          score: (seedScore * 0.35) + graphScore + (_scoreRecord(candidate, expandedTokens, sessionContext, searchConfig) * 0.25),
          _layer: "GRAPH",
          graphNodeIds: [node.nodeId].filter(Boolean),
          graphNodeTypes: [node.nodeType].filter(Boolean)
        });
      }
    }

    for (const edge of graph.activatedEdges || []) {
      const records = _recordsForGraphRefs(edge.provenance || [], indexes).filter(record => _passesQueryFilters(record, query));
      for (const record of records) {
        const candidate = _recordToCandidate(record);
        const edgeWeight = Math.abs(Number(edge.weight) || 0.5) * 4;
        candidates.push({
          ...candidate,
          score: (seedScore * 0.25) + edgeWeight + (_scoreRecord(candidate, expandedTokens, sessionContext, searchConfig) * 0.2),
          _layer: "GRAPH",
          graphEdgeIds: [edge.edgeId].filter(Boolean),
          graphRelations: [edge.relation].filter(Boolean)
        });
      }
    }

    return _mergeGraphCandidates(candidates).slice(0, topK * 3);
  } catch {
    return [];
  }
}
/**
 * 단일 레코드 점수 계산 (L0/L1/L2 공통)
 * ftsRank/rrfScore 필드가 있으면 자동 반영
 */
function _scoreRecord(d, expandedTokens, sessionContext, searchConfig = SEARCH_CONFIGS.exploratory) {
  const relevanceScore = _calculateRelevance(d, expandedTokens);
  const timeFactor = _calculateTimeFactor(d.updatedAt, searchConfig.timeDecayRate);
  const trustFactor = _calculateTrustFactor(d.sourceType);
  const dedupFactor = _calculateDedupFactor(d.recordId, d.title, sessionContext);
  const lifecycleFactor = _calculateLifecycleFactor(d.updatedAt, d.lastRetrieved);
  const ftsBonus = d.ftsRank !== undefined ? Math.max(0, 5 + (d.ftsRank ?? 0) * 0.5) : 0;
  const rrfBonus = d.rrfScore !== undefined ? (d.rrfScore ?? 0) * 10 : 0;
  const exactBonus = searchConfig.exactBoost ? _calculateExactBonus(d, expandedTokens, searchConfig.exactBoost) : 0;
  return (relevanceScore + exactBonus + ftsBonus + rrfBonus) * timeFactor * trustFactor * dedupFactor * lifecycleFactor;
}

/**
 * 레이어 에스컬레이션이 필요한지 판단
 * 충분 조건: max score >= minScore
 */
function _isSufficient(scored, threshold, _topK) {
  if (scored.length === 0) return false;
  const maxScore = Math.max(...scored.map(d => d.score));
  return maxScore >= threshold.minScore;
}

/**
 * 여러 레이어 결과를 recordId 기준으로 병합
 * 같은 recordId가 여러 레이어에 있으면 높은 score 유지, _layer는 최고점 레이어로
 */
/**
 * Content-level dedup: title+summary가 동일한 레코드 중 최고 점수 1건만 유지.
 * 이미 score 내림차순으로 정렬된 배열을 입력으로 가정한다.
 * 중복 그룹의 대표 레코드에 _dedupCount를 태깅하여 몇 건이 합쳐졌는지 기록한다.
 */
function _deduplicateByContent(sorted) {
  const seen = new Map(); // contentKey -> index in result
  const result = [];
  for (const item of sorted) {
    const title = String(item.title || "").trim();
    const summary = String(item.summary || "").trim();
    const contentKey = `${item.type || ""}\x00${item.sourceType || ""}\x00${title}\x00${summary}`;
    const existingIdx = seen.get(contentKey);
    if (existingIdx !== undefined) {
      // 이미 더 높은 점수의 대표가 있으므로 skip, 카운트만 증가
      result[existingIdx]._dedupCount = (result[existingIdx]._dedupCount || 1) + 1;
      continue;
    }
    seen.set(contentKey, result.length);
    result.push(item);
  }
  return result;
}

function _mergeByRecordId(arrays) {
  const map = new Map();
  for (const arr of arrays) {
    for (const item of arr) {
      const existing = map.get(item.recordId);
      if (!existing || item.score > existing.score) {
        map.set(item.recordId, item);
      }
    }
  }
  return Array.from(map.values());
}

function _finishSearch(scored, topK, brainRoot, sessionContext, queryType, searchConfig) {
  const result = _finalize(scored, topK, brainRoot, sessionContext);
  result.queryType = queryType;
  result.searchPlan = {
    queryType,
    factLedgerFirst: Boolean(searchConfig.factLedgerFirst),
    graphTraversal: Boolean(searchConfig.graphTraversal),
    timeDecayRate: searchConfig.timeDecayRate,
    layers: Array.from(new Set(result.candidates.map(candidate => candidate._layer).filter(Boolean)))
  };
  return result;
}

/**
 * 최종 결과 정리: 링크 부스팅 -> content dedup -> 정렬 -> topK 슬라이스 -> sessionContext 갱신
 */
function _finalize(scored, topK, brainRoot, sessionContext) {
  scored.sort((a, b) => b.score - a.score);

  const top3Ids = scored.slice(0, 3).map(s => s.recordId);
  const linkBoosts = getLinkedBoosts(brainRoot, top3Ids);
  if (linkBoosts.size > 0) {
    for (const item of scored) {
      const boost = linkBoosts.get(item.recordId);
      if (boost) {
        item.score += 2.0 * boost;
        item.linkedFrom = top3Ids.filter(id => id !== item.recordId);
      }
    }
    scored.sort((a, b) => b.score - a.score);
  }

  // Content-level dedup: title+summary가 동일한 레코드 그룹에서 최고 점수 1건만 유지
  scored = _deduplicateByContent(scored);

  const candidates = scored.slice(0, topK);

  // Serendipity: 상위 결과와 다른 영역에서 1~2개 추천
  _addSerendipity(candidates, scored, topK);
  _attachOriginalChunkPreviews(brainRoot, candidates);

  _updateSessionContext(sessionContext, candidates);

  // 재귀적 기억 통합 힌트: 같은 scopeId에 5건+ 쌓인 주제를 감지
  const consolidationHints = _detectConsolidationCandidates(scored);

  return { candidates, total: scored.length, consolidationHints };
}

/**
 * 2-f) records.jsonl에서 개별 레코드 상세 조회
 */
function getRecordDetail(brainRoot, recordId) {
  const recordsPath = path.join(brainRoot, "90_index", "records.jsonl");
  const records = readJsonl(recordsPath);
  const jsonRecord = records.find(r => r.recordId === recordId);
  if (jsonRecord) return jsonRecord;

  const dbPath = path.join(brainRoot, "90_index", "records.db");
  if (!fs.existsSync(dbPath)) return null;
  let db;
  try {
    const Database = require("better-sqlite3");
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare(`
      SELECT record_id, scope_type, scope_id, type, title, summary, tags,
             source_ref, source_type, status, replaced_by, deprecation_reason,
             updated_at, content_hash, original_chunk
      FROM records WHERE record_id = ?
    `).get(recordId);
    if (!row) return null;
    let tags = [];
    try {
      const parsed = JSON.parse(row.tags || "[]");
      tags = Array.isArray(parsed) ? parsed : [];
    } catch {
      tags = String(row.tags || "").split(",").map(tag => tag.trim()).filter(Boolean);
    }
    return {
      recordId: row.record_id,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      type: row.type,
      title: row.title,
      summary: row.summary,
      tags,
      sourceType: row.source_type,
      sourceRef: row.source_ref,
      status: row.status,
      replacedBy: row.replaced_by || null,
      deprecationReason: row.deprecation_reason || null,
      updatedAt: row.updated_at,
      contentHash: row.content_hash,
      originalChunk: row.original_chunk || null,
    };
  } catch {
    return null;
  } finally {
    if (db) db.close();
  }
}

// --- 내부 헬퍼 ---

/**
 * records_digest.txt를 파싱하여 배열로 반환
 */
function _loadDigest(digestPath) {
  if (!fs.existsSync(digestPath)) return [];

  const content = fs.readFileSync(digestPath, "utf-8");
  const lines = content.split("\n");
  const results = [];

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const parts = line.split(" | ");
    if (parts.length < 5) continue;

    results.push({
      recordId: parts[0].trim(),
      title: parts[1].trim(),
      summary: parts[2].trim(),
      tags: parts[3].trim() ? parts[3].trim().split(",") : [],
      status: parts[4].trim(),
      type: parts.length > 5 ? parts[5].trim() || null : null,
      sourceType: parts.length > 6 ? parts[6].trim() || "candidate" : "candidate",
      updatedAt: parts.length > 7 ? parts[7].trim() || null : null
    });
  }

  return results;
}

/**
 * scopeType -> recordId 약어
 */
function _scopeAbbrev(scopeType) {
  const map = { project: "proj", agent: "agent", user: "user", topic: "topic" };
  return map[scopeType] || scopeType;
}

function _passesQueryFilters(record, query = {}) {
  if (!record || record.status !== "active") return false;
  if (query.scopeType) {
    const abbrev = _scopeAbbrev(query.scopeType);
    if (record.scopeType && record.scopeType !== query.scopeType) return false;
    if (!record.scopeType && !record.recordId.includes(`_${abbrev}_`)) return false;
  }
  if (query.scopeId) {
    if (record.scopeId && record.scopeId !== query.scopeId) return false;
    if (!record.scopeId) {
      const recordScopeId = normalizeScopeIdForRecordId(query.scopeId);
      if (!record.recordId.includes(`_${recordScopeId}_`)) return false;
    }
  }
  if (query.type && record.type !== query.type) return false;
  return true;
}

/**
 * REQ-050: expandedTokens 기반 가중치 반영 관련성 점수
 */
function _calculateRelevance(digest, expandedTokens) {
  if (!expandedTokens || expandedTokens.length === 0) return 0;

  let score = 0;
  const titleLower = String(digest.title || "").toLowerCase();
  const summaryLower = String(digest.summary || "").toLowerCase();
  const tagsStr = Array.isArray(digest.tags) ? digest.tags.join(" ").toLowerCase() : "";

  for (const { text, weight } of expandedTokens) {
    const tokenLower = String(text || "").toLowerCase();
    if (!tokenLower) continue;
    if (_containsSearchToken(titleLower, tokenLower))   score += 3 * weight;
    if (_containsSearchToken(summaryLower, tokenLower)) score += 2 * weight;
    if (_containsSearchToken(tagsStr, tokenLower))      score += 1 * weight;
  }

  return score;
}

function _containsSearchToken(text, tokenLower) {
  if (!tokenLower) return false;
  if (/^[a-z0-9_]{1,2}$/.test(tokenLower)) {
    return new RegExp(`(^|[^a-z0-9_])${tokenLower}([^a-z0-9_]|$)`, "i").test(text);
  }
  return text.includes(tokenLower);
}
function _calculateExactBonus(digest, expandedTokens, weight = 0.5) {
  if (!expandedTokens || expandedTokens.length === 0) return 0;
  const text = `${digest.title || ""} ${digest.summary || ""}`.toLowerCase();
  let bonus = 0;
  for (const token of expandedTokens) {
    const tokenText = String(token.text || "").toLowerCase();
    if (tokenText.length >= 3 && _containsSearchToken(text, tokenText)) {
      bonus += weight;
    }
  }
  return bonus;
}

/**
 * REQ-051, REQ-052: updatedAt 기반 시간 감쇠 계수
 */
function _calculateTimeFactor(updatedAt, decayRate = 0.01) {
  if (!updatedAt) return 1.0;
  const now = Date.now();
  const updated = new Date(updatedAt).getTime();
  if (isNaN(updated)) return 1.0;
  const days = (now - updated) / (1000 * 60 * 60 * 24);
  return 1 / (1 + days * decayRate);
}

/**
 * REQ-053, REQ-055: sourceType 기반 신뢰도 계수
 */
function _calculateTrustFactor(sourceType) {
  return TRUST_COEFFICIENTS[sourceType] || 1.0;
}

/**
 * REQ-056, REQ-057, REQ-062: 세션 내 중복 패널티 계수
 */
function _calculateDedupFactor(recordId, title, sessionContext) {
  if (!sessionContext) return 1.0;

  if (sessionContext.exposedIds.has(recordId)) {
    return 0.3;
  }

  for (const exposedTitle of sessionContext.exposedTitles) {
    if (_jaccardSimilarity(title, exposedTitle) > 0.8) {
      return 0.5;
    }
  }

  return 1.0;
}

/**
 * REQ-057: 단어 단위 Jaccard 유사도
 */
function _jaccardSimilarity(a, b) {
  const setA = new Set(String(a || "").toLowerCase().split(/\s+/).filter(t => t.length > 0));
  const setB = new Set(String(b || "").toLowerCase().split(/\s+/).filter(t => t.length > 0));

  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

/**
 * REQ-058: 새 SessionContext를 생성한다.
 */
function createSessionContext() {
  return {
    exposedIds: new Set(),
    exposedTitles: new Set()
  };
}

/**
 * REQ-059: 검색 결과를 sessionContext에 반영한다.
 */
function _updateSessionContext(sessionContext, candidates) {
  if (!sessionContext) return;
  for (const c of candidates) {
    sessionContext.exposedIds.add(c.recordId);
    sessionContext.exposedTitles.add(c.title);
  }
}

/**
 * goalTokens를 동의어로 확장하여 {text, weight, source} 배열을 반환한다.
 */
function _expandTokens(goalTokens, synonymMap) {
  const expanded = [];

  for (const token of goalTokens) {
    expanded.push({ text: token, weight: 1.0, source: "original" });

    const stemmed = stemKorean(token);
    if (stemmed !== token) {
      expanded.push({ text: stemmed, weight: 0.9, source: "stemmed" });
    }

    const lookupKey = stemmed.toLowerCase();
    const synonyms = synonymMap.get(lookupKey) || synonymMap.get(token.toLowerCase());
    if (synonyms) {
      for (const syn of synonyms) {
        expanded.push({ text: syn, weight: 0.7, source: "synonym" });
      }
    }
  }

  return expanded;
}

function _normalizeQueryType(queryType) {
  if (!queryType) return null;
  const normalized = String(queryType).trim().toLowerCase();
  return QUERY_TYPES.has(normalized) ? normalized : null;
}

function _classifyQueryType(currentGoal, goalTokens = normalizeTokens(currentGoal || "")) {
  const text = String(currentGoal || "").toLowerCase();
  if (!text.trim()) return "exploratory";

  const temporalScore = _patternScore(text, [
    /\b\d{4}-\d{2}-\d{2}\b/, /\b\d{1,2}\/\d{1,2}\b/,
    /오늘|어제|내일|최근|지난|금요일|토요일|일요일|월요일|화요일|수요일|목요일/,
    /변경|수정|업데이트|재시작|빌드|이력|언제|시점|기록/
  ]);
  const factualScore = _patternScore(text, [
    /뭐였|무엇|정확|확인|검증|상태|여부|맞음|가능|값|기준|어디|몇|완료|구현.*됨/
  ]);
  const relationalScore = _patternScore(text, [
    /관련|연결|연관|영향|의존|원인|왜|후속|다음|남은|이어|때문|관계|흐름|체인/
  ]);

  if (temporalScore >= 2 && temporalScore >= factualScore) return "temporal";
  if (relationalScore >= 1 && relationalScore >= factualScore) return "relational";
  if (factualScore >= 1) return "factual";
  if (goalTokens.length >= 6) return "exploratory";
  return "exploratory";
}

function _patternScore(text, patterns) {
  return patterns.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0);
}

function _getSearchConfig(queryType) {
  return SEARCH_CONFIGS[_normalizeQueryType(queryType) || "exploratory"];
}

function _scoreOriginalChunk(record, expandedTokens) {
  const text = String(record.originalChunk || "").toLowerCase();
  if (!text || !expandedTokens || expandedTokens.length === 0) return 0;
  let score = 0;
  for (const { text: token, weight } of expandedTokens) {
    const tokenLower = String(token || "").toLowerCase();
    if (tokenLower.length >= 2 && _containsSearchToken(text, tokenLower)) score += 0.9 * weight;
  }
  const rankBonus = record.originalRank !== undefined ? Math.max(0, 2 + (record.originalRank ?? 0) * 0.2) : 0;
  return score + rankBonus;
}
function _scoreFact(fact, expandedTokens, currentGoal) {
  const text = `${fact.subject || ""} ${fact.predicate || ""} ${fact.object || ""} ${(fact.sourceRefs || []).join(" ")}`.toLowerCase();
  let score = 0;
  for (const { text: token, weight } of expandedTokens) {
    const tokenLower = String(token || "").toLowerCase();
    if (tokenLower && _containsSearchToken(text, tokenLower)) score += 2 * weight;
  }
  const goal = String(currentGoal || "").toLowerCase();
  if (fact.subject && goal.includes(String(fact.subject).toLowerCase())) score += 2;
  if (fact.object && goal.includes(String(fact.object).toLowerCase())) score += 2;
  return score;
}

function _recordsForGraphNode(node, indexes) {
  const refs = [
    node.recordId,
    node.sourceRef,
    node.metadata?.factId,
    node.metadata?.sourceId,
    node.metadata?.canonicalId,
    ...(node.metadata?.sourceRefs || [])
  ].filter(Boolean);
  return _recordsForGraphRefs(refs, indexes);
}

function _recordsForGraphRefs(refs, indexes) {
  const records = [];
  const seen = new Set();
  for (const ref of refs || []) {
    const key = String(ref || "").trim();
    if (!key) continue;
    const candidates = [
      indexes.byId.get(key),
      indexes.bySourceRef.get(key),
      indexes.bySourceRef.get(key.replace(/\\/g, "/")),
      indexes.bySourceRef.get(path.basename(key))
    ].filter(Boolean);
    for (const record of candidates) {
      if (!seen.has(record.recordId)) {
        seen.add(record.recordId);
        records.push(record);
      }
    }
  }
  return records;
}

function _mergeGraphCandidates(candidates) {
  const byId = new Map();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.recordId);
    if (!existing) {
      byId.set(candidate.recordId, candidate);
      continue;
    }
    existing.score = Math.max(existing.score || 0, candidate.score || 0);
    existing.graphNodeIds = Array.from(new Set([...(existing.graphNodeIds || []), ...(candidate.graphNodeIds || [])]));
    existing.graphEdgeIds = Array.from(new Set([...(existing.graphEdgeIds || []), ...(candidate.graphEdgeIds || [])]));
    existing.graphRelations = Array.from(new Set([...(existing.graphRelations || []), ...(candidate.graphRelations || [])]));
  }
  return Array.from(byId.values()).sort((a, b) => (b.score || 0) - (a.score || 0));
}
function _recordsForFact(fact, indexes) {
  const records = [];
  const seen = new Set();
  for (const recordId of fact.sourceRecordIds || []) {
    const record = indexes.byId.get(recordId);
    if (record && !seen.has(record.recordId)) {
      seen.add(record.recordId);
      records.push(record);
    }
  }
  for (const sourceRef of fact.sourceRefs || []) {
    const record = indexes.bySourceRef.get(sourceRef);
    if (record && !seen.has(record.recordId)) {
      seen.add(record.recordId);
      records.push(record);
    }
  }
  return records;
}

function _loadRecordIndexes(brainRoot) {
  const records = readJsonl(path.join(brainRoot, "90_index", "records.jsonl"));
  const byId = new Map();
  const bySourceRef = new Map();
  for (const record of records) {
    byId.set(record.recordId, record);
    if (record.sourceRef) bySourceRef.set(record.sourceRef, record);
  }
  return { records, byId, bySourceRef };
}

function _recordToCandidate(record) {
  return {
    recordId: record.recordId,
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    type: record.type,
    title: record.title,
    summary: record.summary,
    tags: Array.isArray(record.tags) ? record.tags : [],
    sourceType: record.sourceType || "candidate",
    sourceRef: record.sourceRef || "",
    status: record.status || "active",
    updatedAt: record.updatedAt || null,
    lastRetrieved: record.lastRetrieved || null,
    originalChunk: record.originalChunk ?? null
  };
}

function _linkTypeWeight(linkType) {
  switch (linkType) {
    case "depends_on": return 3.0;
    case "replaced_by": return 2.5;
    case "see_also": return 2.0;
    case "related":
    default:
      return 1.5;
  }
}

/**
 * Adaptive Top-K: 검색어 토큰 수에 따라 반환 개수를 동적 조절한다.
 * - 토큰 1~2개 (구체적): 5개
 * - 토큰 3~4개 (보통): 10개
 * - 토큰 5개+ (모호/탐색): 15개
 */
function _adaptiveTopK(goalTokens) {
  const n = goalTokens.length;
  if (n <= 2) return 5;
  if (n <= 4) return 10;
  return 15;
}

/**
 * Serendipity Mode: 상위 결과와 다른 스코프에서 예상 못한 기억 1~2개를 추천한다.
 */
function _addSerendipity(topResults, allScored, topK) {
  if (topResults.length === 0 || allScored.length <= topK) return;

  const topScopes = new Set(topResults.map(r => r.recordId.split("_").slice(0, 3).join("_")));
  const topIds = new Set(topResults.map(r => r.recordId));

  const candidates = allScored.filter(r =>
    r.score > 0
    && !topIds.has(r.recordId)
    && !topScopes.has(r.recordId.split("_").slice(0, 3).join("_"))
  );

  if (candidates.length === 0) return;

  const totalScore = candidates.reduce((sum, c) => sum + c.score, 0);
  const pick = (arr) => {
    let r = Math.random() * totalScore;
    for (const c of arr) {
      r -= c.score;
      if (r <= 0) return c;
    }
    return arr[arr.length - 1];
  };

  const serendipity = pick(candidates);
  serendipity._serendipity = true;
  topResults.push(serendipity);
}

function _attachOriginalChunkPreviews(brainRoot, candidates) {
  if (!candidates || candidates.length === 0) return;
  const { byId } = _loadRecordIndexes(brainRoot);
  for (const candidate of candidates) {
    const detail = byId.get(candidate.recordId);
    const originalChunk = candidate.originalChunk ?? detail?.originalChunk;
    if (typeof originalChunk === "string" && originalChunk.trim()) {
      candidate.originalChunkPreview = _previewOriginalChunk(originalChunk);
    }
    if (Object.prototype.hasOwnProperty.call(candidate, "originalChunk")) {
      delete candidate.originalChunk;
    }
  }
}

function _previewOriginalChunk(originalChunk, maxLength = ORIGINAL_CHUNK_PREVIEW_LENGTH) {
  const compact = String(originalChunk || "").replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength)}...`;
}

/**
 * 재귀적 기억 통합 후보 감지.
 */
function _detectConsolidationCandidates(scored) {
  const scopeCounts = new Map();

  for (const item of scored) {
    if (item.score <= 0) continue;
    const parts = item.recordId.split("_");
    if (parts.length < 5) continue;
    const scopeId = parts.slice(2, -2).join("_");

    if (!scopeCounts.has(scopeId)) {
      scopeCounts.set(scopeId, []);
    }
    scopeCounts.get(scopeId).push({
      recordId: item.recordId,
      title: item.title,
      type: item.type
    });
  }

  const hints = [];
  for (const [scopeId, records] of scopeCounts) {
    if (records.length >= 5) {
      const typeCounts = new Map();
      for (const r of records) {
        const t = r.type || "note";
        if (!typeCounts.has(t)) typeCounts.set(t, []);
        typeCounts.get(t).push(r);
      }

      for (const [type, typeRecords] of typeCounts) {
        if (typeRecords.length >= 3) {
          hints.push({
            scopeId,
            type,
            count: typeRecords.length,
            recordIds: typeRecords.map(r => r.recordId),
            titles: typeRecords.map(r => r.title),
            message: `"${scopeId}" 주제에 ${type} 타입 기억이 ${typeRecords.length}건 있습니다. 공통 원칙으로 통합하면 검색 품질이 올라갑니다.`
          });
        }
      }
    }
  }

  return hints;
}

/**
 * 기억 수명주기: 검색에 노출된 레코드의 lastRetrieved를 갱신한다.
 */
function _calculateLifecycleFactor(updatedAt, lastRetrieved) {
  const ref = lastRetrieved || updatedAt;
  if (!ref) return 1.0;

  const days = (Date.now() - new Date(ref).getTime()) / (1000 * 60 * 60 * 24);
  if (days <= 90) return 1.0;
  if (days <= 180) return 0.7;
  return 0.4;
}

module.exports = {
  search,
  getRecordDetail,
  _expandTokens,
  createSessionContext,
  _loadDigest,
  _isSufficient,
  _mergeByRecordId,
  _deduplicateByContent,
  _getSearchGoal,
  _scoreRecord,
  _adaptiveTopK,
  _calculateLifecycleFactor,
  _classifyQueryType,
  _getSearchConfig,
  _searchFactLedger,
  _searchOriginalChunks,
  _searchL15Lite,
  _searchMemoryGraph,
  _previewOriginalChunk
};
