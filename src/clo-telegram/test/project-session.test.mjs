import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  formatDesktopSessionEndMessage,
  formatDesktopTaskSummary,
  formatProjectDisplayName,
  formatProjectRelativePath,
  formatRecentFiles,
  getClaudeProjectStorePath,
  isReportableProjectPath,
  ProjectSessionManager,
  projectSessionKey,
  resolveProjectPathFromText,
} from "../dist/project-session.js";

test("getClaudeProjectStorePath matches Claude Code global project slug", () => {
  assert.equal(
    getClaudeProjectStorePath("C:/Projects/TestProject", "C:/Users/example/.claude").replace(/\\/g, "/"),
    "C:/Users/example/.claude/projects/C--Projects-TestProject",
  );
});

test("projectSessionKey isolates project sessions by normalized path", () => {
  assert.equal(
    projectSessionKey("C:/Projects/TestProject"),
    "project:c:/projects/testproject",
  );
});

test("ProjectSessionManager stores sdk session id and task summary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clo-project-session-"));
  const filePath = path.join(root, "project-sessions.json");
  try {
    const manager = new ProjectSessionManager(filePath);
    manager.ensureSession("C:/Projects/TestProject", "TestProject", "teleclo");
    const updated = manager.updateAfterTask("C:/Projects/TestProject", "sid_123", "README 작성");

    assert.equal(updated.sdkSessionId, "sid_123");
    assert.equal(updated.taskCount, 1);
    assert.equal(updated.lastTaskSummary, "README 작성");

    const reloaded = new ProjectSessionManager(filePath);
    assert.equal(reloaded.getSession("C:/Projects/TestProject")?.sdkSessionId, "sid_123");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ProjectSessionManager retries transient EPERM while saving metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clo-project-session-"));
  const filePath = path.join(root, "project-sessions.json");
  const originalRenameSync = fs.renameSync;
  let attempts = 0;
  try {
    fs.renameSync = (from, to) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("simulated EPERM");
        error.code = "EPERM";
        throw error;
      }
      return originalRenameSync(from, to);
    };

    const manager = new ProjectSessionManager(filePath);
    manager.ensureSession("C:/Projects/TestProject", "TestProject", "teleclo");

    assert.ok(attempts >= 2);
    assert.equal(fs.existsSync(filePath), true);
  } finally {
    fs.renameSync = originalRenameSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("ProjectSessionManager syncs desktop sessions and detects ended sessions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clo-project-session-"));
  const filePath = path.join(root, "project-sessions.json");
  try {
    const manager = new ProjectSessionManager(filePath);
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    manager.syncDesktopSessions([{
      sessionId: "vsc_1",
      cwd: "C:/Projects/TestProject",
      projectName: "testproject",
      startedAt,
      currentTask: "Edit: src/index.ts",
      recentFiles: ["C:/Projects/TestProject/src/index.ts"],
      lastActivity: startedAt,
      status: "working",
    }]);

    const result = manager.syncDesktopSessions([]);
    assert.equal(result.endedSessions.length, 1);
    assert.equal(result.endedSessions[0].projectSession.desktopSession?.status, "offline");
    assert.equal(result.endedSessions[0].projectSession.desktopSession?.lastActivity, startedAt);
    assert.ok(result.endedSessions[0].projectSession.desktopSession?.endedAt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("desktop session end message only prints required decision fields", () => {
  const projectPath = "C:/Projects/지원사업/정보사/source/svt2s_ios";
  const message = formatDesktopSessionEndMessage({
    projectPath,
    projectName: "svt2s_ios",
    sdkSessionId: "",
    createdAt: "2026-06-16T01:00:00.000Z",
    lastActivityAt: "2026-06-16T01:22:26.923Z",
    taskCount: 0,
    lastTaskSummary: "",
    status: "active",
    origin: "desktop",
    claudeProjectStorePath: "C:/Users/example/.claude/projects/C--Projects-test",
    desktopSession: {
      vscSessionId: "sid_1",
      currentTask: "Edit: C:/Projects/지원사업/정보사/source/svt2s_ios/40_진행계획/자료.md",
      lastActivity: "2026-06-16T01:21:00.000Z",
      recentFiles: ["C:/Projects/지원사업/정보사/source/svt2s_ios/40_진행계획/자료.md"],
      status: "offline",
      endedAt: "2026-06-16T01:22:26.923Z",
      summary: "자료 거버넌스 설계안을 수정하고 검증 항목을 정리했습니다.",
      remainingTasks: [
        "검증 결과를 Brain에 기록",
        "텔레클로 상태 조회 응답 확인",
      ],
    },
  }, {
    reason: "정상 종료 hook 이벤트",
    endedAt: "2026-06-16T01:22:26.923Z",
  });

  assert.match(message, /종료메시지: 데탑클로 세션 종료를 감지했습니다/);
  assert.match(message, /프로젝트명칭: 정보사 \/ svt2s_ios/);
  assert.match(message, /작업내용요약:\n- 자료 거버넌스 설계안을 수정하고 검증 항목을 정리했습니다/);
  assert.match(message, /남은작업목록:\n- 검증 결과를 Brain에 기록\n- 텔레클로 상태 조회 응답 확인/);
  assert.doesNotMatch(message, /^경로:/m);
  assert.doesNotMatch(message, /^종료시각:/m);
  assert.doesNotMatch(message, /^감지:/m);
  assert.doesNotMatch(message, /^최근 파일:/m);
  assert.doesNotMatch(message, /^상태 조회:/m);
  assert.doesNotMatch(message, /상세 경로와 파일 목록은 텔레그램으로 보내지 않았습니다/);
});

test("desktop session end message always prints mandatory fields", () => {
  const message = formatDesktopSessionEndMessage({
    projectPath: "C:/Projects/vision21",
    projectName: "vision21",
    sdkSessionId: "",
    createdAt: "2026-06-16T01:00:00.000Z",
    lastActivityAt: "2026-06-16T01:22:26.923Z",
    taskCount: 0,
    lastTaskSummary: "",
    status: "active",
    origin: "desktop",
    claudeProjectStorePath: "C:/Users/example/.claude/projects/C--Projects-test",
    desktopSession: {
      vscSessionId: "sid_1",
      status: "offline",
      endedAt: "2026-06-16T01:22:26.923Z",
    },
  }, {
    reason: "active 목록에서 사라짐",
    endedAt: "2026-06-16T01:22:26.923Z",
  });

  assert.match(message, /^종료메시지:/m);
  assert.match(message, /^프로젝트명칭: vision21$/m);
  assert.match(message, /^작업내용요약:\n- 저장된 작업 요약 없음$/m);
  assert.match(message, /^남은작업목록:\n- 세션 종료 요약에서 명시된 남은 작업 없음/m);
  assert.doesNotMatch(message, /^경로:/m);
  assert.doesNotMatch(message, /^종료시각:/m);
  assert.doesNotMatch(message, /^감지:/m);
  assert.doesNotMatch(message, /^최근 파일:/m);
  assert.doesNotMatch(message, /^상태 조회:/m);
});

test("desktop session end message extracts bullet summaries from json-like transcript text", () => {
  const message = formatDesktopSessionEndMessage({
    projectPath: "C:/Projects/AresDevsEngine/demo/gateway",
    projectName: "gateway",
    sdkSessionId: "",
    createdAt: "2026-06-16T01:00:00.000Z",
    lastActivityAt: "2026-06-16T01:22:26.923Z",
    taskCount: 0,
    lastTaskSummary: "",
    status: "active",
    origin: "desktop",
    claudeProjectStorePath: "C:/Users/example/.claude/projects/C--Projects-test",
    desktopSession: {
      vscSessionId: "sid_1",
      status: "offline",
      endedAt: "2026-06-16T01:22:26.923Z",
      summary: [
        "{\"title\":\"DEVS 3전략 비교\",\"summary\":\"3개 전략의 DEVS 시뮬 결과를 비교하고 균형 전략을 추천했습니다.\",\"type\":\"review\"}",
        "{\"title\":\"DEVS 엔진 검증\",\"summary\":\"적 방책 3안을 엔진으로 검증하고 지휘관 보고체계로 정리했습니다.\",\"type\":\"research\"}",
      ].join("\n"),
    },
  }, {
    reason: "정상 종료 hook 이벤트",
    endedAt: "2026-06-16T01:22:26.923Z",
  });

  assert.match(message, /작업내용요약:\n- 3개 전략의 DEVS 시뮬 결과를 비교하고 균형 전략을 추천했습니다\.\n- 적 방책 3안을 엔진으로 검증하고 지휘관 보고체계로 정리했습니다\./);
  assert.doesNotMatch(message, /\{"title"/);
});

test("desktop session end message extracts summary from truncated json-like text", () => {
  const message = formatDesktopSessionEndMessage({
    projectPath: "C:/Projects/지원사업/정보사",
    projectName: "정보사",
    sdkSessionId: "",
    createdAt: "2026-06-16T03:00:00.000Z",
    lastActivityAt: "2026-06-16T03:05:00.000Z",
    taskCount: 0,
    lastTaskSummary: "",
    status: "active",
    origin: "desktop",
    claudeProjectStorePath: "C:/Users/example/.claude/projects/C--Projects-test",
    desktopSession: {
      vscSessionId: "sid_2",
      status: "offline",
      endedAt: "2026-06-16T03:05:00.000Z",
      summary: "-{ \"title\": \"SVT2S 서버 B 거버넌스 실행\", \"summary\": \"서버 B(Gitea)에 svt2s 조직 신설, 산출물·참조자료·source 미러 7개 push 완료, PlatformEditorSW LF",
    },
  }, {
    reason: "정상 종료 hook 이벤트",
    endedAt: "2026-06-16T03:05:00.000Z",
  });

  assert.match(message, /작업내용요약:\n- 서버 B\(Gitea\)에 svt2s 조직 신설, 산출물·참조자료·source 미러 7개 push 완료, PlatformEditorSW LF/);
  assert.doesNotMatch(message, /SVT2S 서버 B 거버넌스 실행/);
  assert.doesNotMatch(message, /\{\s*"title"/);
});

test("project session display helpers use stable readable names", () => {
  assert.equal(
    formatProjectDisplayName("C:/Projects/지원사업/정보사/source/svt2s_ios", "svt2s_ios"),
    "정보사 / svt2s_ios",
  );
  assert.equal(formatProjectDisplayName("C:/Projects/vision21", "vision21"), "vision21");
  assert.equal(formatProjectRelativePath("C:/Projects/지원사업/정보사"), "지원사업/정보사");
  assert.equal(formatProjectRelativePath("D:/Projects/vision21"), "vision21");
  assert.equal(formatProjectRelativePath("C:/Workspace/vision21"), "C:/Workspace/vision21");
  assert.equal(
    formatDesktopTaskSummary("Bash: npm run build --password secret-value", "C:/Projects/vision21"),
    "명령 실행: npm run build --password ***",
  );
  assert.deepEqual(
    formatRecentFiles("C:/Projects/vision21", ["C:/Projects/vision21/src/index.ts"], 4),
    ["src/index.ts"],
  );
  assert.equal(isReportableProjectPath("C:/Projects/vision21"), true);
  assert.equal(isReportableProjectPath("D:/Projects/vision21"), true);
  assert.equal(isReportableProjectPath("C:/Users/ernham"), false);
});

test("resolveProjectPathFromText finds an existing project name under project root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clo-project-root-"));
  try {
    fs.mkdirSync(path.join(root, "AgentForge"));
    const resolved = resolveProjectPathFromText("@D AgentForge 빌드 확인해줘", { projectRoot: root });

    assert.equal(resolved?.projectName, "AgentForge");
    assert.equal(resolved?.projectPath, path.resolve(root, "AgentForge").replace(/\\/g, "/"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("resolveProjectPathFromText ignores project-name matches inside web URLs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clo-project-root-"));
  try {
    fs.mkdirSync(path.join(root, ".claude"));

    const resolved = resolveProjectPathFromText(
      "https://code.claude.com/docs/en/desktop-ios-simulator",
      { projectRoot: root },
    );

    assert.equal(resolved, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveProjectPathFromText prefers existing absolute paths with Korean folders", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clo-project-root-"));
  const projectPath = path.join(root, "지원사업", "함정탑재");
  try {
    fs.mkdirSync(projectPath, { recursive: true });

    const slashInput = `${projectPath.replace(/\\/g, "/")}에서 작업해줘`;
    const slashResolved = resolveProjectPathFromText(slashInput, { projectRoot: path.join(root, "unused") });
    assert.equal(slashResolved?.projectName, "함정탑재");
    assert.equal(slashResolved?.projectPath, path.resolve(projectPath).replace(/\\/g, "/"));

    const quotedInput = `"${projectPath}" 수정해줘`;
    const quotedResolved = resolveProjectPathFromText(quotedInput, { projectRoot: path.join(root, "unused") });
    assert.equal(quotedResolved?.projectName, "함정탑재");
    assert.equal(quotedResolved?.projectPath, path.resolve(projectPath).replace(/\\/g, "/"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
