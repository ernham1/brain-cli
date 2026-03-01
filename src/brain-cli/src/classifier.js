"use strict";

const { normalizeTokens, stemKorean } = require("./utils");

/**
 * REQ-110: classify(message, strategies, synonymMap)
 * 메시지를 분석하여 최적의 메타기억 전략을 매칭하는 상황 분류기.
 *
 * @param {string} message - 사용자 메시지 문자열
 * @param {Array<{record: Object, content: Object}>} strategies - loadMetaStrategies() 결과의 strategies 배열
 * @param {Map<string, string[]>} synonymMap - loadSynonyms() 결과
 * @returns {{ matched: boolean, primary: {strategy: Object, score: number}|null, secondary: {strategy: Object, score: number}|null, fallback: boolean }}
 */
function classify(message, strategies, synonymMap) {
  // REQ-111 + REQ-206: 메시지 토큰화 (한글 스테밍 적용)
  const messageTokens = normalizeTokens(message);
  const messageTokenCount = messageTokens.length;

  // REQ-112: 빈 메시지 즉시 반환 (0 나눗셈 방지)
  if (messageTokenCount === 0) {
    return { matched: false, primary: null, secondary: null, fallback: true };
  }

  // REQ-113~114: 전략별 matchScore 산출 + normalizedScore
  const scoredStrategies = [];

  for (const { content: strategyContent } of strategies) {
    let matchScore = 0;
    const triggerPatterns = strategyContent.trigger_pattern || [];

    for (const token of messageTokens) {
      for (const pattern of triggerPatterns) {
        const patternLower = pattern.toLowerCase();
        // REQ-208: trigger_pattern에도 stemKorean 적용
        const stemmedPattern = stemKorean(patternLower);

        if (token === patternLower || token === stemmedPattern) {
          // exact match (원본 또는 stem 매칭): +1.0
          matchScore += 1.0;
        } else {
          // REQ-207: 양방향 동의어 조회
          const tokenSynonyms = synonymMap.get(token) || [];
          const patternSynonyms = synonymMap.get(stemmedPattern) || [];
          // REQ-211: stem된 형태로 동의어 비교
          if (tokenSynonyms.some(s => s.toLowerCase() === patternLower || s.toLowerCase() === stemmedPattern) ||
              patternSynonyms.some(s => s.toLowerCase() === token)) {
            matchScore += 0.7;
          } else if (patternLower.includes(token) || stemmedPattern.includes(token)) {
            // substring match: +0.5 (pattern이 token을 포함)
            matchScore += 0.5;
          }
        }
      }
    }

    // REQ-114: normalizedScore
    const normalizedScore = matchScore / messageTokenCount;
    scoredStrategies.push({ strategy: strategyContent, score: normalizedScore });
  }

  // REQ-115: 내림차순 정렬
  scoredStrategies.sort((a, b) => b.score - a.score);

  // REQ-116: primary 선정 (score >= 0.4)
  const first = scoredStrategies[0];
  let primary = null;
  if (first && first.score >= 0.4) {
    primary = { strategy: first.strategy, score: first.score };
  }

  // REQ-118: 모든 score < 0.4 → fallback
  if (primary === null) {
    return { matched: false, primary: null, secondary: null, fallback: true };
  }

  // REQ-117: secondary 선정 (score >= 0.25 + step cap <= 5)
  let secondary = null;
  const second = scoredStrategies[1];
  if (second && second.score >= 0.25) {
    const primarySteps = (primary.strategy.recall_sequence || []).length;
    const secondarySteps = (second.strategy.recall_sequence || []).length;
    // REQ-119: step 합계 > 5 → secondary=null
    if (primarySteps + secondarySteps <= 5) {
      secondary = { strategy: second.strategy, score: second.score };
    }
  }

  return { matched: true, primary, secondary, fallback: false };
}

module.exports = { classify };
