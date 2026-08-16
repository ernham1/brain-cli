export type PersistenceTarget = "brain" | "obsidian";

export interface ToolExecutionEvent {
  toolName: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
}

export interface PersistenceEvidence {
  requestedTargets: PersistenceTarget[];
  missingTargets: PersistenceTarget[];
  brainRecordIds: string[];
  obsidianPaths: string[];
  completed: boolean;
}

export interface GroupToolPolicy {
  persistenceTargets: PersistenceTarget[];
  maxTurns: number;
  disableTools: boolean;
  readOnlyTools: boolean;
}

const PASSIVE_GROUP_READONLY_REQUEST_RE =
  /검색|찾아|알아봐|분석|조사|확인|검증|뉴스|최신|주가|실적|전망|일정|언제|어디|누구|왜|원인|링크|출처|근거|보고서|자료|시장|경쟁사|레퍼런스/i;

const PERSISTENCE_ACTION_RE =
  /(?:기억\s*해\s*(?:줘|둬|주세요|달라|라|줄\s*수\s*있[겠을까니어\s]*|줄래|주겠니)|(?:저장|기록|남겨|추가)\s*(?:해(?:\s*(?:줘|둬|주세요|달라|라|줄\s*수\s*있[겠을까니어\s]*|줄래|주겠니))?|하자|해주세요|해라)|작성\s*(?:해서|해)\s*(?:저장|추가|남겨))/i;

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function detectPersistenceTargets(text: string): PersistenceTarget[] {
  const normalized = normalizeText(text);
  if (!normalized || !PERSISTENCE_ACTION_RE.test(normalized)) return [];

  const brainNamed = /(?:Brain|브레인|장기\s*기억)/i.test(normalized);
  const obsidianNamed = /(?:Obsidian|옵시디언|AI학습|지식창고)/i.test(normalized);
  const implicitMemory = !obsidianNamed && /기억\s*해/i.test(normalized);

  const targets: PersistenceTarget[] = [];
  if (brainNamed || implicitMemory) targets.push("brain");
  if (obsidianNamed) targets.push("obsidian");
  return targets;
}

