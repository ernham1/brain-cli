import fs from "node:fs";
import path from "node:path";
import type { VscSession } from "./bridge.js";

export interface RouteDecision {
  shouldRoute: boolean;
  targetSession: VscSession | null;
  reason: "vscode_task" | "chat_only" | "no_session" | "ambiguous_session";
  projectHint?: string;
}

// 명시적 트리거: @D 또는 @데스크탑 또는 @vscode
const VSCODE_TRIGGER = /^@D\s+|^@데스크탑\s+|^@vscode\s+/i;

// 텔레그램 자신에게 명시적 지정: @T
export const TELEGRAM_TRIGGER = /^@T\s+/i;

/** data/project-aliases.json에서 한글 별칭 로드. 형식: { "브레인": "brain", "토크업": "talkup" } */
function loadAliases(): Record<string, string> {
  try {
    const aliasPath = path.join(process.cwd(), "data", "project-aliases.json");
    return JSON.parse(fs.readFileSync(aliasPath, "utf-8"));
  } catch {
    return {};
  }
}

export class TaskRouter {
  decide(message: string, activeSessions: VscSession[]): RouteDecision {
    const text = message.trim();

    if (!VSCODE_TRIGGER.test(text)) {
      return { shouldRoute: false, targetSession: null, reason: "chat_only" };
    }

    const instruction = text.replace(VSCODE_TRIGGER, "").trim();
    const instructionLower = instruction.toLowerCase();

    if (activeSessions.length === 0) {
      return { shouldRoute: true, targetSession: null, reason: "no_session" };
    }

    if (activeSessions.length === 1) {
      return { shouldRoute: true, targetSession: activeSessions[0], reason: "vscode_task" };
    }

    // 1단계: 한글 별칭 매칭 (data/project-aliases.json)
    const aliases = loadAliases();
    for (const [alias, projectName] of Object.entries(aliases)) {
      if (instructionLower.includes(alias.toLowerCase())) {
        const resolution = resolveSessionByProject(projectName, activeSessions);
        if (resolution === "ambiguous") {
          return { shouldRoute: true, targetSession: null, reason: "ambiguous_session", projectHint: projectName };
        }
        if (resolution) {
          return { shouldRoute: true, targetSession: resolution, reason: "vscode_task", projectHint: projectName };
        }
        return { shouldRoute: true, targetSession: null, reason: "no_session", projectHint: projectName };
      }
    }

    // 2단계: 활성 세션의 projectName으로 동적 매칭 (영문, 하드코딩 불필요)
    for (const session of activeSessions) {
      if (instructionLower.includes(session.projectName.toLowerCase())) {
        const resolution = resolveSessionByProject(session.projectName, activeSessions);
        if (resolution === "ambiguous") {
          return { shouldRoute: true, targetSession: null, reason: "ambiguous_session", projectHint: session.projectName };
        }
        return { shouldRoute: true, targetSession: resolution, reason: "vscode_task", projectHint: session.projectName };
      }
    }

    // 3단계: 매칭 없으면 대상 없음으로 반환한다. 최신 세션 자동 선택은 오작동 위험이 크다.
    return { shouldRoute: true, targetSession: null, reason: "ambiguous_session" };
  }
}

function resolveSessionByProject(projectName: string, sessions: VscSession[]): VscSession | "ambiguous" | null {
  const matches = sessions.filter((session) => session.projectName.toLowerCase() === projectName.toLowerCase());
  if (matches.length === 0) return null;
  if (matches.length > 1) return "ambiguous";
  return matches[0];
}
