import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BotScheduler, ReminderStore } from "../dist/scheduler.js";

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

function makeTelegramTimeoutError() {
  const inner = new Error("request to https://api.telegram.org/bot123:SECRET/sendMessage failed");
  inner.code = "ETIMEDOUT";
  const outer = new Error("Network request for 'sendMessage' failed!");
  outer.error = inner;
  return outer;
}

test("failed reminder delivery backs off without invoking the agent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clo-reminder-backoff-"));
  try {
    const store = new ReminderStore(root);
    store.add({
      id: "rem_network_down",
      chatId: 64445716,
      datetime: new Date(Date.now() - 60_000).toISOString(),
      description: "테스트 리마인더",
      repeat: null,
      notified: false,
    });

    let sendCount = 0;
    const bot = {
      api: {
        sendMessage: async () => {
          sendCount += 1;
          throw makeTelegramTimeoutError();
        },
      },
    };

    let reminderChatCount = 0;
    const agent = {
      reminderChat: async () => {
        reminderChatCount += 1;
        return "LLM 리마인더";
      },
    };

    const scheduler = new BotScheduler(bot, createConfig(root), store);
    scheduler.setAgent(agent);

    await scheduler.checkReminders(new Date());
    await scheduler.checkReminders(new Date());

    assert.equal(reminderChatCount, 0);
    assert.equal(sendCount, 1);
    assert.equal(store.list(64445716)[0].notified, false);
    assert.match(store.list(64445716)[0].retryAfter, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(store.list(64445716)[0].failureCount, 1);

    const restartedScheduler = new BotScheduler(bot, createConfig(root), new ReminderStore(root));
    restartedScheduler.setAgent(agent);
    await restartedScheduler.checkReminders(new Date());

    assert.equal(reminderChatCount, 0);
    assert.equal(sendCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed repeating reminder advances to next occurrence instead of retrying", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clo-repeat-reminder-fail-"));
  try {
    const store = new ReminderStore(root);
    const originalDate = new Date(Date.now() - 60_000);
    store.add({
      id: "rem_daily_network_down",
      chatId: 64445716,
      datetime: originalDate.toISOString(),
      description: "매일 정리",
      repeat: "daily",
      notified: false,
    });

    let sendCount = 0;
    const bot = {
      api: {
        sendMessage: async () => {
          sendCount += 1;
          throw makeTelegramTimeoutError();
        },
      },
    };

    let reminderChatCount = 0;
    const agent = {
      reminderChat: async () => {
        reminderChatCount += 1;
        return "LLM 리마인더";
      },
    };

    const scheduler = new BotScheduler(bot, createConfig(root), store);
    scheduler.setAgent(agent);

    await scheduler.checkReminders(new Date());

    const reminder = store.list(64445716)[0];
    assert.equal(reminderChatCount, 0);
    assert.equal(sendCount, 1);
    assert.equal(reminder.repeat, "daily");
    assert.equal(reminder.notified, false);
    assert.equal(reminder.retryAfter, undefined);
    assert.equal(reminder.failureCount, undefined);
    assert.ok(new Date(reminder.datetime).getTime() > Date.now() + 23 * 60 * 60_000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
