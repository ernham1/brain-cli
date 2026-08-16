import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPendingDecisionBriefSection } from "../dist/agent.js";
import { DecisionJournal } from "../dist/orchestrator/decision-journal.js";
import { OrchestratorBridgeRuntime } from "../dist/orchestrator/bridge-runtime.js";
import { OrchestratorStore } from "../dist/orchestrator/store.js";
import { TwinDecider } from "../dist/orchestrator/twin-decider.js";
import { ProjectSessionManager } from "../dist/project-session.js";
import { BotScheduler, ReminderStore } from "../dist/scheduler.js";
import { makeSessionKey, SessionManager } from "../dist/session.js";

const OWNER_CHAT_ID = 64445716;

function createConfig(rootDir) {
  return {
    ownerChatIds: [OWNER_CHAT_ID],
    ownerUserIds: [OWNER_CHAT_ID],
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

function createRuntime(rootDir) {
  const createdBridgeTasks = [];
  const runtime = new OrchestratorBridgeRuntime({
    store: new OrchestratorStore(path.join(rootDir, "orchestrator")),
    // v1 기준 흐름 검증: 트윈 비활성(지식팩 없음) + 저널 격리 (실제 ~/.claude 저널 오염 금지)
    twinDecider: new TwinDecider({ knowledgePackPath: path.join(rootDir, "no-pack.md") }),
    decisionJournal: new DecisionJournal(path.join(rootDir, "decision-journal")),
    reversalsDir: path.join(rootDir, "reversals"),
    bridgeTaskCreator: {
      createTask: (params) => {
        const taskId = `task_${createdBridgeTasks.length + 1}`;
        createdBridgeTasks.push({ taskId, ...params });
        return taskId;
      },
    },
  });
  return { runtime, createdBridgeTasks };
}

test("TeleClo orchestrator UAT: PC session result loops through rework and numbered decision brief", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clo-closed-loop-uat-"));
  try {
    const { runtime, createdBridgeTasks } = createRuntime(root);
    const sentMessages = [];
    const bot = {
      api: {
        sendMessage: async (chatId, message, options) => {
          sentMessages.push({ chatId, message, options });
        },
      },
    };
    const scheduler = new BotScheduler(bot, createConfig(root), new ReminderStore(root));
    const projectSessionManager = new ProjectSessionManager(path.join(root, "project-sessions.json"));

    const projectPath = "C:/Projects/UatDemo";
    const endedAt = new Date(Date.now() - 120_000).toISOString();
    let activeSessions = [{
      sessionId: "desktop_uat_1",
      cwd: projectPath,
      projectName: "uat-demo",
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      lastActivity: new Date(Date.now() - 180_000).toISOString(),
      currentTask: "UAT용 남은 작업 확인",
      recentFiles: ["C:/Projects/UatDemo/src/orchestrator.ts"],
      status: "working",
    }];
    let sessionEndEvents = [{
      id: "evt_uat_1",
      sessionId: "desktop_uat_1",
      cwd: projectPath,
      projectName: "uat-demo",
      endedAt,
      summary: "작업 중 세션 종료. 남은 작업은 검증 증거 보강.",
      remainingTasks: ["결과 전문 확인", "검증 증거를 포함한 완료 보고"],
      recentFiles: ["C:/Projects/UatDemo/src/orchestrator.ts"],
    }];
    let taskResults = [];
    const bridge = {
      getSafeActiveSessions: () => activeSessions,
      pollSessionEndEvents: () => {
        const result = sessionEndEvents;
        sessionEndEvents = [];
        return result;
      },
      pollWatcherNotify: () => [],
      pollExpiredTasks: () => [],
      pollTaskResults: () => {
        const result = taskResults;
        taskResults = [];
        return result;
      },
      cleanupExpired: () => {},
      cleanupStale: () => {},
    };

    scheduler.setVscBridge(bridge);
    scheduler.setProjectSessionManager(projectSessionManager);
    scheduler.setDesktopSessionEndHandler({
      handleDesktopSessionEnd: (review) => runtime.handleDesktopSessionEnd(review).message,
    });
    scheduler.setBridgeTaskResultHandler({
      handleBridgeTaskResult: async (result) => (await runtime.handleBridgeTaskResult(result))?.message ?? null,
    });

    await scheduler.checkBridgeTasks();
    assert.equal(createdBridgeTasks.length, 0, "active desktop session should not be continued before quiet flush");
    assert.equal(sentMessages.length, 0, "session-end summary must not create Telegram noise while queued");

    activeSessions = [];
    await scheduler.checkBridgeTasks();
    assert.equal(createdBridgeTasks.length, 1, "remaining desktop work should be re-dispatched");
    assert.equal(sentMessages.length, 0, "remaining-work continuation must stay internal");
    assert.match(createdBridgeTasks[0].instruction, /이전 PC 세션 종료 후 남은 작업을 계속 진행/);
    assert.match(createdBridgeTasks[0].instruction, /결과 전문 확인/);

    taskResults = [{
      taskId: "task_1",
      sourceChatId: OWNER_CHAT_ID,
      sourceMessageId: 101,
      status: "completed",
      result: "세션 기록 완료: 작업 상태를 Brain에 기록함(rec_topic_misc_20260625_0001).",
      completedAt: new Date().toISOString(),
    }];
    await scheduler.checkBridgeTasks();
    assert.equal(sentMessages.length, 0, "bookkeeping-only worker result must not ask the owner");
    assert.equal(createdBridgeTasks.length, 2, "bookkeeping-only result should be sent back as rework");
    assert.match(createdBridgeTasks[1].instruction, /\[ORCHESTRATOR_REWORK\]/);
    assert.match(createdBridgeTasks[1].instruction, /non_actionable_worker_result/);
    assert.match(createdBridgeTasks[1].instruction, /실제 산출물, 검증 결과, 남은 이슈/);

    taskResults = [{
      taskId: "task_2",
      sourceChatId: OWNER_CHAT_ID,
      sourceMessageId: 102,
      status: "completed",
      result: [
        "작업 완료 보고.",
        "결과 전문 확인: PRISM 7-Layer 전체를 bandingai_result로 확인했고 D/G/E Layer 누락 없음.",
        "검증 증거: 하네스 UAT 통과, 재작업 후 남은 이슈 없음.",
      ].join("\n"),
      completedAt: new Date().toISOString(),
    }];
    await scheduler.checkBridgeTasks();

    // 자율 승인: 모든 게이트 통과 + RED risk 없음 + 워커 보고 있음 → 이사님 확인 없이 자동 PASS
    // 자율 승인 메시지가 Telegram으로 전송되지 않아야 함 (일일 요약에만 포함)
    assert.equal(sentMessages.length, 0, "auto-approved result should not be sent to Telegram as decision brief");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
