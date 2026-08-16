"use strict";

const fs = require("fs");
const path = require("path");
const { search } = require("./search");

const DEFAULT_CASES_PATH = path.join("90_index", "search-evaluation-cases.json");

function loadSearchEvaluationCases(brainRoot, options = {}) {
  if (Array.isArray(options.cases)) return options.cases;
  const filePath = options.casesPath || path.join(brainRoot, DEFAULT_CASES_PATH);
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Array.isArray(parsed) ? parsed : parsed.cases || [];
}

function evaluateSearchQuality(brainRoot, options = {}) {
  const cases = loadSearchEvaluationCases(brainRoot, options);
  const defaultTopK = Number(options.topK || 5);
  const caseResults = cases.map(testCase => evaluateCase(brainRoot, testCase, defaultTopK));
  const total = caseResults.length;
  const hitAt1 = total === 0 ? 0 : caseResults.filter(r => r.hitAt1).length / total;
  const hitAt3 = total === 0 ? 0 : caseResults.filter(r => r.hitAt3).length / total;
  const mrr = total === 0 ? 0 : caseResults.reduce((sum, r) => sum + r.reciprocalRank, 0) / total;
  const forbiddenHits = caseResults.reduce((sum, r) => sum + r.forbiddenHits.length, 0);
  const passed = caseResults.every(r => r.passed);

  return {
    status: passed ? "passed" : "failed",
    total,
    metrics: {
      hitAt1: roundMetric(hitAt1),
      hitAt3: roundMetric(hitAt3),
      mrr: roundMetric(mrr),
      forbiddenHits
    },
    cases: caseResults
  };
}

function evaluateCase(brainRoot, testCase, defaultTopK) {
  const topK = Number(testCase.topK || defaultTopK || 5);
  const result = search(brainRoot, {
    scopeType: testCase.scopeType,
    scopeId: testCase.scopeId,
    type: testCase.type,
    currentGoal: testCase.query || testCase.goal,
    topK,
    queryType: testCase.queryType
  });
  const relevantCandidates = result.candidates.filter(candidate => (candidate.score || 0) > 0);
  const returnedIds = relevantCandidates.map(candidate => candidate.recordId);
  const expectedIds = testCase.expectedRecordIds || [];
  const forbiddenIds = testCase.forbiddenRecordIds || [];
  const firstExpectedRank = findFirstRank(returnedIds, expectedIds);
  const forbiddenHits = forbiddenIds.filter(id => returnedIds.includes(id));
  const mustHitAt = Number(testCase.mustHitAt || 3);
  const expectedSatisfied = expectedIds.length === 0 || (firstExpectedRank > 0 && firstExpectedRank <= mustHitAt);
  const forbiddenSatisfied = forbiddenHits.length === 0;
  const queryTypeSatisfied = !testCase.expectedQueryType || result.queryType === testCase.expectedQueryType;

  return {
    caseId: testCase.caseId || testCase.id || testCase.query,
    query: testCase.query || testCase.goal,
    expectedRecordIds: expectedIds,
    forbiddenRecordIds: forbiddenIds,
    returnedIds,
    queryType: result.queryType,
    expectedQueryType: testCase.expectedQueryType || null,
    hitAt1: firstExpectedRank === 1,
    hitAt3: firstExpectedRank > 0 && firstExpectedRank <= 3,
    firstExpectedRank,
    reciprocalRank: firstExpectedRank > 0 ? roundMetric(1 / firstExpectedRank) : 0,
    forbiddenHits,
    passed: expectedSatisfied && forbiddenSatisfied && queryTypeSatisfied
  };
}

function findFirstRank(returnedIds, expectedIds) {
  for (const expectedId of expectedIds) {
    const index = returnedIds.indexOf(expectedId);
    if (index >= 0) return index + 1;
  }
  return 0;
}

function roundMetric(value) {
  return Math.round(value * 10000) / 10000;
}

function formatSearchEvaluationReport(report) {
  const lines = [
    "=== Brain Search Quality Evaluation ===",
    `status: ${report.status}`,
    `total: ${report.total}`,
    `Hit@1: ${report.metrics.hitAt1}`,
    `Hit@3: ${report.metrics.hitAt3}`,
    `MRR: ${report.metrics.mrr}`,
    `Forbidden hits: ${report.metrics.forbiddenHits}`,
    "",
  ];

  for (const result of report.cases) {
    lines.push(`${result.passed ? "PASS" : "FAIL"} ${result.caseId}`);
    lines.push(`  query: ${result.query}`);
    lines.push(`  expected: ${result.expectedRecordIds.join(", ") || "-"}`);
    lines.push(`  returned: ${result.returnedIds.join(", ") || "-"}`);
    lines.push(`  rank: ${result.firstExpectedRank || "miss"}, queryType: ${result.queryType}`);
    if (result.forbiddenHits.length > 0) lines.push(`  forbiddenHits: ${result.forbiddenHits.join(", ")}`);
  }

  return lines.join("\n");
}

module.exports = {
  DEFAULT_CASES_PATH,
  loadSearchEvaluationCases,
  evaluateSearchQuality,
  formatSearchEvaluationReport,
};