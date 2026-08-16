import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const botSource = readFileSync(new URL("../src/bot.ts", import.meta.url), "utf-8");
const pollerSource = readFileSync(new URL("../src/delegated-task-poller.ts", import.meta.url), "utf-8");

test("bot wires delegated task store and poller into worker flow", () => {
  for (const expected of [
    "new DelegatedTaskStore",
    "new DelegatedTaskPoller",
    "delegatedTaskStore.create",
    "delegatedTaskStore.appendProgress",
    "delegatedTaskStore.markCompleted",
    "delegatedTaskStore.markReviewed",
    "delegatedTaskStore.markFailed",
    "delegatedTaskStore.markCancelled",
    "bot.command([\"tasks\", \"작업\", \"워커\"]",
  ]) {
    assert.match(botSource, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("poller records stale/running tasks internally without progress notifications", () => {
  for (const expected of [
    "markStale",
    "markNotified",
    "isTaskActive",
    "running 내부 처리",
    "stale 내부 처리",
  ]) {
    assert.match(pollerSource, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(pollerSource, /messenger\.sendMessage/);
  assert.doesNotMatch(pollerSource, /진행 중\.\.\./);
  assert.doesNotMatch(pollerSource, /작업 연결이 끊긴 것으로 보입니다/);
});
