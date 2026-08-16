import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/**
 * brain-cli의 src/ 디렉토리 경로를 동적으로 해결한다.
 * 우선순위: 환경변수 → 모노레포 상대경로 → npm 글로벌
 */
export function resolveBrainCliSrc(): string {
  // 1순위: 명시적 환경변수
  if (process.env.BRAIN_CLI_PATH) {
    const p = path.resolve(process.env.BRAIN_CLI_PATH);
    if (fs.existsSync(path.join(p, "boot.js"))) return p;
  }

  // 2순위: 모노레포 상대경로 (개발/PM2 운영 모드)
  const monorepoPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../brain-cli/src",
  );
  if (fs.existsSync(path.join(monorepoPath, "boot.js"))) return monorepoPath;

  // 3순위: npm 글로벌 설치 경로
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf-8", windowsHide: true }).trim();
    const globalPath = path.join(globalRoot, "@ernham", "brain-cli", "src");
    if (fs.existsSync(path.join(globalPath, "boot.js"))) return globalPath;
  } catch { /* npm 명령 실패 시 다음 전략 */ }

  throw new Error(
    "brain-cli를 찾을 수 없습니다. npm install -g @ernham/brain-cli로 설치하세요.",
  );
}

/**
 * Claude Code CLI 실행 파일 경로를 동적으로 해결한다.
 */
export function resolveClaudeCodePath(): string {
  // 1순위: 명시적 환경변수
  if (process.env.CLAUDE_CODE_PATH) return process.env.CLAUDE_CODE_PATH;

  // 2순위: npm 글로벌 설치의 실제 CLI 바이너리 (.exe 또는 cli.js)
  // 주의: AnthropicClaude (네이티브 인스톨러)는 데스크탑 Electron 앱이므로 사용 금지
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf-8", windowsHide: true }).trim();
    const pkgDir = path.join(globalRoot, "@anthropic-ai", "claude-code");
    const candidates = [
      path.join(pkgDir, "bin", "claude.exe"),    // 신규 구조
      path.join(pkgDir, "claude.exe"),           // 구 루트 구조
      path.join(pkgDir, "cli.js"),               // 레거시 JS 진입점
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  } catch { /* npm 명령 실패 시 다음 전략 */ }

  // 3순위: which/where로 탐색 (마지막 폴백)
  try {
    const cmd = process.platform === "win32" ? "where claude" : "which claude";
    const result = execSync(cmd, { encoding: "utf-8", windowsHide: true }).trim().split("\n")[0];
    if (result) return result;
  } catch { /* 명령 실패 시 폴백 */ }

  throw new Error(
    "Claude Code CLI를 찾을 수 없습니다. npm install -g @anthropic-ai/claude-code로 설치하세요.",
  );
}

// brain-cli 모듈 로더 — tools.ts에서 사용
const brainCliSrc = resolveBrainCliSrc();

export const brainCli = {
  boot: require(path.join(brainCliSrc, "boot.js")).boot,
  search: require(path.join(brainCliSrc, "search.js")).search,
  BWTEngine: require(path.join(brainCliSrc, "bwt.js")).BWTEngine,
  createMemoryBrief: require(path.join(brainCliSrc, "context-assembler.js")).createMemoryBrief,
  guardDraft: require(path.join(brainCliSrc, "answer-guard.js")).guardDraft,
  getDefaultBrainRoot: require(path.join(brainCliSrc, "utils.js")).getDefaultBrainRoot,
  readJsonl: require(path.join(brainCliSrc, "utils.js")).readJsonl,
};
