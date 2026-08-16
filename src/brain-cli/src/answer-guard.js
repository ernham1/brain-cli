"use strict";

const fs = require("fs");
const path = require("path");
const { ensureDir, isoNow, readJsonl, writeJsonl } = require("./utils");
const { loadMemoryBrief } = require("./context-assembler");
const { upsertGrowthSignal } = require("./growth-signal");
const { upsertSmartMemoryLearningProposal } = require("./smart-memory-learning");
const {
  activationSnapshotFromMemoryGraph,
  appendConsolidationLog
} = require("./memory-graph");

function guardsPath(brainRoot, scopeId) {
  return path.join(brainRoot, "44_usage", scopeId, "guards.jsonl");
}

function hasHtmlCapability(brief) {
  const capabilities = brief.sections?.activeState?.capabilities || [];
  return capabilities.some(c => `${c.title} ${c.summary}`.toLowerCase().includes("html"));
}

function containsNewHtmlSuggestion(text) {
  if (!/html/i.test(text)) return false;
  const hasNewFeatureVerb = /(추가|도입|포함|넣으면|붙이면|탑재|만들면|넣는)/i.test(text);
  const hasRecommendationTone = /(좋|필요|추천|도움|유용|제안)/i.test(text);
  return hasNewFeatureVerb && hasRecommendationTone;
}

function containsDirectCodingInstruction(text) {
  return /(직접|이사님이|사용자가)\S{0,12}(코딩|구현|수정|명령어 실행)|터미널에서\s*\S{0,20}실행하세요|npm\s+\S+\s+실행하세요/i.test(text);
}

function detectorRecommendedUse(brief) {
  const recommendedUse = brief.sections?.evidenceDigest?.detector?.recommendedUse || {};
  const smartPolicy = smartMemoryAnswerPolicy(brief);
  return {
    ...recommendedUse,
    avoidRepeatingAsNew: recommendedUse.avoidRepeatingAsNew || smartPolicy.avoidRepeatingExistingCapability || false,
    requireCitation: recommendedUse.requireCitation || smartPolicy.requiresCitation || false,
    requireReview: recommendedUse.requireReview || smartPolicy.requiresUserConfirmation || false,
    blockedByPolicy: recommendedUse.blockedByPolicy || smartPolicy.blockedByPolicy || false
  };
}

function smartMemoryAnswerPolicy(brief) {
  return brief.sections?.smartMemory?.answerPolicy || {};
}

function memoryGraphInhibitionSignals(brief) {
  return Array.isArray(brief.sections?.memoryGraph?.inhibitionSignals)
    ? brief.sections.memoryGraph.inhibitionSignals
    : [];
}

function graphAvoidsRepeatingAsNew(brief) {
  return memoryGraphInhibitionSignals(brief).some(signal =>
    signal.signal === "avoid_repeating_existing_capability"
  );
}

function detectorContext(brief) {
  const detector = brief.sections?.evidenceDigest?.detector || {};
  return {
    detectorStatus: detector.status || null,
    detectorReasons: Array.isArray(detector.reasons) ? detector.reasons : [],
    recommendedUse: detectorRecommendedUse(brief)
  };
}

function enrichFindingWithMemorySignals(finding, recommendedUse, graphSignals) {
  const guardReasons = [];
  if (recommendedUse.avoidRepeatingAsNew) guardReasons.push("avoid_repeating_as_new");
  if (recommendedUse.requireCitation) guardReasons.push("citation_required");
  if (recommendedUse.requireReview) guardReasons.push("review_required");
  if (graphSignals.some(signal => signal.signal === "avoid_repeating_existing_capability")) {
    guardReasons.push("memory_graph_inhibition");
    if (!guardReasons.includes("avoid_repeating_as_new")) guardReasons.push("avoid_repeating_as_new");
  }
  if (recommendedUse.blockedByPolicy) guardReasons.push("smart_memory_policy_block");
  if (recommendedUse.requireReview) guardReasons.push("smart_memory_review_required");
  if (guardReasons.length === 0) return finding;
  return { ...finding, guardReasons };
}

