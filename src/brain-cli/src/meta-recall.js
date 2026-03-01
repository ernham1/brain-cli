"use strict";

const fs = require("fs");
const path = require("path");
const { loadMetaStrategies } = require("./meta-strategy");
const { classify } = require("./classifier");
const { search, createSessionContext } = require("./search");
const { loadSynonyms, normalizeTokens } = require("./utils");

/**
 * REQ-120: 메타 recall 오케스트레이터
 *
 * 동작 순서:
 * 1. loadMetaStrategies(brainRoot) 호출
 * 2. loadSynonyms(brainRoot) 호출
 * 3. classify(message, strategies, synonymMap) 호출
 * 4. 분류 결과에 따라 전략 실행 또는 폴백
 *
 * @param {string} brainRoot - Brain 루트 디렉토리 경로
 * @param {string} message - 사용자 메시지
 * @param {object} options - { topK?: number }
 * @returns {{ candidates: Array, strategies_used: Array, fallback: boolean, totalSteps: number }}
 */
function metaRecall(brainRoot, message, options = {}) {
  // REQ-121: loadMetaStrategies 자체가 throw하는 경우도 catch
  let strategies;
  try {
    const loaded = loadMetaStrategies(brainRoot);
    strategies = loaded.strategies;
  } catch (_err) {
    return _fallbackSearch(brainRoot, message, options);
  }

  // REQ-121: 빈 배열 → 폴백
  if (strategies.length === 0) {
    return _fallbackSearch(brainRoot, message, options);
  }

  // REQ-120 step 2: 동의어 맵 로드
  const synonymMap = loadSynonyms(brainRoot);

  // REQ-120 step 3: 상황 분류
  const classification = classify(message, strategies, synonymMap);

  // REQ-130: 분류 실패 시 폴백
  if (classification.fallback) {
    return _fallbackSearch(brainRoot, message, options);
  }

  // REQ-120 step 4: 전략 실행
  const result = _executeStrategies(brainRoot, message, classification, options);

  // LINK-CHECK output: B08 소비를 위한 최근 사용 전략 기록
  _saveLastStrategy(brainRoot, classification, message);

  return result;
}

/**
 * REQ-121, REQ-130: 폴백 검색
 * 전략 로드 실패/빈 배열/분류 실패 시 기존 search() 1회 호출
 *
 * @param {string} brainRoot
 * @param {string} message
 * @param {object} options
 * @returns {{ candidates: Array, strategies_used: Array, fallback: boolean, totalSteps: number }}
 */