export function resolveGroupToolPolicy(
  text: string,
  context: { isGroup: boolean; isProjectRoom: boolean; isMentioned: boolean },
): GroupToolPolicy {
  const persistenceTargets = detectPersistenceTargets(text);
  const passiveGroupTurn = context.isGroup && !context.isProjectRoom && !context.isMentioned;

  if (!passiveGroupTurn) {
    return {
      persistenceTargets,
      maxTurns: context.isGroup && !context.isProjectRoom ? 20 : 80,
      disableTools: false,
      readOnlyTools: false,
    };
  }

  if (persistenceTargets.length > 0) {
    return {
      persistenceTargets,
      maxTurns: 20,
      disableTools: false,
      readOnlyTools: false,
    };
  }

  if (PASSIVE_GROUP_READONLY_REQUEST_RE.test(text)) {
    return {
      persistenceTargets,
      maxTurns: 20,
      disableTools: false,
      readOnlyTools: true,
    };
  }

  return {
    persistenceTargets,
    maxTurns: 3,
    disableTools: true,
    readOnlyTools: false,
  };
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isPathInside(filePath: string, rootPath: string | undefined): boolean {
  if (!rootPath) return false;
  const file = normalizePath(filePath);
  const root = normalizePath(rootPath);
  return file === root || file.startsWith(root + "/");
}

function isSuccessfulToolResult(event: ToolExecutionEvent): boolean {
  return !event.isError && !/(?:오류|실패|거부|denied|not allowed|permission)/i.test(event.result);
}

export function evaluatePersistenceEvidence(
  requestedTargets: PersistenceTarget[],
  events: ToolExecutionEvent[],
  obsidianRoot?: string,
): PersistenceEvidence {
  const brainRecordIds = new Set<string>();
  const obsidianPaths = new Set<string>();
  let brainSucceeded = false;

  for (const event of events) {
    if (!isSuccessfulToolResult(event)) continue;

    if (/(?:^|__)brain_write$/.test(event.toolName) && /저장 완료/.test(event.result)) {
      brainSucceeded = true;
      const recordId = event.result.match(/\brec_[a-zA-Z0-9_-]+\b/)?.[0];
      if (recordId) brainRecordIds.add(recordId);
      continue;
    }

    if (event.toolName === "Write" || event.toolName === "Edit") {
      const filePath = String(event.input.file_path || "");
      if (filePath && isPathInside(filePath, obsidianRoot)) {
        obsidianPaths.add(filePath.replace(/\\/g, "/"));
      }
    }
  }

  const missingTargets = requestedTargets.filter((target) => {
    if (target === "brain") return !brainSucceeded;
    return obsidianPaths.size === 0;
  });

  return {
    requestedTargets: [...requestedTargets],
    missingTargets,
    brainRecordIds: [...brainRecordIds],
    obsidianPaths: [...obsidianPaths],
    completed: missingTargets.length === 0,
  };
}

function targetLabel(target: PersistenceTarget): string {
  return target === "brain" ? "Brain" : "Obsidian";
}

export function buildPersistenceExecutionPrompt(
  requestedTargets: PersistenceTarget[],
  missingTargets: PersistenceTarget[] = requestedTargets,
  obsidianRoot?: string,
): string {
  const completedTargets = requestedTargets.filter((target) => !missingTargets.includes(target));
  return [
    "## 명시적 저장 실행 계약",
    "- 사용자가 실제 저장을 요청했습니다. 요청 대상: " + requestedTargets.map(targetLabel).join(", "),
    completedTargets.length > 0
      ? "- 이미 성공한 대상은 다시 저장하지 마세요: " + completedTargets.map(targetLabel).join(", ")
      : "",
    "- 이번 호출에서 아직 실행해야 할 대상: " + missingTargets.map(targetLabel).join(", "),
    missingTargets.includes("brain")
      ? "- Brain은 brain_write를 실제 호출하고 저장 완료 record ID를 확인하세요. intent는 action/sourceRef/content/record 구조를 사용하세요."
      : "",
    missingTargets.includes("obsidian")
      ? "- Obsidian은 Write 또는 Edit를 실제 호출해 " + (obsidianRoot || "설정된 Obsidian 루트") + " 아래에 문서를 저장하고 성공 결과를 확인하세요."
      : "",
    "- 성공 도구 결과가 확인되기 전에는 저장했다거나 완료됐다고 말하지 마세요.",
    "- 같은 대상에 저장 도구를 두 번 호출하지 마세요.",
  ].filter(Boolean).join("\n");
}

function buildEvidenceLines(evidence: PersistenceEvidence): string[] {
  const lines: string[] = [];
  if (evidence.requestedTargets.includes("brain") && evidence.brainRecordIds.length > 0) {
    lines.push("- Brain: " + evidence.brainRecordIds.join(", "));
  }
  if (evidence.requestedTargets.includes("obsidian") && evidence.obsidianPaths.length > 0) {
    lines.push("- Obsidian: " + evidence.obsidianPaths.join(", "));
  }
  return lines;
}

export function formatPersistenceCompletion(
  response: string,
  evidence: PersistenceEvidence,
): string {
  const evidenceLines = buildEvidenceLines(evidence);
  if (evidence.completed) {
    return [response.trim(), "", "저장 확인:", ...evidenceLines].join("\n").trim();
  }

  const failureLines = evidence.missingTargets.map((target) => "- " + targetLabel(target) + " 저장 실패");
  if (evidenceLines.length > 0) {
    return ["일부만 저장됐습니다.", "", "저장 확인:", ...evidenceLines, "", ...failureLines].join("\n");
  }

  return [
    "저장 요청을 완료하지 못했습니다. 실제 저장 성공 기록이 확인되지 않았습니다.",
    "",
    ...failureLines,
  ].join("\n");
}
