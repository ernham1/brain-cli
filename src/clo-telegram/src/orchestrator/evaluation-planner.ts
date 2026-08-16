import type {
  ClaimLevel,
  EvaluationPlan,
  EvaluationProfile,
  GateKind,
  GateSpec,
  OwnerDirectives,
  RiskLevel,
  ScopeSpec,
  TaskType,
} from "./types.js";

export interface EvaluationPlannerInput {
  rawInstruction: string;
  targetCwd: string;
  projectHint?: string;
}

export interface EvaluationPlannerResult {
  ownerDirectives: OwnerDirectives;
  objective: string;
  scope: ScopeSpec;
  taskType: TaskType;
  riskLevel: RiskLevel;
  evaluationProfile: EvaluationProfile;
  claimLevel: ClaimLevel;
  evaluationPlan: EvaluationPlan;
}

export class EvaluationPlanner {
  plan(input: EvaluationPlannerInput): EvaluationPlannerResult {
    const instruction = normalizeText(input.rawInstruction);
    const taskType = inferTaskType(instruction);
    const riskLevel = inferRiskLevel(instruction, taskType);
    const ownerDirectives = extractOwnerDirectives(instruction);
    const evaluationProfile = inferEvaluationProfile(instruction, taskType);
    const claimLevel = inferClaimLevel(instruction, evaluationProfile);
    const gates = buildGateSpecs(taskType, evaluationProfile, ownerDirectives.successCriteria);
    const evaluationPlan = buildEvaluationPlan(ownerDirectives, evaluationProfile, gates);

    return {
      ownerDirectives,
      objective: ownerDirectives.successCriteria[0] ?? instruction,
      scope: {
        include: [input.projectHint ?? input.targetCwd],
        exclude: ownerDirectives.exclusions,
      },
      taskType,
      riskLevel,
      evaluationProfile,
      claimLevel,
      evaluationPlan,
    };
  }
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function inferTaskType(text: string): TaskType {
  if (/(오케스트레이터|에이전트|루프|워크플로|평가\s*레이어|검증\s*시스템)/i.test(text)) {
    return "orchestration";
  }
  if (/(UI|화면|버튼|모달|브라우저|Playwright|플레이wright|랜딩|프론트|디자인)/i.test(text)) {
    return "ui";
  }
  if (/(코드|구현|수정|버그|빌드|테스트|리팩터|API|TypeScript|파일|패치)/i.test(text)) {
    return "code";
  }
  if (/(리서치|조사|시장|경쟁사|자료|근거|논문|레퍼런스)/i.test(text)) {
    return "research";
  }
  if (/(문서|설계서|기획서|보고서|지시서|README|정리)/i.test(text)) {
    return "document";
  }
  return "general";
}

function inferRiskLevel(text: string, taskType: TaskType): RiskLevel {
  if (/(삭제|마이그레이션|운영|배포|시크릿|권한|결제|보안|전체\s*교체|데이터\s*손실|RED)/i.test(text)) {
    return "red";
  }
  if (taskType === "code" || taskType === "ui" || taskType === "orchestration") return "yellow";
  return "green";
}

function extractOwnerDirectives(text: string): OwnerDirectives {
  const successCriteria = extractSuccessCriteria(text);
  return {
    rawInstruction: text,
    hardConstraints: extractHardConstraints(text),
    successCriteria,
    exclusions: extractExclusions(text),
    priorityHints: extractPriorityHints(text),
  };
}

function extractSuccessCriteria(text: string): string[] {
  const criteria: string[] = [];
  if (/(빌드\s*(통과|성공)|build\s*(pass|success)?)/i.test(text)) criteria.push("빌드 통과");
  if (/(테스트\s*(통과|성공|까지)|test\s*(pass|success)?)/i.test(text)) criteria.push("관련 테스트 통과");
  if (/(검증까지|진짜\s*되는지|작동\s*증명|스모크)/.test(text)) criteria.push("검증 증거 확보");
  if (/(모바일|텔레그램).*(보고|요약)|7줄/.test(text)) criteria.push("모바일 보고 가능");
  if (/(result\s*file|결과\s*파일|완료\s*보고)/i.test(text)) criteria.push("결과 계약 준수");
  if (criteria.length === 0) criteria.push("사용자 요청 의도 충족");
  return unique(criteria);
}

function extractHardConstraints(text: string): string[] {
  const constraints: string[] = [];
  if (/(기존|호환).*(깨지|유지|보존)/.test(text)) constraints.push("기존 동작 호환 유지");
  if (/(직접\s*지시|lockedCriteria|잠금)/i.test(text)) constraints.push("직접 지시 기준 약화 금지");
  if (/(완료라고\s*하지\s*마|확인.*완료)/.test(text)) constraints.push("검증 전 완료 보고 금지");
  return unique(constraints);
}

function extractExclusions(text: string): string[] {
  const exclusions: string[] = [];
  if (/(A2A).*(불필요|제외|도입하지|하지\s*마)/i.test(text)) exclusions.push("A2A 프로토콜 도입 제외");
  if (/(LangGraph|CrewAI|AutoGen).*(제외|도입하지|하지\s*마)/i.test(text)) {
    exclusions.push("신규 에이전트 프레임워크 도입 제외");
  }
  return unique(exclusions);
}

function extractPriorityHints(text: string): OwnerDirectives["priorityHints"] {
  const hints: OwnerDirectives["priorityHints"] = [];
  if (/(빠르게|간단히|최소|우선)/.test(text)) hints.push("fast");
  if (/(초안|방향만|draft)/i.test(text)) hints.push("draft");
  if (/(검증까지|진짜\s*되는지|테스트까지|빌드\s*통과|작동\s*증명)/.test(text)) hints.push("verify");
  if (/(엄격|꼼꼼|strict|레드팀)/i.test(text)) hints.push("strict");
  return unique(hints);
}

function inferEvaluationProfile(text: string, taskType: TaskType): EvaluationProfile {
  let profile = defaultProfileForTaskType(taskType);
  const draftOnly = /(초안만|방향만|draft only)/i.test(text);
  const fast = /(빠르게|간단히|최소|우선)/.test(text);
  const verify = /(검증까지|완료까지|테스트까지|빌드\s*통과|작동\s*증명)/.test(text);
  const strict = /(진짜\s*되는지|엄격|꼼꼼|strict|레드팀)/i.test(text);

  if (draftOnly) profile = "light";
  else if (fast) profile = lowerProfile(profile);

  if (verify) profile = maxProfile(profile, "standard");
  if (strict) profile = "strict";
  return profile;
}

function defaultProfileForTaskType(taskType: TaskType): EvaluationProfile {
  switch (taskType) {
    case "general": return "light";
    case "document":
    case "research": return "standard";
    case "code":
    case "ui":
    case "orchestration": return "strict";
  }
}

function lowerProfile(profile: EvaluationProfile): EvaluationProfile {
  if (profile === "strict") return "standard";
  if (profile === "standard") return "light";
  return "light";
}

function maxProfile(left: EvaluationProfile, right: EvaluationProfile): EvaluationProfile {
  const order: EvaluationProfile[] = ["light", "standard", "strict"];
  return order.indexOf(left) >= order.indexOf(right) ? left : right;
}

function inferClaimLevel(text: string, profile: EvaluationProfile): ClaimLevel {
  if (profile !== "light") return "pass_eligible";
  if (/(초안|방향만|draft)/i.test(text)) return "draft";
  return "review_needed";
}

function buildGateSpecs(
  taskType: TaskType,
  profile: EvaluationProfile,
  successCriteria: string[],
): GateSpec[] {
  const gates = new Map<GateKind, GateSpec>();
  const skipped = new Set<GateKind>();

  setGate(gates, "risk", true);
  setGate(gates, "contract", true);
  setGate(gates, "evidence", true);

  const requireBuild = successCriteria.some((criterion) => /빌드|build/i.test(criterion));
  const requireTest = successCriteria.some((criterion) => /테스트|test/i.test(criterion));

  if (taskType === "code") {
    if (profile === "light") {
      markSkipped(skipped, "lint");
      if (requireBuild) setGate(gates, "build", true);
      else markSkipped(skipped, "build");
      if (requireTest) setGate(gates, "test", true);
      else markSkipped(skipped, "test");
    } else {
      setGate(gates, "build", true);
      setGate(gates, "test", true);
      setGate(gates, "lint", profile === "strict");
    }
  }

  if (taskType === "ui") {
    setGate(gates, "build", profile !== "light" || requireBuild);
    setGate(gates, "test", profile !== "light" || requireTest);
    setGate(gates, "uatkit", profile === "strict");
    setGate(gates, "playwright", profile === "strict");
  }

  if (taskType === "orchestration") {
    setGate(gates, "test", profile !== "light" || requireTest);
    setGate(gates, "gunsa", profile === "strict");
  }

  if (profile !== "light") {
    setGate(gates, "rubric", true);
  } else {
    markSkipped(skipped, "rubric");
  }

  const gateList = Array.from(gates.values());
  for (const kind of skipped) {
    if (!gates.has(kind)) {
      gateList.push({ kind, required: false, params: { skipped: true, reason: "light profile" } });
    }
  }
  return gateList;
}

function buildEvaluationPlan(
  ownerDirectives: OwnerDirectives,
  profile: EvaluationProfile,
  gates: GateSpec[],
): EvaluationPlan {
  const advisoryOnly = gates
    .filter((gate) => !gate.required)
    .map((gate) => gate.kind);
  return {
    acceptanceCriteria: ownerDirectives.successCriteria.map((criterion, index) => ({
      id: `ac_${index + 1}`,
      text: criterion,
      locked: true,
    })),
    requiredEvidence: gates
      .filter((gate) => gate.required)
      .map((gate) => ({
        kind: gate.kind === "build" || gate.kind === "test" || gate.kind === "lint" ? "command" : "manual_note",
        description: `${gate.kind} gate result`,
        required: true,
      })),
    lockedCriteria: [...ownerDirectives.successCriteria],
    gates,
    flexibility: {
      userRequestedProfile: profile,
      skippedGates: gates
        .filter((gate) => gate.params.skipped === true)
        .map((gate) => ({ kind: gate.kind, reason: String(gate.params.reason ?? "profile adjustment") })),
      advisoryOnly,
    },
    qualityFloor: {
      explicitDirectivesLocked: true,
      passRequiresProfile: "standard",
      neverSkip: ["risk", "contract", "evidence"],
    },
    reworkPolicy: {
      maxAttempts: profile === "light" ? 0 : 1,
      askAfterFailure: true,
    },
    reportFormat: "mobile_summary",
  };
}

function setGate(gates: Map<GateKind, GateSpec>, kind: GateKind, required: boolean): void {
  const existing = gates.get(kind);
  if (existing) {
    existing.required = existing.required || required;
    return;
  }
  gates.set(kind, { kind, required, params: {} });
}

function markSkipped(skipped: Set<GateKind>, kind: GateKind): void {
  if (kind === "risk" || kind === "contract" || kind === "evidence") return;
  skipped.add(kind);
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
