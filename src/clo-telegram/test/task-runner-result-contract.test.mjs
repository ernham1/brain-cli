import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskRunner } from "../dist/task-runner.js";

function createTaskFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-task-runner-contract-"));
  const bridgeDir = path.join(dir, "bridge");
  const tasksDir = path.join(bridgeDir, "tasks");
  const taskResultsDir = path.join(bridgeDir, "task-results");
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(taskResultsDir, { recursive: true });

  const task = {
    taskId: "task_contract",
    sourceChatId: 123,
    sourceMessageId: 456,
    targetCwd: dir,
    instruction: "결과 파일 계약 테스트",
    status: "pending",
    expiresAt: "2099-01-01T00:00:00.000Z",
    resultFile: path.join(taskResultsDir, "task_contract.json"),
  };
  const taskFilePath = path.join(tasksDir, `${task.taskId}.json`);
  writeFileSync(taskFilePath, JSON.stringify(task, null, 2), "utf-8");
  return { dir, bridgeDir, task, taskFilePath };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

test("TaskRunner writes fallback result when successful worker omits result file", async () => {
  const fixture = createTaskFixture();
  try {
    const runner = new TaskRunner(fixture.bridgeDir, { taskChat: async () => {} });

    await runner.executeTask(fixture.task, fixture.taskFilePath);

    assert.equal(existsSync(fixture.task.resultFile), true);
    const result = readJson(fixture.task.resultFile);
    assert.equal(result.status, "completed");
    assert.match(result.result, /TaskRunner fallback/);

    const savedTask = readJson(fixture.taskFilePath);
    assert.equal(savedTask.status, "completed");
    assert.equal(savedTask.completedAt, result.completedAt);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("TaskRunner marks task failed when worker result schema is invalid", async () => {
  const fixture = createTaskFixture();
  try {
    const runner = new TaskRunner(fixture.bridgeDir, {
      taskChat: async (task) => {
        mkdirSync(path.dirname(task.resultFile), { recursive: true });
        writeFileSync(task.resultFile, JSON.stringify({ taskId: task.taskId }), "utf-8");
      },
    });

    await runner.executeTask(fixture.task, fixture.taskFilePath);

    const result = readJson(fixture.task.resultFile);
    assert.equal(result.status, "failed");
    assert.match(result.result, /schema invalid/);

    const savedTask = readJson(fixture.taskFilePath);
    assert.equal(savedTask.status, "failed");
    assert.equal(savedTask.completedAt, result.completedAt);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("TaskRunner does not rewrite fallback when poller already consumed the result (restart dedupe)", async () => {
  const fixture = createTaskFixture();
  try {
    const runner = new TaskRunner(fixture.bridgeDir, {
      taskChat: async (task) => {
        // 워커가 정상 결과를 썼고, 실행 중에 스케줄러 폴러가 소비해 간 상황을 재현:
        // 결과 파일은 삭제되고 task 파일 status는 completed로 갱신되어 있다.
        const saved = readJson(fixture.taskFilePath);
        saved.status = "completed";
        saved.completedAt = new Date().toISOString();
        writeFileSync(fixture.taskFilePath, JSON.stringify(saved, null, 2), "utf-8");
        rmSync(task.resultFile, { force: true });
      },
    });

    await runner.executeTask(fixture.task, fixture.taskFilePath);

    // 핵심: 폴백 결과 파일을 다시 쓰지 않는다 (재시작 시 중복 재처리의 원인 제거)
    assert.equal(existsSync(fixture.task.resultFile), false);
    const savedTask = readJson(fixture.taskFilePath);
    assert.equal(savedTask.status, "completed");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
