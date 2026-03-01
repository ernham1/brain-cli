"use strict";

const fs = require("fs");
const path = require("path");
const { readJsonl, writeJsonl, isoNow, normalizeTokens } = require("./utils");

/**
 * 피드백 로그 파일 경로
 * @param {string} brainRoot
 * @returns {string}
 */
function _feedbackLogPath(brainRoot) {
  return path.join(brainRoot, "90_index", ".meta_feedback_log.jsonl");
}

/**
 * 피드백 이벤트를 로그에 기록한다.
 * @param {string} brainRoot
 * @param {Object} event - { strategyName, feedbackType, message, score }
 */
function logFeedback(brainRoot, event) {
  const logPath = _feedbackLogPath(brainRoot);
  const entry = {
    timestamp: isoNow(),
    strategyName: event.strategyName,
    feedbackType: event.feedbackType,  // "positive" | "negative"
    message: event.message || "",
    score: event.score || 0,
    tokens: normalizeTokens(event.message || "")
  };

  const logs = readJsonl(logPath);
  logs.push(entry);
  writeJsonl(logPath, logs);
}

/**
 * 전체 피드백 로그를 읽는다.
 * @param {string} brainRoot
 * @returns {Array}
 */
function readFeedbackLog(brainRoot) {
  return readJsonl(_feedbackLogPath(brainRoot));
}

/**
 * 피드백 로그를 분석하여 전략별 학습 제안을 반환한다.
 *
 * 분석 로직:
 * 1. negative 피드백이 있는 전략의 실패 쿼리 토큰을 수집
 * 2. 기존 trigger_pattern에 없는 토큰 중 2회 이상 등장한 것을 후보로 추출
 * 3. positive 피드백의 토큰은 제외 (이미 잘 동작하는 패턴)
 *
 * @param {string} brainRoot
 * @param {Array<{content: Object}>} strategies - 현재 전략 배열
 * @returns {Array<{strategyName: string, suggestedTriggers: string[], negativeCount: number, positiveCount: number}>}
 */
function analyzeFeedback(brainRoot, strategies) {
  const logs = readFeedbackLog(brainRoot);
  if (logs.length === 0) return [];

  // 전략별 피드백 집계
  const strategyStats = new Map();

  for (const entry of logs) {
    if (!strategyStats.has(entry.strategyName)) {
      strategyStats.set(entry.strategyName, {
        negativeTokens: new Map(),  // token → count
        positiveTokens: new Set(),
        negativeCount: 0,
        positiveCount: 0
      });
    }

    const stats = strategyStats.get(entry.strategyName);
    if (entry.feedbackType === "negative") {
      stats.negativeCount++;
      for (const token of entry.tokens) {
        stats.negativeTokens.set(token, (stats.negativeTokens.get(token) || 0) + 1);
      }
    } else {
      stats.positiveCount++;
      for (const token of entry.tokens) {
        stats.positiveTokens.add(token);
      }
    }
  }

  // 전략별 제안 생성
  const suggestions = [];

  for (const [strategyName, stats] of strategyStats) {
    if (stats.negativeCount === 0) continue;

    // 현재 전략의 트리거 패턴 가져오기
    const strategy = strategies.find(s => s.content.name === strategyName);
    const existingTriggers = strategy
      ? new Set(strategy.content.trigger_pattern.map(t => t.toLowerCase()))
      : new Set();

    // negative 토큰 중: 기존 trigger에 없고, positive에도 없고, 2회 이상 등장
    const candidateTriggers = [];
    for (const [token, count] of stats.negativeTokens) {
      if (count >= 2 && !existingTriggers.has(token) && !stats.positiveTokens.has(token)) {
        candidateTriggers.push(token);
      }
    }

    if (candidateTriggers.length > 0 || stats.negativeCount >= 3) {
      suggestions.push({
        strategyName,
        suggestedTriggers: candidateTriggers,
        negativeCount: stats.negativeCount,
        positiveCount: stats.positiveCount
      });
    }
  }

  return suggestions;
}

/**
 * 제안된 트리거를 전략 파일에 적용한다.
 * @param {string} brainRoot
 * @param {string} strategyName
 * @param {string[]} newTriggers
 * @returns {{ applied: boolean, addedCount: number }}
 */
function applyTriggerSuggestions(brainRoot, strategyName, newTriggers) {
  const contentPath = path.join(brainRoot, "30_topics", "meta_strategies", `${strategyName}.json`);

  let content;
  try {
    const raw = fs.readFileSync(contentPath, "utf8");
    content = JSON.parse(raw);
  } catch {
    return { applied: false, addedCount: 0 };
  }

  const existingSet = new Set(content.trigger_pattern.map(t => t.toLowerCase()));
  let added = 0;

  for (const trigger of newTriggers) {
    if (!existingSet.has(trigger.toLowerCase())) {
      content.trigger_pattern.push(trigger);
      existingSet.add(trigger.toLowerCase());
      added++;
    }
  }

  if (added > 0) {
    fs.writeFileSync(contentPath, JSON.stringify(content, null, 2), "utf8");
  }

  return { applied: added > 0, addedCount: added };
}

/**
 * 피드백 로그를 초기화한다 (학습 적용 후).
 * @param {string} brainRoot
 */
function clearFeedbackLog(brainRoot) {
  const logPath = _feedbackLogPath(brainRoot);
  if (fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, "", "utf-8");
  }
}

module.exports = {
  logFeedback,
  readFeedbackLog,
  analyzeFeedback,
  applyTriggerSuggestions,
  clearFeedbackLog
};
