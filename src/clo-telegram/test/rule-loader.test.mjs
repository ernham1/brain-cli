import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { classifyRuleMessage, loadRulesForMessage } from "../dist/rule-loader.js";

const ruleContents = {
  "brain-memory.md": "# Brain",
  "verification.md": "# Verification",
  "process-management.md": "# Process",
  "tool-safety.md": "# Tool",
  "pre-action-checks.md": "# PreAction",
  "obsidian.md": "# Obsidian",
  "analysis-checklist.md": "# AnalysisChecklist",
  "red-team-review.md": "# RedTeam",
  "bandingai-adapter.md": "# BandingAI",
  "rule-governance.md": "# RuleGovernance",
  "handoff-continuity.md": "# HandoffContinuity",
  "completion-reporting.md": "# CompletionReporting",
  "large-impl-protocol.md": "# LargeImpl",
  "product-thinking.md": "# ProductThinking",
  "testing.md": "# Testing",
  "security.md": "# Security",
  "coding-style.md": "# CodingStyle",
  "writing-style.md": "# WritingStyle",
};

function makeRulesDir(files = ruleContents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clo-rule-loader-"));
  for (const [fileName, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, fileName), content, "utf-8");
  }
  return dir;
}

test("classifyRuleMessage detects core categories", () => {
  assert.equal(classifyRuleMessage("버그 수정하고 테스트 돌려줘"), "development");
  assert.equal(classifyRuleMessage("설계서 검토해줘"), "document");
  assert.equal(classifyRuleMessage("논문 리서치해서 AI학습에 저장"), "research");
  assert.equal(classifyRuleMessage("AgentForge 어댑터 확인"), "bandingai");
  assert.equal(classifyRuleMessage("클로드.md 룰 파일 정리"), "rules");
  assert.equal(classifyRuleMessage("하네스 개선하고 Anthropic 프롬프트 프레임워크 반영"), "rules");
  assert.equal(classifyRuleMessage("다음 진행"), "continuation");
  assert.equal(classifyRuleMessage("전체 완료됨?"), "completion");
  assert.equal(classifyRuleMessage("오늘 점심 뭐 먹지"), "simple");
});

test("rules messages load rule governance bundle", () => {
  const rulesDir = makeRulesDir();
  const result = loadRulesForMessage("CLAUDE.md rules 정리하고 prompt.ts 확인", { rulesDir });

  assert.deepEqual(result.includedRuleIds, [
    "rule-governance",
    "pre-action-checks",
    "verification",
    "brain-memory",
    "completion-reporting",
  ]);
  assert.equal(result.includedRuleIds.length, 5);
  assert.match(result.section, /하네스 적용 게이트/);
  assert.match(result.section, /rule-governance\.md/);
  assert.match(result.section, /completion-reporting\.md/);
});

test("continuation messages load handoff continuity bundle", () => {
  const rulesDir = makeRulesDir();
  const result = loadRulesForMessage("다음 진행", { rulesDir });

  assert.deepEqual(result.includedRuleIds, [
    "handoff-continuity",
    "brain-memory",
    "verification",
    "process-management",
    "completion-reporting",
  ]);
  assert.equal(result.includedRuleIds.length, 5);
  assert.match(result.section, /handoff-continuity\.md/);
});

test("completion messages load completion reporting bundle", () => {
  const rulesDir = makeRulesDir();
  const result = loadRulesForMessage("전체 완료됨? 남은 건?", { rulesDir });

  assert.deepEqual(result.includedRuleIds, ["completion-reporting", "verification", "brain-memory"]);
  assert.match(result.section, /completion-reporting\.md/);
});

test("development messages load five development rules", () => {
  const rulesDir = makeRulesDir();
  const result = loadRulesForMessage("코드 구현하고 pm2 재시작", { rulesDir });

  assert.deepEqual(result.includedRuleIds, [
    "brain-memory",
    "pre-action-checks",
    "verification",
    "large-impl-protocol",
    "process-management",
  ]);
  assert.equal(result.missingRuleIds.length, 0);
  assert.match(result.section, /brain-memory\.md/);
  assert.match(result.section, /large-impl-protocol\.md/);
});

test("risky document decisions add red-team and writing rules conditionally", () => {
  const rulesDir = makeRulesDir();
  const result = loadRulesForMessage("설계서 트레이드오프 판단 리포트 작성", { rulesDir });

  assert.deepEqual(result.includedRuleIds, [
    "verification",
    "brain-memory",
    "writing-style",
    "red-team-review",
    "obsidian",
  ]);
  assert.match(result.section, /실패 원인과 트레이드오프/);
  assert.match(result.section, /red-team-review\.md/);
});

test("bandingai messages prioritize adapter without exceeding max rules", () => {
  const rulesDir = makeRulesDir();
  const result = loadRulesForMessage("BandingAI AgentForge 연결 검토", { rulesDir, maxRules: 5 });

  assert.deepEqual(result.includedRuleIds, ["bandingai-adapter", "brain-memory", "verification"]);
  assert.equal(result.includedRuleIds.length <= 5, true);
  assert.match(result.section, /bandingai-adapter\.md/);
});

test("research messages load analysis checklist bundle", () => {
  const rulesDir = makeRulesDir();
  const result = loadRulesForMessage("논문 리서치해서 AI학습에 저장", { rulesDir });

  assert.deepEqual(result.includedRuleIds, [
    "obsidian",
    "analysis-checklist",
    "brain-memory",
    "verification",
  ]);
  assert.match(result.section, /analysis-checklist\.md/);
});

test("simple messages load no rules", () => {
  const rulesDir = makeRulesDir();
  const result = loadRulesForMessage("고마워", { rulesDir });

  assert.deepEqual(result.includedRuleIds, []);
  assert.equal(result.section, "");
});

test("missing rule files are warnings, not failures", () => {
  const rulesDir = makeRulesDir({
    "brain-memory.md": "# Brain",
    "verification.md": "# Verification",
  });
  const result = loadRulesForMessage("구현하고 테스트", { rulesDir });

  assert.deepEqual(result.includedRuleIds, ["brain-memory", "verification"]);
  assert.deepEqual(result.missingRuleIds, ["pre-action-checks", "large-impl-protocol", "testing"]);
  assert.match(result.section, /missingRules:/);
});
