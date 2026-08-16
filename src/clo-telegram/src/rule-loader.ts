import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type RuleId =
  | "brain-memory"
  | "verification"
  | "process-management"
  | "tool-safety"
  | "pre-action-checks"
  | "obsidian"
  | "analysis-checklist"
  | "red-team-review"
  | "bandingai-adapter"
  | "rule-governance"
  | "handoff-continuity"
  | "completion-reporting"
  | "large-impl-protocol"
  | "product-thinking"
  | "testing"
  | "security"
  | "coding-style"
  | "writing-style"
  | "decision-journal";

export type RuleMessageType =
  | "rules"
  | "continuation"
  | "completion"
  | "development"
  | "document"
  | "research"
  | "bandingai"
  | "simple";

export interface RuleLoadOptions {
  rulesDir?: string;
  maxRules?: number;
  maxCharsPerRule?: number;
}

export interface RuleLoadResult {
  messageType: RuleMessageType;
  selectedRuleIds: RuleId[];
  includedRuleIds: RuleId[];
  missingRuleIds: RuleId[];
  section: string;
}

const RULE_FILE_NAMES: Record<RuleId, string> = {
  "brain-memory": "brain-memory.md",
  verification: "verification.md",
  "process-management": "process-management.md",
  "tool-safety": "tool-safety.md",
  "pre-action-checks": "pre-action-checks.md",
  obsidian: "obsidian.md",
  "analysis-checklist": "analysis-checklist.md",
  "red-team-review": "red-team-review.md",
  "bandingai-adapter": "bandingai-adapter.md",
  "rule-governance": "rule-governance.md",
  "handoff-continuity": "handoff-continuity.md",
  "completion-reporting": "completion-reporting.md",
  "large-impl-protocol": "large-impl-protocol.md",
  "product-thinking": "product-thinking.md",
  testing: "testing.md",
  security: "security.md",
  "coding-style": "coding-style.md",
  "writing-style": "writing-style.md",
  // 결정 저널 규칙: 수동 세션용. 텔레클로는 orchestrator가 자동 저널링하므로
  // RULES_BY_TYPE에는 넣지 않는다 (프롬프트 비대화 방지).
  "decision-journal": "decision-journal.md",
};

const RULES_BY_TYPE: Record<RuleMessageType, RuleId[]> = {
  rules: ["rule-governance", "pre-action-checks", "verification", "brain-memory", "completion-reporting"],
  continuation: ["handoff-continuity", "brain-memory", "verification", "process-management", "completion-reporting"],
  completion: ["completion-reporting", "verification", "brain-memory"],
  development: [
    "brain-memory",
    "verification",
    "process-management",
    "tool-safety",
    "pre-action-checks",
  ],
  document: ["verification", "obsidian", "red-team-review", "brain-memory"],
  research: ["obsidian", "analysis-checklist", "verification", "brain-memory"],
  bandingai: ["bandingai-adapter", "brain-memory", "verification"],
  simple: [],
};

const RULE_ANCHORS_BY_TYPE: Record<RuleMessageType, RuleId[]> = {
  rules: ["rule-governance", "pre-action-checks"],
  continuation: ["handoff-continuity", "brain-memory", "verification"],
  completion: ["completion-reporting", "verification", "brain-memory"],
  development: ["brain-memory", "pre-action-checks", "verification"],
  document: ["verification", "brain-memory"],
  research: ["obsidian", "analysis-checklist", "brain-memory"],
  bandingai: ["bandingai-adapter", "brain-memory", "verification"],
  simple: [],
};

