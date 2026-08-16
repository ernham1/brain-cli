import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { VscBridge } from "../dist/bridge.js";

function withTempCwd(run) {
  const originalCwd = process.cwd();
  const dir = mkdtempSync(path.join(tmpdir(), "clo-bridge-hardening-"));
  try {
    process.chdir(dir);
    return run(dir);
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

function createBridge() {
  return new VscBridge({}, { ownerUserIds: [] });
}

function writeActiveSnapshot(rootDir, snapshot) {
  const bridgeDir = path.join(rootDir, "data", "bridge");
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(path.join(bridgeDir, "vscode-active.json"), JSON.stringify(snapshot, null, 2), "utf-8");
}

function session(sessionId, projectName, watcherPid = 1000) {
  return {
    sessionId,
    cwd: `C:/Projects/${projectName}`,
    projectName,
    startedAt: `2026-06-12T00:0${sessionId.length % 9}:00.000Z`,
    watcherPid,
  };
}

test("VscBridge safe sessions reject stale active heartbeat", () => withTempCwd((rootDir) => {
  const bridge = createBridge();
  writeActiveSnapshot(rootDir, {
    updatedAt: "2026-06-12T00:00:00.000Z",
    sessions: [session("a", "brain")],
  });

  assert.equal(bridge.getActiveSessions().length, 1);
  const safeSessions = bridge.getSafeActiveSessions({
    now: new Date("2026-06-12T00:11:00.000Z"),
    ttlMs: 10 * 60 * 1000,
    isProcessAlive: () => true,
  });

  assert.deepEqual(safeSessions, []);
}));

test("VscBridge safe sessions filter dead watcher processes", () => withTempCwd((rootDir) => {
  const bridge = createBridge();
  writeActiveSnapshot(rootDir, {
    updatedAt: "2026-06-12T00:00:00.000Z",
    sessions: [
      session("alive", "brain", 111),
      session("dead", "brain", 222),
      { ...session("nopid", "brain"), watcherPid: undefined },
    ],
  });

  const safeSessions = bridge.getSafeActiveSessions({
    now: new Date("2026-06-12T00:01:00.000Z"),
    ttlMs: 10 * 60 * 1000,
    isProcessAlive: (pid) => pid === 111,
  });

  assert.deepEqual(safeSessions.map((item) => item.sessionId), ["alive", "nopid"]);
}));

test("VscBridge resolveProjectSession returns ambiguous instead of latest match", () => withTempCwd((rootDir) => {
  const bridge = createBridge();
  writeActiveSnapshot(rootDir, {
    updatedAt: "2026-06-12T00:00:00.000Z",
    sessions: [
      { ...session("older", "brain"), startedAt: "2026-06-12T00:01:00.000Z" },
      { ...session("newer", "brain"), startedAt: "2026-06-12T00:02:00.000Z" },
    ],
  });

  const resolution = bridge.resolveProjectSession("brain", {
    now: new Date("2026-06-12T00:01:00.000Z"),
    ttlMs: 10 * 60 * 1000,
    isProcessAlive: () => true,
  });

  assert.equal(resolution.status, "ambiguous");
  assert.equal(resolution.session, null);
  assert.equal(resolution.matches.length, 2);
  assert.equal(bridge.isProjectActive("brain")?.sessionId, "newer");
}));

test("VscBridge polls session end events once and clears the event file", () => withTempCwd((rootDir) => {
  const bridge = createBridge();
  const bridgeDir = path.join(rootDir, "data", "bridge");
  mkdirSync(bridgeDir, { recursive: true });
  const eventPath = path.join(bridgeDir, "session-end-events.jsonl");
  writeFileSync(eventPath, [
    JSON.stringify({
      id: "evt_1",
      sessionId: "sid_1",
      cwd: "C:/Projects/Brain",
      projectName: "brain",
      endedAt: "2026-06-15T00:00:00.000Z",
    }),
    "not-json",
    JSON.stringify({ id: "bad" }),
    "",
  ].join("\n"), "utf-8");

  const events = bridge.pollSessionEndEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].sessionId, "sid_1");
  assert.equal(readFileSync(eventPath, "utf-8"), "");
  assert.deepEqual(bridge.pollSessionEndEvents(), []);
}));

test("VscBridge safe sessions reject stale individual session records", () => withTempCwd((rootDir) => {
  const bridge = createBridge();
  writeActiveSnapshot(rootDir, {
    updatedAt: "2026-06-23T12:00:00.000Z",
    sessions: [
      {
        ...session("old", "oldproject", 111),
        startedAt: "2026-06-20T00:00:00.000Z",
        lastActivity: "2026-06-20T00:00:00.000Z",
      },
      {
        ...session("fresh", "sentinel", 222),
        startedAt: "2026-06-23T11:55:00.000Z",
      },
    ],
  });

  const safeSessions = bridge.getSafeActiveSessions({
    now: new Date("2026-06-23T12:00:00.000Z"),
    ttlMs: 10 * 60 * 1000,
    sessionTtlMs: 24 * 60 * 60 * 1000,
    isProcessAlive: () => true,
  });

  assert.deepEqual(safeSessions.map((item) => item.projectName), ["sentinel"]);
}));

test("VscBridge can create launched tasks for externally started PC sessions", () => withTempCwd(() => {
  const bridge = createBridge();
  const taskId = bridge.createTask({
    sourceChatId: 64445716,
    sourceMessageId: 123,
    targetCwd: "D:/Projects/Sentinel",
    instruction: "설계서 작성",
    initialStatus: "launched",
  });

  const task = bridge.getTask(taskId);
  assert.equal(task?.status, "launched");
  assert.equal(task?.targetCwd, "D:/Projects/Sentinel");
  assert.match(task?.resultFile ?? "", /task-results/);
}));