function guardDraft(brainRoot, options = {}) {
  const brief = typeof options.brief === "object"
    ? options.brief
    : loadMemoryBrief(brainRoot, options.briefId || options.brief);
  const draftText = options.draftText || fs.readFileSync(options.draftPath, "utf-8");
  const findings = [];
  const detectorSignal = detectorContext(brief);
  const recommendedUse = detectorRecommendedUse(brief);
  const graphSignals = memoryGraphInhibitionSignals(brief);
  const graphAvoidRepeating = graphAvoidsRepeatingAsNew(brief);
  const graphActivation = activationSnapshotFromMemoryGraph(brief.sections?.memoryGraph);

  if ((recommendedUse.avoidRepeatingAsNew || graphAvoidRepeating || hasHtmlCapability(brief)) && containsNewHtmlSuggestion(draftText)) {
    findings.push(enrichFindingWithMemorySignals({
      failureType: "known_capability_as_new_suggestion",
      reason: recommendedUse.avoidRepeatingAsNew
        ? "Memory Brief Detector가 이미 알려진 기능을 신규 제안처럼 반복하지 말라고 판정했습니다."
        : graphAvoidRepeating
          ? "Memory Graph가 이미 연결된 capability를 신규 제안처럼 반복하지 말라고 판정했습니다."
        : "Active State에 이미 있는 HTML 산출물 기능을 신규 제안처럼 표현했습니다.",
      evidenceRefs: brief.sections.activeState.sourceRefs || [],
      suggestedFix: "HTML 산출물은 기존 기능으로 전제하고, 분석 결과를 그 흐름에 연결하는 방식으로 수정하세요."
    }, recommendedUse, graphSignals));
  }

  if (containsDirectCodingInstruction(draftText)) {
    findings.push(enrichFindingWithMemorySignals({
      failureType: "direct_user_coding_instruction",
      reason: "이사님에게 직접 코딩 또는 명령 실행을 시키는 표현이 있습니다.",
      evidenceRefs: ["48_user_ontology/profiles/ernham.json"],
      suggestedFix: "구현 주체를 Codex 또는 에이전트로 바꿔 표현하세요."
    }, recommendedUse, graphSignals));
  }

  const status = findings.length > 0
    ? "revise_required"
    : recommendedUse.requireReview
      ? "review_recommended"
      : "pass";
  const result = {
    guardId: `guard_${Date.now().toString(36)}`,
    briefId: brief.briefId,
    scopeId: brief.scopeId,
    status,
    findings,
    checkedAt: isoNow()
  };

  ensureDir(path.dirname(guardsPath(brainRoot, brief.scopeId)));
  const records = readJsonl(guardsPath(brainRoot, brief.scopeId));
  records.push(result);
  writeJsonl(guardsPath(brainRoot, brief.scopeId), records);

  appendConsolidationLog(brainRoot, {
    scopeId: brief.scopeId,
    source: "answer_guard",
    eventType: "guard_result",
    resultId: result.guardId,
    status: result.status,
    activation: graphActivation,
    metadata: {
      findingTypes: findings.map(finding => finding.failureType)
    }
  });

  if (result.status !== "pass") {
    upsertSmartMemoryLearningProposal(brainRoot, {
      brief,
      guardResult: result,
      source: "answer_guard",
      resultId: result.guardId,
      activation: graphActivation,
      reason: "Answer Guard result produced Smart Memory learning proposal"
    });
  }

  for (const finding of findings) {
    upsertGrowthSignal(brainRoot, {
      scopeId: brief.scopeId,
      source: "answer_guard",
      failureType: finding.failureType,
      summary: finding.reason,
      evidenceRefs: finding.evidenceRefs,
      guardReasons: finding.guardReasons || [],
      detectorStatus: detectorSignal.detectorStatus,
      detectorReasons: detectorSignal.detectorReasons,
      recommendedUse: detectorSignal.recommendedUse,
      suggestedFix: finding.suggestedFix,
      activation: graphActivation,
      status: "candidate"
    });
  }

  return result;
}

module.exports = {
  guardDraft,
  guardsPath,
  containsNewHtmlSuggestion,
  containsDirectCodingInstruction
};
