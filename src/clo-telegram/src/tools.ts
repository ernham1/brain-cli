import { createRequire } from "node:module";
import type Anthropic from "@anthropic-ai/sdk";

const require = createRequire(import.meta.url);

// brain-cli 모듈 직접 로드 (같은 프로세스, 제로 레이턴시)
const { boot } = require("../../brain-cli/src/boot.js");
const { search } = require("../../brain-cli/src/search.js");
const { BWTEngine } = require("../../brain-cli/src/bwt.js");
const { getDefaultBrainRoot } = require("../../brain-cli/src/utils.js");

// --- Anthropic 도구 정의 ---

export const brainTools: Anthropic.Messages.Tool[] = [
  {
    name: "brain_recall",
    description:
      "Brain 장기기억에서 관련 기억을 검색합니다. " +
      "이전 대화, 프로젝트 결정, 기술 노트, 사용자 선호 등을 찾을 수 있습니다.",
    input_schema: {
      type: "object" as const,
      properties: {
        goal: {
          type: "string",
          description: "검색 키워드 또는 목표 (예: '텔레그램 봇 설계')",
        },
        topK: {
          type: "number",
          description: "반환할 최대 결과 수 (기본 5)",
        },
      },
      required: ["goal"],
    },
  },
  {
    name: "brain_write",
    description:
      "Brain 장기기억에 새로운 기억을 저장합니다. " +
      "중요한 결정, 새로운 선호, 프로젝트 상태 등을 기록할 때 사용합니다.",
    input_schema: {
      type: "object" as const,
      properties: {
        intent: {
          type: "string",
          description:
            "Intent JSON 문자열. " +
            '형식: {"action":"create","sourceRef":"<경로>","content":"<본문>",' +
            '"record":{"scopeType":"...","scopeId":"...","type":"...","title":"...","summary":"...","tags":[...],"sourceType":"candidate"}}',
        },
      },
      required: ["intent"],
    },
  },
];

// --- 도구 실행 ---

interface RecallInput {
  goal: string;
  topK?: number;
}

interface WriteInput {
  intent: string;
}

interface DigestCandidate {
  score: number;
  title: string;
  summary: string;
}

export function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  brainRoot: string,
): string {
  try {
    switch (toolName) {
      case "brain_recall":
        return executeRecall(input as unknown as RecallInput, brainRoot);
      case "brain_write":
        return executeWrite(input as unknown as WriteInput, brainRoot);
      default:
        return `알 수 없는 도구: ${toolName}`;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `도구 실행 오류 (${toolName}): ${msg}`;
  }
}

export function executeRecall(input: RecallInput, _brainRoot: string): string {
  // brain-cli 자동 탐지로 정확한 Brain 데이터 경로 사용
  const resolvedRoot = getDefaultBrainRoot();
  if (!resolvedRoot) {
    return "Brain 경로를 찾을 수 없습니다.";
  }

  const bootResult = boot(resolvedRoot, {});
  if (!bootResult.success) {
    return `Brain 부트 실패: ${bootResult.error}`;
  }

  const result = search(resolvedRoot, {
    currentGoal: input.goal,
    topK: input.topK || 5,
  });

  const relevant = result.candidates.filter(
    (c: DigestCandidate) => c.score > 0,
  );

  if (relevant.length === 0) {
    return "관련 기억 없음";
  }

  return relevant
    .map((c: DigestCandidate) => `[${c.score}] ${c.title} — ${c.summary}`)
    .join("\n");
}

function executeWrite(input: WriteInput, _brainRoot: string): string {
  const resolvedRoot = getDefaultBrainRoot();
  if (!resolvedRoot) {
    return "Brain 경로를 찾을 수 없습니다.";
  }

  const intent = JSON.parse(input.intent);
  const engine = new BWTEngine(resolvedRoot);
  const result = engine.execute(intent);

  if (result.success) {
    return `저장 완료: ${result.recordId}`;
  }
  return `저장 실패: ${JSON.stringify(result.report)}`;
}
