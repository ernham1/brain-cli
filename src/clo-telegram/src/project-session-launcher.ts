import { spawn } from "node:child_process";

export type LaunchAgent = "codex" | "claude";

export interface LaunchBridgeTask {
  taskId: string;
  sourceChatId: number;
  sourceMessageId: number;
  targetCwd: string;
  instruction: string;
  resultFile: string;
}

export interface ProjectSessionLaunchInput {
  projectName: string;
  projectPath: string;
  instruction: string;
  bridgeTask: LaunchBridgeTask;
  /** 실행할 CLI 에이전트. 기본값 "codex" */
  agent?: LaunchAgent;
}

export interface ProjectSessionLaunchResult {
  vscodeLaunched: boolean;
  agentLaunched: boolean;
  agentUsed: LaunchAgent;
  errors: string[];
}

export interface ProjectSessionLauncherOptions {
  codeCommand?: string;
  codexCommand?: string;
  claudeCommand?: string;
  spawnDetached?: (command: string, args: string[]) => void;
}

export class ProjectSessionLauncher {
  private readonly codeCommand: string;
  private readonly codexCommand: string;
  private readonly claudeCommand: string;
  private readonly spawnDetached: (command: string, args: string[]) => void;

  constructor(options: ProjectSessionLauncherOptions = {}) {
    this.codeCommand = options.codeCommand ?? "code";
    this.codexCommand = options.codexCommand ?? "codex";
    this.claudeCommand = options.claudeCommand ?? "claude";
    this.spawnDetached = options.spawnDetached ?? spawnDetachedProcess;
  }

  launch(input: ProjectSessionLaunchInput): ProjectSessionLaunchResult {
    const errors: string[] = [];
    let vscodeLaunched = false;
    let agentLaunched = false;
    const agent: LaunchAgent = input.agent ?? "codex";

    try {
      this.spawnDetached(this.codeCommand, ["-n", input.projectPath]);
      vscodeLaunched = true;
    } catch (error) {
      errors.push(`VS Code launch failed: ${formatError(error)}`);
    }

    try {
      if (agent === "claude") {
        this.spawnDetached("cmd.exe", [
          "/c",
          "start",
          "",
          "cmd.exe",
          "/k",
          this.claudeCommand,
          "--dangerously-skip-permissions",
          "--cwd",
          input.projectPath,
          "-p",
          buildClaudeLaunchPrompt(input),
        ]);
      } else {
        this.spawnDetached("cmd.exe", [
          "/c",
          "start",
          "",
          "cmd.exe",
          "/k",
          this.codexCommand,
          "-C",
          input.projectPath,
          "--sandbox",
          "workspace-write",
          "--full-auto",
          buildCodexLaunchPrompt(input),
        ]);
      }
      agentLaunched = true;
    } catch (error) {
      errors.push(`${agent === "claude" ? "Claude Code" : "Codex"} launch failed: ${formatError(error)}`);
    }

    return { vscodeLaunched, agentLaunched, agentUsed: agent, errors };
  }
}

function buildResultFileInstruction(input: ProjectSessionLaunchInput): string {
  return [
    "완료 후 반드시 아래 resultFile 경로에 JSON을 저장하세요.",
    input.bridgeTask.resultFile,
    "",
    "저장 형식:",
    JSON.stringify({
      taskId: input.bridgeTask.taskId,
      sourceChatId: input.bridgeTask.sourceChatId,
      sourceMessageId: input.bridgeTask.sourceMessageId,
      status: "completed",
      result: "작업 결과 요약, 검증 증거, 남은 이슈를 작성",
      completedAt: new Date().toISOString(),
    }, null, 2),
  ].join("\n");
}

function buildBasePromptLines(input: ProjectSessionLaunchInput): string[] {
  return [
    "텔레클로가 새 PC 작업 세션으로 전달한 작업입니다.",
    "",
    "작업 지시:",
    input.instruction,
    "",
    "작업 기준:",
    "- 현재 프로젝트 파일을 직접 확인한 뒤 진행하세요.",
    "- 필요한 설계서/지시서/검증 루프를 먼저 작성하거나 갱신하세요.",
    "- 완료 전 변경 파일과 검증 증거를 확인하세요.",
    "",
    buildResultFileInstruction(input),
  ];
}

function buildCodexLaunchPrompt(input: ProjectSessionLaunchInput): string {
  return buildBasePromptLines(input).join("\n");
}

function buildClaudeLaunchPrompt(input: ProjectSessionLaunchInput): string {
  return buildBasePromptLines(input).join("\n");
}

function spawnDetachedProcess(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
