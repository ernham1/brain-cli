"use strict";

const path = require("path");
const crypto = require("crypto");
const { ensureDir, isoNow, readJsonl, writeJsonl } = require("./utils");
const { memoryGraphDir } = require("./memory-graph");
const { createMemoryBrief } = require("./context-assembler");
const { guardDraft } = require("./answer-guard");

const CASE_SCHEMA_VERSION = "smart-memory-evaluation-case/v1";
const RESULT_SCHEMA_VERSION = "smart-memory-evaluation-result/v1";

function smartMemoryEvaluationCasesPath(brainRoot) {
  return path.join(memoryGraphDir(brainRoot), "smart-memory-evaluation-cases.jsonl");
}

function smartMemoryEvaluationResultsPath(brainRoot) {
  return path.join(memoryGraphDir(brainRoot), "smart-memory-evaluation-results.jsonl");
}

function defaultSmartMemoryEvaluationCases(scopeId = "agentforge") {
  return [
    {
      caseId: `${scopeId}_html_novelty_guard`,
      schemaVersion: CASE_SCHEMA_VERSION,
      scopeId,
      title: "HTML capability novelty guard",
      goal: "신규 오픈소스를 분석해줘",
      channelMode: "desktop_claude",
      expected: {
        answerPolicy: {
          avoidRepeatingExistingCapability: true
        },
        guard: {
          draftText: "이 오픈소스를 활용해 HTML 산출물 기능을 밴딩AI에 추가하면 좋겠습니다.",
          status: "revise_required",
          failureTypes: ["known_capability_as_new_suggestion"],
          guardReasons: ["avoid_repeating_as_new"]
        }
      }
    },
    {
      caseId: `${scopeId}_verification_depth`,
      schemaVersion: CASE_SCHEMA_VERSION,
      scopeId,
      title: "Verification intent depth budget",
      goal: "최신 원문 근거로 Brain 설계서 검증해줘",
      channelMode: "desktop_claude",
      expected: {
        intent: "verification",
        depth: {
          usedDepth: "D4"
        },
        answerPolicy: {
          requiresCitation: true
        }
      }
    }
  ];
}

function readSmartMemoryEvaluationCases(brainRoot) {
  return readJsonl(smartMemoryEvaluationCasesPath(brainRoot));
}

function readSmartMemoryEvaluationResults(brainRoot) {
  return readJsonl(smartMemoryEvaluationResultsPath(brainRoot));
}

function listSmartMemoryEvaluationCases(brainRoot, options = {}) {
  const scopeId = options.scope || options.scopeId;
  return readSmartMemoryEvaluationCases(brainRoot)
    .filter(testCase => !scopeId || testCase.scopeId === scopeId);
}

function seedDefaultSmartMemoryEvaluationCases(brainRoot, options = {}) {
  const scopeId = options.scope || options.scopeId || "agentforge";
  const filePath = smartMemoryEvaluationCasesPath(brainRoot);
  ensureDir(path.dirname(filePath));
  const cases = readJsonl(filePath);
  const byId = new Map(cases.map(testCase => [testCase.caseId, testCase]));
  let created = 0;
  let updated = 0;
  const now = isoNow();

  for (const testCase of defaultSmartMemoryEvaluationCases(scopeId)) {
    const previous = byId.get(testCase.caseId);
    const next = {
      ...previous,
      ...testCase,
      schemaVersion: CASE_SCHEMA_VERSION,
      createdAt: previous?.createdAt || now,
      updatedAt: now
    };
    if (previous) updated += 1;
    else created += 1;
    byId.set(testCase.caseId, next);
  }

  const nextCases = Array.from(byId.values()).sort((a, b) => String(a.caseId).localeCompare(String(b.caseId)));
  writeJsonl(filePath, nextCases);
  return {
    cases: nextCases.filter(testCase => testCase.scopeId === scopeId),
    created,
    updated
  };
}

function nestedValue(object, dottedPath) {
  return dottedPath.split(".").reduce((current, key) => current?.[key], object);
}

function addExactChecks(checks, prefix, actualObject, expectedObject = {}) {
  for (const [key, expected] of Object.entries(expectedObject || {})) {
    const pathKey = `${prefix}.${key}`;
    const actual = nestedValue(actualObject, key);
    checks.push({
      checkId: pathKey,
      passed: actual === expected,
      expected,
      actual
    });
  }
}

function addArrayContainsChecks(checks, prefix, actualValues = [], expectedValues = []) {
  for (const expected of expectedValues || []) {
    checks.push({
      checkId: `${prefix}.includes:${expected}`,
      passed: actualValues.includes(expected),
      expected,
      actual: actualValues
    });
  }
}

