"use strict";

const fs = require("fs");
const path = require("path");
const { readJsonl } = require("./utils");

/**
 * 인덱스 검색 6단계
 *
 * 2-a) records_digest.txt 로드
 * 2-b) scopeType/scopeId로 1차 필터링
 * 2-c) status=active인 레코드만
 * 2-d) currentGoal 매칭 (태그/title/summary)
 * 2-e) 상위 5-10건 선정
 * 2-f) 상세 필요 시 records.jsonl 개별 조회
 *
 * @param {string} brainRoot - Brain/ 절대 경로
 * @param {Object} query
 * @param {string} query.scopeType - 스코프 타입 (필수)
 * @param {string} query.scopeId - 스코프 ID (선택, 미지정 시 scopeType 전체)
 * @param {string} query.currentGoal - 작업 목표 텍스트
 * @param {number} query.topK - 상위 N건 (기본 10)
 * @returns {{ candidates: Array, total: number }}
 */
function search(brainRoot, query) {
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

  // 2-d) currentGoal 매칭 (태그/title/summary 기준 점수 계산)
  const goal = (query.currentGoal || "").toLowerCase();
  const scored = filtered.map(d => ({
    ...d,
    score: _calculateRelevance(d, goal)
  }));

  // 점수순 정렬
  scored.sort((a, b) => b.score - a.score);

  // 2-e) 상위 topK건 선정
  const topK = query.topK || 10;
  const candidates = scored.slice(0, topK);

  return {
    candidates,
    total: filtered.length
  };
}

/**
 * 2-f) records.jsonl에서 개별 레코드 상세 조회
 *
 * @param {string} brainRoot - Brain/ 절대 경로
 * @param {string} recordId - 조회할 recordId
 * @returns {Object|null}
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
    // 주석/빈 줄 스킵
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const parts = line.split(" | ");
    if (parts.length < 5) continue;

    results.push({
      recordId: parts[0].trim(),
      title: parts[1].trim(),
      summary: parts[2].trim(),
      tags: parts[3].trim() ? parts[3].trim().split(",") : [],
      status: parts[4].trim()
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
 * currentGoal과의 관련성 점수 계산
 */
function _calculateRelevance(digest, goal) {
  if (!goal) return 0;

  let score = 0;
  const goalTokens = goal.split(/\s+/).filter(t => t.length > 1);

  // title 매칭 (가중치 3)
  const titleLower = digest.title.toLowerCase();
  for (const token of goalTokens) {
    if (titleLower.includes(token)) score += 3;
  }

  // summary 매칭 (가중치 2)
  const summaryLower = digest.summary.toLowerCase();
  for (const token of goalTokens) {
    if (summaryLower.includes(token)) score += 2;
  }

  // tags 매칭 (가중치 1)
  const tagsStr = digest.tags.join(" ").toLowerCase();
  for (const token of goalTokens) {
    if (tagsStr.includes(token)) score += 1;
  }

  return score;
}

module.exports = { search, getRecordDetail };
