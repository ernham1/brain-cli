"use strict";

const fs = require("fs");
const path = require("path");
const { readJsonl, loadSynonyms, normalizeTokens, stemKorean } = require("./utils");
const { getLinkedBoosts } = require("./links");

// REQ-054: sourceType별 신뢰도 계수
const TRUST_COEFFICIENTS = {
  user_confirmed: 1.5,
  candidate: 1.0,
  inference: 0.7,
  chat_log: 0.5,
  external_doc: 1.0
};

/**
 * 인덱스 검색 6단계 + 통합 점수 엔진
 *
 * @param {string} brainRoot - Brain/ 절대 경로
 * @param {Object} query
 * @param {string} query.scopeType - 스코프 타입 (필수)
 * @param {string} query.scopeId - 스코프 ID (선택)
 * @param {string} query.currentGoal - 작업 목표 텍스트
 * @param {number} query.topK - 상위 N건 (기본 10)
 * @param {string} [query.type] - 레코드 타입 필터 (REQ-063)
 * @param {Object} [sessionContext] - 세션 컨텍스트 (REQ-061)
 * @returns {{ candidates: Array, total: number }}
 */
function search(brainRoot, query, sessionContext) {
  const indexDir = path.join(brainRoot, "90_index");

  // 2-a) records_digest.txt 로드
  const digestPath = path.join(indexDir, "records_digest.txt");
  const digestLines = _loadDigest(digestPath);

  // 2-b) scopeType/scopeId 1차 필터
  let filtered = digestLines;
  if (query.scopeType) {
    const scopeAbbrev = _scopeAbbrev(query.scopeType);
    filtered = filtered.filter(d => d.recordId.includes(`_${scopeAbbrev}_`));
    if (query.scopeId) {
      filtered = filtered.filter(d => d.recordId.includes(`_${query.scopeId}_`));
    }
  }

  // 2-c) status=active만
  filtered = filtered.filter(d => d.status === "active");

  // REQ-063: query.type 필터
  if (query.type) {
    filtered = filtered.filter(d => d.type === query.type);
  }

  // 2-d) expandedTokens 생성 + 통합 점수 산출 (REQ-206: 한글 스테밍 적용)
  const goalTokens = normalizeTokens(query.currentGoal || "");
  const synonymMap = loadSynonyms(brainRoot);
  const expandedTokens = _expandTokens(goalTokens, synonymMap);

  const scored = filtered.map(d => {
    const relevanceScore = _calculateRelevance(d, expandedTokens);
    const timeFactor = _calculateTimeFactor(d.updatedAt);
    const trustFactor = _calculateTrustFactor(d.sourceType);
    const dedupFactor = _calculateDedupFactor(d.recordId, d.title, sessionContext);
    const finalScore = relevanceScore * timeFactor * trustFactor * dedupFactor;
    return { ...d, score: finalScore };
  });

  // 점수순 정렬
  scored.sort((a, b) => b.score - a.score);

  // 2-d2) 링크 부스팅: 상위 3건에 연결된 레코드에 +2.0 가산
  const topK = query.topK || 10;
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

  // 2-e) 상위 topK건 선정
  const candidates = scored.slice(0, topK);

  // REQ-059: sessionContext 업데이트
  _updateSessionContext(sessionContext, candidates);

  return {
    candidates,
    total: filtered.length
  };
}

/**
 * 2-f) records.jsonl에서 개별 레코드 상세 조회
 */
function getRecordDetail(brainRoot, recordId) {
  const recordsPath = path.join(brainRoot, "90_index", "records.jsonl");
  const records = readJsonl(recordsPath);
  return records.find(r => r.recordId === recordId) || null;
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
 * scopeType → recordId 약어
 */
function _scopeAbbrev(scopeType) {
  const map = { project: "proj", agent: "agent", user: "user", topic: "topic" };
  return map[scopeType] || scopeType;
}

/**
 * REQ-050: expandedTokens 기반 가중치 반영 관련성 점수
 * @param {Object} digest - digest 레코드
 * @param {Array<{text: string, weight: number}>} expandedTokens - 확장 토큰 배열
 * @returns {number}
 */
function _calculateRelevance(digest, expandedTokens) {
  if (!expandedTokens || expandedTokens.length === 0) return 0;

  let score = 0;
  const titleLower = digest.title.toLowerCase();
  const summaryLower = digest.summary.toLowerCase();
  const tagsStr = digest.tags.join(" ").toLowerCase();

  for (const { text, weight } of expandedTokens) {
    const tokenLower = text.toLowerCase();
    if (titleLower.includes(tokenLower))   score += 3 * weight;
    if (summaryLower.includes(tokenLower)) score += 2 * weight;
    if (tagsStr.includes(tokenLower))      score += 1 * weight;
  }

  return score;
}

/**
 * REQ-051, REQ-052: updatedAt 기반 시간 감쇠 계수
 * @param {string|null} updatedAt - ISO 8601 날짜 문자열
 * @returns {number} timeFactor (0 < timeFactor <= 1.0)
 */
function _calculateTimeFactor(updatedAt) {
  if (!updatedAt) return 1.0;
  const now = Date.now();
  const updated = new Date(updatedAt).getTime();
  if (isNaN(updated)) return 1.0;
  const days = (now - updated) / (1000 * 60 * 60 * 24);
  return 1 / (1 + days * 0.01);
}

/**
 * REQ-053, REQ-055: sourceType 기반 신뢰도 계수
 * @param {string} sourceType
 * @returns {number}
 */
function _calculateTrustFactor(sourceType) {
  return TRUST_COEFFICIENTS[sourceType] || 1.0;
}

/**
 * REQ-056, REQ-057, REQ-062: 세션 내 중복 패널티 계수
 * @param {string} recordId
 * @param {string} title
 * @param {Object|null} sessionContext
 * @returns {number} 0.3 | 0.5 | 1.0
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
 * @param {string} a
 * @param {string} b
 * @returns {number} 0.0 ~ 1.0
 */
function _jaccardSimilarity(a, b) {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(t => t.length > 0));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(t => t.length > 0));

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
 * @returns {{ exposedIds: Set<string>, exposedTitles: Set<string> }}
 */
function createSessionContext() {
  return {
    exposedIds: new Set(),
    exposedTitles: new Set()
  };
}

/**
 * REQ-059: 검색 결과를 sessionContext에 반영한다.
 * @param {Object|null} sessionContext
 * @param {Array} candidates
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
 * 2-depth 확장 금지: goalTokens만 순회하여 구조적으로 보장.
 *
 * @param {string[]} goalTokens - 원본 토큰 배열
 * @param {Map<string, string[]>} synonymMap - 양방향 동의어 맵
 * @returns {Array<{text: string, weight: number, source: string}>}
 */
function _expandTokens(goalTokens, synonymMap) {
  const expanded = [];

  for (const token of goalTokens) {
    expanded.push({ text: token, weight: 1.0, source: "original" });

    // REQ-209, REQ-212: stem된 토큰이 원본과 다르면 추가 (weight: 0.9)
    const stemmed = stemKorean(token);
    if (stemmed !== token) {
      expanded.push({ text: stemmed, weight: 0.9, source: "stemmed" });
    }

    // REQ-211: stem된 형태로 동의어 조회
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

module.exports = { search, getRecordDetail, _expandTokens, createSessionContext, _loadDigest };