function _fallbackSearch(brainRoot, message, options) {
  // fallback 시에도 메시지 기록 (자기개선 루프에서 추적 가능하도록)
  try {
    const filePath = path.join(brainRoot, "90_index", ".meta_last_strategy");
    const data = {
      timestamp: new Date().toISOString(),
      message: message || "",
      primary: null,
      secondary: null,
      fallback: true
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch { /* 무시 */ }

  const searchResult = search(brainRoot, {
    currentGoal: message,
    topK: options.topK || 10
  });
  return {
    candidates: searchResult.candidates,
    strategies_used: [],
    fallback: true,
    totalSteps: 0
  };
}

/**
 * REQ-125, REQ-126, REQ-129: 전략 실행 + 결과 조립
 *
 * @param {string} brainRoot
 * @param {string} message
 * @param {object} classification - classify() 결과
 * @param {object} options
 * @returns {{ candidates: Array, strategies_used: Array, fallback: boolean, totalSteps: number }}
 */
function _executeStrategies(brainRoot, message, classification, options) {
  // REQ-125: 단일 SessionContext 생성
  const sessionContext = createSessionContext();

  // REQ-123 + REQ-206: {task_keywords} 치환용 토큰 추출 (한글 스테밍 적용)
  const taskKeywords = normalizeTokens(message).join(" ");

  // REQ-122: primary recall_sequence 순차 실행
  // NOTE: classifier는 content 객체를 strategy에 직접 저장하므로
  //       .strategy.recall_sequence 으로 접근 (not .strategy.content.recall_sequence)
  const primarySteps = classification.primary.strategy.recall_sequence;
  const primaryResults = _executeSequence(
    brainRoot,
    primarySteps,
    taskKeywords,
    sessionContext,
    options
  );

  // REQ-126: secondary 전략 실행 (있을 경우)
  let secondaryResults = [];
  let executedSecondaryStepCount = 0;
  if (classification.secondary) {
    // REQ-127: step 절단 적용
    const secondarySteps = _sliceSecondarySteps(classification);
    executedSecondaryStepCount = secondarySteps.length;
    secondaryResults = _executeSequence(
      brainRoot,
      secondarySteps,
      taskKeywords,
      sessionContext,
      options
    );
  }

  // REQ-129: 최종 결과 구조 조립
  const strategies_used = [];
  if (classification.primary) {
    strategies_used.push({
      name: classification.primary.strategy.name,
      score: classification.primary.score,
      role: "primary"
    });
  }
  if (classification.secondary) {
    strategies_used.push({
      name: classification.secondary.strategy.name,
      score: classification.secondary.score,
      role: "secondary"
    });
  }

  const totalSteps = primarySteps.length + executedSecondaryStepCount;

  return {
    candidates: _deduplicateResults([...primaryResults, ...secondaryResults]),
    strategies_used,
    fallback: false,
    totalSteps
  };
}

/**
 * REQ-122, REQ-123, REQ-124: recall_sequence 순차 실행
 *
 * @param {string} brainRoot
 * @param {Array} steps - recall_sequence 배열
 * @param {string} taskKeywords - 치환용 키워드 문자열
 * @param {object} sessionContext - createSessionContext() 인스턴스
 * @param {object} options
 * @returns {Array} 모든 step의 candidates를 합친 배열
 */
function _executeSequence(brainRoot, steps, taskKeywords, sessionContext, options) {
  const allResults = [];

  for (const step of steps) {
    // REQ-123 + REQ-219: {task_keywords} 템플릿 치환, 없으면 suffix 추가
    let queryText;
    if (step.query_template.includes("{task_keywords}")) {
      queryText = step.query_template.replace("{task_keywords}", taskKeywords);
    } else {
      queryText = taskKeywords
        ? `${step.query_template} ${taskKeywords}`
        : step.query_template;
    }

    const query = {
      currentGoal: queryText,
      topK: options.topK || 10
    };

    // REQ-124: type_filter가 null/undefined가 아닌 경우에만 전달
    if (step.type_filter !== null && step.type_filter !== undefined) {
      query.type = step.type_filter;
    }

    // search()는 { candidates, total }을 반환
    const stepResult = search(brainRoot, query, sessionContext);
    allResults.push(...stepResult.candidates);
  }

  return allResults;
}

/**
 * REQ-127: secondary step 절단 규칙
 * step 합계가 5를 초과하면 secondary를 앞에서부터 (5 - primary.steps)개만 취한다.
 *
 * @param {object} classification - classify() 결과
 * @returns {Array} 절단된 secondary steps
 */
function _sliceSecondarySteps(classification) {
  if (!classification.secondary) return [];

  const primaryStepCount = classification.primary.strategy.recall_sequence.length;
  const allowedSecondarySteps = Math.max(0, 5 - primaryStepCount);

  const secondarySequence = classification.secondary.strategy.recall_sequence;
  return secondarySequence.slice(0, allowedSecondarySteps);
}

/**
 * REQ-128: recordId 기준 dedup + score 내림차순 정렬
 *
 * @param {Array} allResults - 전체 step 결과
 * @returns {Array} 중복 제거 + 정렬된 결과
 */
function _deduplicateResults(allResults) {
  const scoreMap = new Map();

  for (const candidate of allResults) {
    const existing = scoreMap.get(candidate.recordId);
    if (!existing || candidate.score > existing.score) {
      scoreMap.set(candidate.recordId, candidate);
    }
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score);
}

/**
 * LINK-CHECK output: 최근 사용 전략을 .meta_last_strategy에 기록 (B08 소비)
 *
 * @param {string} brainRoot
 * @param {object} classification - classify() 결과
 * @param {string} message - 원본 사용자 메시지
 */
function _saveLastStrategy(brainRoot, classification, message) {
  try {
    const filePath = path.join(brainRoot, "90_index", ".meta_last_strategy");
    const data = {
      timestamp: new Date().toISOString(),
      message: message || "",
      primary: classification.primary
        ? { name: classification.primary.strategy.name, score: classification.primary.score }
        : null,
      secondary: classification.secondary
        ? { name: classification.secondary.strategy.name, score: classification.secondary.score }
        : null
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (_err) {
    // 기록 실패는 무시 — 핵심 기능이 아님
  }
}

module.exports = {
  metaRecall,
  _fallbackSearch,
  _executeStrategies,
  _executeSequence,
  _sliceSecondarySteps,
  _deduplicateResults,
  _saveLastStrategy
};
