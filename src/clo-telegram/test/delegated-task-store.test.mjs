import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DelegatedTaskStore } from "../dist/delegated-task-store.js";

test("DelegatedTaskStore persists task state across instances", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-delegated-task-"));
  try {
    const filePath = path.join(dir, "tasks.json");
    const store = new DelegatedTaskStore(filePath);

    store.create({
      taskId: "worker_1",
      chatId: 123,
      userId: 456,
      title: "BandingAI 리서치",
      why: "긴 리서치",
      backend: "bandingai",
      startedAt: "2026-05-13T00:00:00.000Z",
    });
    store.appendProgress("worker_1", { kind: "step", message: "자료 수집" });
    store.appendProgress("worker_1", { kind: "finding", message: "중요한 발견" });
    store.markCompleted("worker_1", "완료 결과");

    const reloaded = new DelegatedTaskStore(filePath);
    const task = reloaded.get("worker_1");

    assert.equal(task?.status, "completed");
    assert.equal(task?.currentStep, "자료 수집");
    assert.deepEqual(task?.findings, ["중요한 발견"]);
    assert.equal(task?.resultPreview, "완료 결과");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DelegatedTaskStore records cancellation and stale states", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-delegated-task-"));
  try {
    const filePath = path.join(dir, "tasks.json");
    const store = new DelegatedTaskStore(filePath);

    store.create({
      taskId: "worker_cancel",
      chatId: 123,
      title: "취소 테스트",
      why: "테스트",
      backend: "bandingai",
    });
    store.markCancelled("worker_cancel");
    assert.equal(store.get("worker_cancel")?.status, "cancelled");

    store.create({
      taskId: "worker_stale",
      chatId: 123,
      title: "고아 테스트",
      why: "테스트",
      backend: "bandingai",
    });
    store.markStale("worker_stale");
    assert.equal(store.get("worker_stale")?.status, "stale");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DelegatedTaskStore keeps failed worker output for diagnosis", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-delegated-task-"));
  try {
    const filePath = path.join(dir, "tasks.json");
    const store = new DelegatedTaskStore(filePath);
    store.create({
      taskId: "worker_failed",
      chatId: 123,
      title: "실패 결과 보존",
      why: "검증",
      backend: "bandingai",
    });

    store.markFailed("worker_failed", "완료 증거 없음", "산출물 0개, 미완료");

    const task = store.get("worker_failed");
    assert.equal(task?.status, "failed");
    assert.equal(task?.error, "완료 증거 없음");
    assert.equal(task?.resultPreview, "산출물 0개, 미완료");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("DelegatedTaskStore retries transient EPERM rename failures", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-delegated-task-"));
  const originalRenameSync = fs.renameSync;
  let renameCalls = 0;
  try {
    fs.renameSync = (oldPath, newPath) => {
      renameCalls++;
      if (renameCalls === 1) {
        const error = new Error("transient lock");
        error.code = "EPERM";
        throw error;
      }
      return originalRenameSync(oldPath, newPath);
    };

    const filePath = path.join(dir, "tasks.json");
    const store = new DelegatedTaskStore(filePath);
    store.create({
      taskId: "worker_retry",
      chatId: 123,
      title: "재시도 테스트",
      why: "Windows rename 잠금 재현",
      backend: "bandingai",
    });

    assert.equal(store.get("worker_retry")?.status, "running");
    assert.equal(renameCalls, 2);
  } finally {
    fs.renameSync = originalRenameSync;
    rmSync(dir, { recursive: true, force: true });
  }
});