function evaluateBrief(testCase, brief) {
  const checks = [];
  const expected = testCase.expected || {};
  const smartMemory = brief.sections?.smartMemory || {};

  if (expected.intent) {
    checks.push({
      checkId: "intent",
      passed: smartMemory.intent === expected.intent,
      expected: expected.intent,
      actual: smartMemory.intent
    });
  }

  if (expected.depth) {
    addExactChecks(checks, "depth", smartMemory.depth || {}, expected.depth);
  }

  if (expected.answerPolicy) {
    addExactChecks(checks, "answerPolicy", smartMemory.answerPolicy || {}, expected.answerPolicy);
  }

  if (expected.policy) {
    addExactChecks(checks, "policy", smartMemory.policy || {}, expected.policy);
  }

  if (expected.decisions) {
    for (const expectedDecision of expected.decisions) {
      const matched = (smartMemory.decisions || []).some(decision =>
        (!expectedDecision.decision || decision.decision === expectedDecision.decision) &&
        (!expectedDecision.source || decision.source === expectedDecision.source) &&
        (!expectedDecision.ref || decision.ref === expectedDecision.ref)
      );
      checks.push({
        checkId: `decisions.match:${expectedDecision.decision || expectedDecision.ref || "any"}`,
        passed: matched,
        expected: expectedDecision,
        actual: smartMemory.decisions || []
      });
    }
  }

  return checks;
}

function evaluateGuard(brainRoot, testCase, brief) {
  const expectedGuard = testCase.expected?.guard;
  if (!expectedGuard) return [];
  const result = guardDraft(brainRoot, {
    brief,
    draftText: expectedGuard.draftText
  });
  const checks = [{
    checkId: "guard.status",
    passed: result.status === expectedGuard.status,
    expected: expectedGuard.status,
    actual: result.status
  }];
  const failureTypes = (result.findings || []).map(finding => finding.failureType);
  const guardReasons = Array.from(new Set((result.findings || []).flatMap(finding => finding.guardReasons || [])));
  addArrayContainsChecks(checks, "guard.failureTypes", failureTypes, expectedGuard.failureTypes || []);
  addArrayContainsChecks(checks, "guard.guardReasons", guardReasons, expectedGuard.guardReasons || []);
  return checks;
}

function resultIdFor(testCase, createdAt) {
  const digest = crypto
    .createHash("sha1")
    .update(`${testCase.caseId}:${createdAt}`)
    .digest("hex")
    .slice(0, 14);
  return `smer_${digest}`;
}

function runSmartMemoryEvaluationCase(brainRoot, testCase, options = {}) {
  const brief = createMemoryBrief(brainRoot, {
    project: testCase.scopeId,
    goal: testCase.goal,
    channelMode: testCase.channelMode,
    userId: options.userId || "ernham",
    includeObsidian: testCase.includeObsidian
  });
  const checks = [
    ...evaluateBrief(testCase, brief),
    ...evaluateGuard(brainRoot, testCase, brief)
  ];
  const createdAt = isoNow();
  const result = {
    resultId: resultIdFor(testCase, createdAt),
    schemaVersion: RESULT_SCHEMA_VERSION,
    caseId: testCase.caseId,
    scopeId: testCase.scopeId,
    title: testCase.title,
    status: checks.every(check => check.passed) ? "passed" : "failed",
    checks,
    briefId: brief.briefId,
    createdAt
  };
  return result;
}

function appendEvaluationResults(brainRoot, results) {
  const filePath = smartMemoryEvaluationResultsPath(brainRoot);
  ensureDir(path.dirname(filePath));
  const records = readJsonl(filePath);
  records.push(...results);
  writeJsonl(filePath, records);
  return results;
}

function runSmartMemoryEvaluationSuite(brainRoot, options = {}) {
  const scopeId = options.scope || options.scopeId;
  if (options.seedDefaults) seedDefaultSmartMemoryEvaluationCases(brainRoot, { scopeId: scopeId || "agentforge" });
  let cases = listSmartMemoryEvaluationCases(brainRoot, { scopeId });
  if (cases.length === 0 && options.seedDefaults !== false) {
    seedDefaultSmartMemoryEvaluationCases(brainRoot, { scopeId: scopeId || "agentforge" });
    cases = listSmartMemoryEvaluationCases(brainRoot, { scopeId });
  }
  const results = cases.map(testCase => runSmartMemoryEvaluationCase(brainRoot, testCase, options));
  appendEvaluationResults(brainRoot, results);
  const failed = results.filter(result => result.status !== "passed");
  return {
    schemaVersion: "smart-memory-evaluation-suite/v1",
    scopeId: scopeId || null,
    status: failed.length === 0 ? "passed" : "failed",
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
    createdAt: isoNow()
  };
}

module.exports = {
  CASE_SCHEMA_VERSION,
  RESULT_SCHEMA_VERSION,
  smartMemoryEvaluationCasesPath,
  smartMemoryEvaluationResultsPath,
  defaultSmartMemoryEvaluationCases,
  readSmartMemoryEvaluationCases,
  readSmartMemoryEvaluationResults,
  listSmartMemoryEvaluationCases,
  seedDefaultSmartMemoryEvaluationCases,
  runSmartMemoryEvaluationCase,
  runSmartMemoryEvaluationSuite
};
