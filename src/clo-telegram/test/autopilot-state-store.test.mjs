import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AutopilotStateStore } from "../dist/autopilot/autopilot-state-store.js";

test("AutopilotStateStore persists pending actions", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-autopilot-state-"));
  try {
    const filePath = path.join(dir, "state.json");
    const store = new AutopilotStateStore(filePath);
    const pending = store.createPendingAction({
      chatId: 123,
      userId: 456,
      intent: "privacy_policy_change",
      text: "이 방에서는 내 개인 기억 써도 돼",
      entities: { action: "enable" },
    });

    const reloaded = new AutopilotStateStore(filePath);
    const list = reloaded.listPending(123);
    assert.equal(list.length, 1);
    assert.equal(list[0].pendingActionId, pending.pendingActionId);
    assert.equal(list[0].intent, "privacy_policy_change");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AutopilotStateStore persists chat memory policy", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-autopilot-state-"));
  try {
    const filePath = path.join(dir, "state.json");
    const store = new AutopilotStateStore(filePath);
    store.setChatMemoryPolicy({ chatId: 123, allowPersonalMemory: true, updatedBy: 456 });

    const reloaded = new AutopilotStateStore(filePath);
    assert.equal(reloaded.getChatMemoryPolicy(123)?.allowPersonalMemory, true);
    assert.equal(reloaded.getChatMemoryPolicy(123)?.updatedBy, 456);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AutopilotStateStore marks pending action status", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-autopilot-state-"));
  try {
    const filePath = path.join(dir, "state.json");
    const store = new AutopilotStateStore(filePath);
    const pending = store.createPendingAction({
      chatId: 123,
      intent: "privacy_policy_change",
      text: "이 방에서는 내 개인 기억 써도 돼",
      entities: { action: "enable" },
    });

    store.markPendingAction(pending.pendingActionId, "applied");

    const reloaded = new AutopilotStateStore(filePath);
    assert.equal(reloaded.getPendingAction(pending.pendingActionId)?.status, "applied");
    assert.equal(reloaded.listPending(123).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
