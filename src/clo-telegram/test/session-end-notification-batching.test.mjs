import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BotScheduler, ReminderStore } from "../dist/scheduler.js";
import { ProjectSessionManager } from "../dist/project-session.js";
import { SessionManager, makeSessionKey } from "../dist/session.js";

function createConfig(rootDir) {
  return {
    ownerChatIds: [64445716],
    ownerUserIds: [64445716],
    sessionDir: path.join(rootDir, "sessions"),
    proactiveEnabled: false,
    proactiveMaxDaily: 0,
    proactiveMinInterval: 0,
    proactiveGroupChatId: undefined,
    briefingEnabled: false,
    briefingHour: 9,
    githubReportEnabled: false,
    githubReportHour: 9,
    brainRoot: rootDir,
  };
}

test("scheduler keeps desktop session end summaries internal without Telegram noise", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clo-session-end-batch-"));
  try {
    const endedAt1 = new Date(Date.now() - 120_000).toISOString();
    const endedAt2 = new Date(Date.now() - 110_000).toISOString();
    const sentMessages = [];
    const handledReviews = [];
    const bot = {
      api: {
        sendMessage: async (chatId, message) => {
          sentMessages.push({ chatId, message });
        },
      },
    };
    const scheduler = new BotScheduler(bot, createConfig(root), new ReminderStore(root));
    const manager = new ProjectSessionManager(path.join(root, "project-sessions.json"));

    let activeSessions = [{
      sessionId: "still_working",
      cwd: "C:/Projects/AresDevsEngine/demo/gateway",
      projectName: "gateway",
      startedAt: new Date(Date.now() - 300_000).toISOString(),
      currentTask: "Bash: node run-devs.js",
      lastActivity: new Date(Date.now() - 60_000).toISOString(),
      recentFiles: ["C:/Projects/AresDevsEngine/demo/gateway/src/devs.ts"],
      status: "working",
    }];
    let events = [
      {
        id: "evt_1",
        sessionId: "sid_1",
        cwd: "C:/Projects/AresDevsEngine/demo/gateway",
        projectName: "gateway",
        endedAt: endedAt1,
        summary: "{\"summary\":\"3개 전략의 DEVS 시뮬 결과를 비교했습니다.\"}",
        remainingTasks: ["결과 표를 지휘관 보고 형식으로 정리"],
      },
      {
        id: "evt_2",
        sessionId: "sid_2",
        cwd: "C:/Projects/AresDevsEngine/demo/gateway",
        projectName: "gateway",
        endedAt: endedAt2,
        summary: "{\"summary\":\"적 방책 3안을 엔진으로 검증했습니다.\"}",
        remainingTasks: ["후속 검증 시나리오 추가"],
      },
    ];

    const bridge = {
      getSafeActiveSessions: () => activeSessions,
      pollSessionEndEvents: () => {
        const result = events;
        events = [];
        return result;
      },
      pollWatcherNotify: () => [],
      pollExpiredTasks: () => [],
      pollTaskResults: () => [],
      cleanupExpired: () => {},
      cleanupStale: () => {},
    };

    scheduler.setVscBridge(bridge);
    scheduler.setProjectSessionManager(manager);
    scheduler.setDesktopSessionEndHandler({
      handleDesktopSessionEnd: (review) => {
        handledReviews.push(review);
        return null;
      },
    });

    await scheduler.checkBridgeTasks();
    assert.equal(sentMessages.length, 0);

    activeSessions = [];
    await scheduler.checkBridgeTasks();
    assert.equal(sentMessages.length, 0);
    assert.equal(handledReviews.length, 1);
    assert.deepEqual(handledReviews[0].remainingTasks, ["결과 표를 지휘관 보고 형식으로 정리", "후속 검증 시나리오 추가"]);

    await scheduler.checkBridgeTasks();
    assert.equal(sentMessages.length, 0);
    assert.equal(handledReviews.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scheduler stores emitted decision briefs in chat history", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clo-decision-history-"));
  try {
    const sentMessages = [];
    const bot = {
      api: {
        sendMessage: async (chatId, message, options) => {
          sentMessages.push({ chatId, message, options });
        },
      },
    };
    let results = [{
      taskId: "task_decision",
      sourceChatId: 64445716,
      sourceMessageId: 99,
      status: "completed",
      result: "완료 보고",
      completedAt: "2026-06-24T00:00:00.000Z",
    }];
    const bridge = {
      getSafeActiveSessions: () => [],
      pollSessionEndEvents: () => [],
      pollWatcherNotify: () => [],
      pollExpiredTasks: () => [],
      pollTaskResults: () => {
        const polled = results;
        results = [];
        return polled;
      },
      cleanupExpired: () => {},
      cleanupStale: () => {},
    };
    const decisionBrief = [
      "판단: 이사님 결정 필요",
      "작업: agentforge 남은 작업 계속 진행",
      "선택지: A 완료 인정 / B 빠진 부분 재작업 / C 근거 더 요청",
    ].join("\n");

    const scheduler = new BotScheduler(bot, createConfig(root), new ReminderStore(root));
    scheduler.setVscBridge(bridge);
    scheduler.setBridgeTaskResultHandler({
      handleBridgeTaskResult: () => decisionBrief,
    });

    await scheduler.checkBridgeTasks();

    assert.equal(sentMessages.length, 1);
    const session = new SessionManager(path.join(root, "sessions")).load(makeSessionKey(64445716));
    assert.match(session?.history.at(-1)?.content ?? "", /결정번호: 클로-1 \(1번\)/);
    assert.match(session?.history.at(-1)?.content ?? "", /선택지: A 완료 인정/);
    assert.equal(session?.pendingDecisionBriefs?.at(-1)?.label, "클로-1");
    assert.equal(session?.pendingDecisionBriefs?.at(-1)?.taskId, "task_decision");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});



