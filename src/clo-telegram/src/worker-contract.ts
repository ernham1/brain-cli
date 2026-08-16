import fs from "node:fs";
import path from "node:path";

export interface ParsedWorkerSignal {
  userFacingText: string;
  why: string;
  what: string;
  taskInstr: string;
  context: string;
}

export interface WorkerResultContract {
  status: "completed" | "failed";
  summary: string;
  reason: string;
  evidence: string[];
}

export interface WorkerCompletionEvaluation {
  accepted: boolean;
  reason: string;
  cleanResult: string;
  contract?: WorkerResultContract;
  requiredArtifactPaths: string[];
  missingArtifactPaths: string[];
}

const SPAWN_WORKER_RE = /\[SPAWN_WORKER\]([\s\S]*?)\[\/SPAWN_WORKER\]/;
const SPAWN_WORKER_GLOBAL_RE = /\[SPAWN_WORKER\][\s\S]*?\[\/SPAWN_WORKER\]/g;
const WORKER_RESULT_RE = /\[WORKER_RESULT\]([\s\S]*?)\[\/WORKER_RESULT\]/;
const WORKER_RESULT_GLOBAL_RE = /\[WORKER_RESULT\][\s\S]*?\[\/WORKER_RESULT\]/g;
const OUTPUT_REQUIREMENT_RE = /반드시|완료\s*조건|저장|작성|생성|출력/;
const REFERENCE_PATH_LINE_RE = /^\s*(?:참고\s*)?(?:bin|cwd)\s*:/i;
const ENCLOSED_ABSOLUTE_PATH_RE = /[`"']([A-Za-z]:[\\/][^`"']+)[`"']/g;
const UNQUOTED_ABSOLUTE_PATH_RE = /[A-Za-z]:[\\/][^\s`"'<>|]+/g;
const REQUIRED_FILE_PATH_RE = /^(.+\.(?:md|txt|json|jsonl|csv|tsv|html?|pdf|docx?|hwpx|xlsx?|pptx?|png|jpe?g|webp|zip|log|ya?ml))/i;
const STRONG_INCOMPLETE_RE =
  /산출물\s*(?:은\s*)?0개|result\.md\s*(?:는\s*)?(?:없음|미생성)|상태[^\n]{0,40}미완료|실제로는[^\n]{0,80}(?:생성되지|완료되지)|작업[^\n]{0,40}(?:못했습니다|실패했습니다)/i;

export function parseWorkerSignal(response: string): ParsedWorkerSignal | null {
  const spawnMatch = response.match(SPAWN_WORKER_RE);
  if (!spawnMatch) return null;

  const fields = parseNamedFields(spawnMatch[1], ["why", "what", "task", "context"]);
  return {
    userFacingText: stripWorkerControlBlocks(response),
    why: fields.why ?? "",
    what: fields.what ?? "",
    taskInstr: fields.task ?? "",
    context: fields.context ?? "",
  };
}

export function stripWorkerControlBlocks(text: string): string {
  return text.replace(SPAWN_WORKER_GLOBAL_RE, "").trim();
}

export function extractRequiredArtifactPaths(taskInstr: string): string[] {
  const requiredPaths: string[] = [];
  const seen = new Set<string>();

  for (const line of taskInstr.split(/\r?\n/)) {
    if (!OUTPUT_REQUIREMENT_RE.test(line) || REFERENCE_PATH_LINE_RE.test(line)) continue;

    for (const match of line.matchAll(ENCLOSED_ABSOLUTE_PATH_RE)) addPath(match[1]);
    for (const match of line.matchAll(UNQUOTED_ABSOLUTE_PATH_RE)) addPath(match[0]);
  }

  return requiredPaths;

  function addPath(candidate: string): void {
    const filePath = candidate.trim().match(REQUIRED_FILE_PATH_RE)?.[1];
    if (!filePath) return;
    const normalized = path.normalize(filePath);
    const key = normalized.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      requiredPaths.push(normalized);
    }
  }
}

export function parseWorkerResultContract(result: string): WorkerResultContract | null {
  const match = result.match(WORKER_RESULT_RE);
  if (!match) return null;

  const block = match[1];
  const status = block.match(/^status:\s*(completed|failed)\s*$/im)?.[1]?.toLowerCase();
  if (status !== "completed" && status !== "failed") return null;

  const summary = block.match(/^summary:\s*(.+)$/im)?.[1]?.trim() ?? "";
  const reason = block.match(/^reason:\s*(.+)$/im)?.[1]?.trim() ?? "";
  const evidenceBody = block.match(/^evidence:\s*([\s\S]*)$/im)?.[1] ?? "";
  const evidence = evidenceBody
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);

  return { status, summary, reason, evidence };
}

export function evaluateWorkerCompletion(
  taskInstr: string,
  result: string,
): WorkerCompletionEvaluation {
  const cleanResult = result.replace(WORKER_RESULT_GLOBAL_RE, "").trim();
  const requiredArtifactPaths = extractRequiredArtifactPaths(taskInstr);
  const missingArtifactPaths = requiredArtifactPaths.filter((artifactPath) => !isUsableArtifact(artifactPath));
  const contract = parseWorkerResultContract(result);

  if (!contract) {
    return rejected("워커 완료 계약이 없거나 형식이 잘못됐습니다.");
  }
  if (contract.status !== "completed") {
    return rejected(contract.reason || contract.summary || "워커가 작업 실패를 보고했습니다.");
  }
  if (contract.evidence.length === 0) {
    return rejected("워커 완료 증거가 비어 있습니다.");
  }
  if (missingArtifactPaths.length > 0) {
    return rejected("필수 산출물이 없거나 비어 있습니다: " + missingArtifactPaths.join(", "));
  }
  if (STRONG_INCOMPLETE_RE.test(cleanResult)) {
    return rejected("워커 결과 본문이 미완료 상태를 보고했습니다.");
  }

  return {
    accepted: true,
    reason: "",
    cleanResult,
    contract,
    requiredArtifactPaths,
    missingArtifactPaths: [],
  };

  function rejected(reason: string): WorkerCompletionEvaluation {
    return {
      accepted: false,
      reason,
      cleanResult,
      ...(contract ? { contract } : {}),
      requiredArtifactPaths,
      missingArtifactPaths,
    };
  }
}

export function buildWorkerExecutionContract(requiredArtifactPaths: string[]): string {
  const artifactSection = requiredArtifactPaths.length > 0
    ? [
        "아래 필수 산출물을 실제로 생성하고, 반환 직전에 존재하며 비어 있지 않은지 확인하세요:",
        ...requiredArtifactPaths.map((artifactPath) => "- " + artifactPath),
      ].join("\n")
    : "파일 산출물이 없는 작업이면 확인한 근거, 실행 결과, 핵심 수치를 evidence에 적으세요.";

  return [
    "## 워커 완료 판정 계약",
    artifactSection,
    "최종 응답 맨 끝에 아래 블록을 반드시 포함하세요.",
    "실제로 완료된 경우:",
    "[WORKER_RESULT]",
    "status: completed",
    "summary: 완료 내용 한 줄",
    "evidence:",
    "- 직접 확인한 파일 경로, 실행 결과 또는 핵심 수치",
    "[/WORKER_RESULT]",
    "작업이 일부만 됐거나 실행할 수 없으면 status: failed와 reason을 쓰세요.",
    "완료되지 않은 작업을 completed로 보고하면 안 됩니다.",
  ].join("\n");
}

export function clearPersistedWorkerStatuses(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;

  let status: Record<string, Record<string, unknown>> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      status = parsed as Record<string, Record<string, unknown>>;
    }
  } catch {
    fs.writeFileSync(filePath, "{}\n", "utf-8");
    return 0;
  }

  const count = Object.values(status).reduce((total, chatStatuses) => {
    return total + (
      chatStatuses && typeof chatStatuses === "object" && !Array.isArray(chatStatuses)
        ? Object.keys(chatStatuses).length
        : 0
    );
  }, 0);

  if (count > 0) fs.writeFileSync(filePath, "{}\n", "utf-8");
  return count;
}

function parseNamedFields(block: string, names: string[]): Record<string, string> {
  const escapedNames = names.map(escapeRegExp).join("|");
  const headerRe = new RegExp("^(" + escapedNames + "):[ \\t]*", "gm");
  const headers = [...block.matchAll(headerRe)];
  const fields: Record<string, string> = {};

  for (let index = 0; index < headers.length; index++) {
    const header = headers[index];
    const name = header[1];
    if (fields[name] !== undefined || header.index === undefined) continue;
    const valueStart = header.index + header[0].length;
    const valueEnd = headers[index + 1]?.index ?? block.length;
    fields[name] = block.slice(valueStart, valueEnd).trim();
  }

  return fields;
}

function isUsableArtifact(artifactPath: string): boolean {
  try {
    const stat = fs.statSync(artifactPath);
    if (stat.isFile()) return stat.size > 0;
    if (stat.isDirectory()) return fs.readdirSync(artifactPath).length > 0;
    return false;
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
}