function matchesAny(message: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

export function classifyRuleMessage(message: string): RuleMessageType {
  const text = message.toLowerCase();

  if (
    matchesAny(text, [
      /claude\.md/i,
      /agents\.md/i,
      /prompt\.ts/i,
      /rule-loader/i,
      /rules?/i,
      /규칙/,
      /룰\s*파일/,
      /클로드\s*md/,
      /클로드\.md/,
      /프롬프트/,
      /하네스/,
      /harness/i,
      /prompt\s*framework/i,
      /프롬프트\s*프레임워크/,
    ])
  ) {
    return "rules";
  }

  if (matchesAny(text, [/bandingai/i, /agentforge/i, /밴딩\s*ai/i, /밴딩ai/i, /에이전트포지/i, /에이전트\s*(추가|생성|만들|새로|필요|강화|개선|분리)/, /에이전트.*좋을까/, /에이전트.*할까/])) {
    return "bandingai";
  }

  if (
    matchesAny(text, [
      /구현/,
      /개발/,
      /버그/,
      /수정/,
      /고쳐/,
      /안\s*돼/,
      /실패/,
      /테스트/,
      /빌드/,
      /코드/,
      /파일/,
      /리팩터/,
      /pm2/i,
      /npm/i,
    ])
  ) {
    return "development";
  }

  if (
    matchesAny(text, [
      /설계서/,
      /지시서/,
      /기획서/,
      /문서/,
      /검토/,
      /리뷰/,
      /스펙/,
      /검증/,
      /review/i,
    ])
  ) {
    return "document";
  }

  if (
    matchesAny(text, [
      /리서치/,
      /조사/,
      /검색/,
      /ai학습/i,
      /obsidian/i,
      /학습/,
      /논문/,
      /오픈소스/,
      /서비스 분석/,
    ])
  ) {
    return "research";
  }

  if (
    matchesAny(text, [
      /전체\s*완료/,
      /완료\s*됨/,
      /완료됐/,
      /완료\s*보고/,
      /남은\s*(건|거|것)/,
      /얼마나\s*남/,
      /검증\s*결과/,
      /운영\s*반영/,
    ])
  ) {
    return "completion";
  }

  if (
    matchesAny(text, [
      /다음\s*진행/,
      /다음진행/,
      /이어서/,
      /마저/,
      /계속/,
      /하던\s*거/,
      /진행$/,
      /페이즈\s*\d+/,
      /phase\s*\d+/i,
    ])
  ) {
    return "continuation";
  }

  return "simple";
}

function dedupeRules(ruleIds: RuleId[], maxRules: number): RuleId[] {
  return Array.from(new Set(ruleIds)).slice(0, maxRules);
}

function dynamicRulesForMessage(message: string, messageType: RuleMessageType): RuleId[] {
  const dynamicRuleIds: RuleId[] = [];

  if (
    messageType === "development" &&
    matchesAny(message, [/전체\s*개선/, /대규모/, /3개\s*파일/, /설계서\s*기반/, /구현/, /리팩터/])
  ) {
    dynamicRuleIds.push("large-impl-protocol");
  }

  if (matchesAny(message, [/테스트/, /검증/, /재현/, /회귀/, /진짜\s*되/])) {
    dynamicRuleIds.push("testing");
  }

  if (matchesAny(message, [/보안/, /시크릿/, /토큰/, /credential/i, /auth/i, /권한/])) {
    dynamicRuleIds.push("security");
  }

  if (matchesAny(message, [/제품/, /사용자/, /핵심\s*가치/, /기획/, /ux/i])) {
    dynamicRuleIds.push("product-thinking");
  }

  if (
    messageType === "document" ||
    matchesAny(message, [/문서/, /보고서/, /설계서/, /기획서/, /글쓰기/, /작성/])
  ) {
    dynamicRuleIds.push("writing-style");
  }

  if (matchesAny(message, [/코딩\s*스타일/, /리팩터/, /함수명/, /변수명/])) {
    dynamicRuleIds.push("coding-style");
  }

  if (
    matchesAny(message, [
      /레드팀/,
      /\/군사/,
      /사전\s*부검/,
      /premortem/i,
      /트레이드오프/,
      /의사결정/,
      /결정/,
      /판단/,
      /위험/,
    ])
  ) {
    dynamicRuleIds.push("red-team-review");
  }

  if (matchesAny(message, [/pm2/i, /재시작/, /프로세스/, /포트\s*\d+/, /port\s*\d+/i, /kill/i])) {
    dynamicRuleIds.push("process-management");
  }

  return dynamicRuleIds;
}

function selectRuleIds(message: string, messageType: RuleMessageType, maxRules: number): RuleId[] {
  const anchors = RULE_ANCHORS_BY_TYPE[messageType];
  const dynamicRuleIds = dynamicRulesForMessage(message, messageType);
  const baseRuleIds = RULES_BY_TYPE[messageType];
  return dedupeRules([...anchors, ...dynamicRuleIds, ...baseRuleIds], maxRules);
}

function buildHarnessGateSection(messageType: RuleMessageType, selectedRuleIds: RuleId[]): string {
  if (messageType === "simple" || selectedRuleIds.length === 0) return "";

  const lines = [
    "## 하네스 적용 게이트",
    "- prompt.ts는 얇은 공통 헌법입니다. 긴 지식과 상황별 절차는 아래 rules를 우선 적용하세요.",
    "- 전체 사고 과정을 길게 노출하지 말고, 근거, 가정, 불확실성, 검증 결과만 보고하세요.",
  ];

  if (selectedRuleIds.includes("large-impl-protocol")) {
    lines.push("- 큰 구현은 착수 전 범위와 갭을 짧게 밝히고, 파일 읽기 → 수정 → 검증 순서로 진행하세요.");
  }
  if (selectedRuleIds.includes("red-team-review")) {
    lines.push("- 중요한 판단은 실패 원인과 트레이드오프를 먼저 압박 검토한 뒤 실행안을 제시하세요.");
  }
  if (selectedRuleIds.includes("completion-reporting")) {
    lines.push("- 긴 작업이나 완료 보고는 해결됨, 결정됨, 보류, 미검증, 다음 초점을 분리하세요.");
  }

  return lines.join("\n");
}

function defaultRulesDir(): string {
  return path.join(os.homedir(), ".claude", "rules");
}

function readRuleFile(rulesDir: string, ruleId: RuleId, maxCharsPerRule: number): string | null {
  const filePath = path.join(rulesDir, RULE_FILE_NAMES[ruleId]);
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (content.length <= maxCharsPerRule) return content;
    return `${content.slice(0, maxCharsPerRule).trim()}\n\n... (truncated)`;
  } catch {
    return null;
  }
}

