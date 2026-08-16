import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const botSource = readFileSync(new URL("../src/bot.ts", import.meta.url), "utf-8");
const bridgeSource = readFileSync(new URL("../src/bridge.ts", import.meta.url), "utf-8");
const schedulerSource = readFileSync(new URL("../src/scheduler.ts", import.meta.url), "utf-8");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
const projectSessionSource = readFileSync(new URL("../src/project-session.ts", import.meta.url), "utf-8");

test("bot dispatches VS Code tasks through orchestrator runtime", () => {
  assert.match(botSource, /new OrchestratorBridgeRuntime/);
  assert.match(botSource, /orchestratorRuntime\.trackBridgeDispatch/);
  assert.match(botSource, /이후 이사님 결정이 필요한 경우만 브리프/);
  assert.doesNotMatch(botSource, /작업 완료되면 오케스트레이터가 검증해서 알려드릴게요/);
});

test("scheduler sends only decision briefs for tracked bridge results", () => {
  assert.match(schedulerSource, /setBridgeTaskResultHandler/);
  assert.match(schedulerSource, /handleBridgeTaskResult/);
  assert.match(schedulerSource, /decisionBrief/);
  assert.match(schedulerSource, /if \(!decisionBrief\?\.trim\(\)\)/);
  assert.doesNotMatch(schedulerSource, /orchestratedMessage \?\?/);
  assert.doesNotMatch(schedulerSource, /VS Code 작업 완료/);
});

test("index wires createBot orchestrator runtime into scheduler", () => {
  assert.match(indexSource, /orchestratorRuntime/);
  assert.match(indexSource, /scheduler\.setBridgeTaskResultHandler/);
  assert.match(indexSource, /scheduler\.setDesktopSessionEndHandler/);
});

test("index does not flush Telegram updates on startup or runner restart", () => {
  assert.match(indexSource, /미확인 업데이트 flush 생략/);
  assert.doesNotMatch(indexSource, /offset:\s*-1/);
  assert.match(indexSource, /telegramRunnerOptions[\s\S]*silent:\s*true/);
  assert.equal((indexSource.match(/run\(bot, telegramRunnerOptions\)/g) ?? []).length, 2);
});

test("scheduler records local desktop session end events without raw notification", () => {
  assert.match(bridgeSource, /pollSessionEndEvents/);
  assert.match(bridgeSource, /currentTask\?: string/);
  assert.match(bridgeSource, /summary\?: string/);
  assert.match(bridgeSource, /remainingTasks\?: string\[\]/);
  assert.match(schedulerSource, /checkSessionEndEvents/);
  assert.match(schedulerSource, /notifyDesktopSessionEnd/);
  assert.match(schedulerSource, /setDesktopSessionEndHandler/);
  assert.match(schedulerSource, /handleDesktopSessionEnd/);
  assert.match(schedulerSource, /프로젝트 세션 종료 내부 처리/);
  assert.match(schedulerSource, /pendingDesktopSessionEnds/);
  assert.match(schedulerSource, /flushPendingDesktopSessionEndNotifications/);
  assert.match(schedulerSource, /SESSION_END_NOTIFY_QUIET_MS/);
  assert.doesNotMatch(schedulerSource, /formatDesktopSessionEndMessage/);
  assert.match(projectSessionSource, /종료메시지:/);
});

test("bot suppresses raw Brain memory write completion replies", () => {
  assert.match(botSource, /shouldSendAutopilotResponse/);
  assert.match(botSource, /Brain 기억 후보 내부 저장/);
  assert.doesNotMatch(botSource, /Brain에 기억 후보를 저장했습니다/);
  assert.doesNotMatch(botSource, /저장 완료:/);
});

test("bot routes explicit project paths through resolved project dispatch", () => {
  assert.match(botSource, /isExplicitProjectWorkRequest/);
  assert.match(botSource, /resolveProjectPathFromText/);
  assert.match(botSource, /dispatchResolvedProjectWork/);
  assert.match(botSource, /taskRouter\.decide\(text, vscBridge\.getSafeActiveSessions\(\)\)/);
  assert.match(botSource, /orchestratorRuntime\.trackBridgeDispatch/);
});

test("bot launches PC project sessions instead of direct TeleClo fallback", () => {
  assert.match(botSource, /new ProjectSessionLauncher/);
  assert.match(botSource, /launchPcProjectSession/);
  assert.match(botSource, /bridgeTaskInitialStatus: "launched"/);
  assert.match(botSource, /vscBridge\.getTask/);
  assert.match(botSource, /projectSessionLauncher\.launch/);
});