export function loadRulesForMessage(message: string, options: RuleLoadOptions = {}): RuleLoadResult {
  const messageType = classifyRuleMessage(message);
  const rulesDir = options.rulesDir ?? defaultRulesDir();
  const maxRules = options.maxRules ?? 5;
  const maxCharsPerRule = options.maxCharsPerRule ?? 4000;
  const selectedRuleIds = selectRuleIds(message, messageType, maxRules);
  const includedRuleIds: RuleId[] = [];
  const missingRuleIds: RuleId[] = [];
  const chunks: string[] = [];

  for (const ruleId of selectedRuleIds) {
    const content = readRuleFile(rulesDir, ruleId, maxCharsPerRule);
    if (!content) {
      missingRuleIds.push(ruleId);
      continue;
    }
    includedRuleIds.push(ruleId);
    chunks.push(`### ${RULE_FILE_NAMES[ruleId]}\n\n${content}`);
  }

  if (chunks.length === 0) {
    return {
      messageType,
      selectedRuleIds,
      includedRuleIds,
      missingRuleIds,
      section: "",
    };
  }

  const warningLine =
    missingRuleIds.length > 0
      ? `\n- missingRules: ${missingRuleIds.map((ruleId) => RULE_FILE_NAMES[ruleId]).join(", ")}`
      : "";

  return {
    messageType,
    selectedRuleIds,
    includedRuleIds,
    missingRuleIds,
    section: [
      buildHarnessGateSection(messageType, selectedRuleIds),
      "## 적용된 공통 rules",
      `- messageType: ${messageType}`,
      `- includedRules: ${includedRuleIds.map((ruleId) => RULE_FILE_NAMES[ruleId]).join(", ")}`,
      warningLine,
      "",
      ...chunks,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
