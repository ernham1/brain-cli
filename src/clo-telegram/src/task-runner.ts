import fs from "node:fs";
import path from "node:path";
import type { CloAgent } from "./agent.js";
import type { TaskResult } from "./bridge.js";

interface Task {
  taskId: string;
  sourceChatId: number;
  sourceMessageId: number;
  targetCwd: string;
  instruction: string;
  status: string;
  expiresAt: string;
  resultFile: string;
}

export class TaskRunner {
  private running = new Set<string>();
  private tasksDir: string;

  constructor(
    bridgeDir: string,
    private agent: CloAgent,
  ) {
    this.tasksDir = path.join(bridgeDir, "tasks");
  }

  /** pending task 스캔 후 agent로 실행. 모바일에는 raw 진행/완료 알림을 보내지 않는다. */
  async runPendingTasks(): Promise<void> {
    if (!fs.existsSync(this.tasksDir)) return;

    const now = new Date();
    const files = fs.readdirSync(this.tasksDir).filter((f) => f.endsWith(".json"));

    for (const file of files) {
      const filePath = path.join(this.tasksDir, file);
      let task: Task;
      try {
        task = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch {
        continue;
      }

      if (task.status !== "pending") continue;
      if (this.running.has(task.taskId)) continue;
      if (task.expiresAt && new Date(task.expiresAt) < now) continue;

      this.running.add(task.taskId);
      this.executeTask(task, filePath).catch((err) => {
        console.error(`[TaskRunner] 실행 오류 (${task.taskId}):`, err);
        this.running.delete(task.taskId);
      });
    }
  }

  private async executeTask(task: Task, taskFilePath: string): Promise<void> {
    console.log(`[TaskRunner] 시작: ${task.taskId} — ${task.instruction}`);

    try {
      const t = JSON.parse(fs.readFileSync(taskFilePath, "utf-8"));
      t.status = "running";
      t.startedAt = new Date().toISOString();
      fs.writeFileSync(taskFilePath, JSON.stringify(t, null, 2), "utf-8");
    } catch { /* 무시 */ }

    const startedAt = Date.now();

    try {
      await this.agent.taskChat(task);
      const result = this.ensureSuccessResultContract(task, taskFilePath);
      console.log(`[TaskRunner] 완료: ${task.taskId}`);

      const elapsed = Math.round((Date.now() - startedAt) / 60000);

      if (result.status === "failed") {
        console.log(`[TaskRunner] 결과 계약 실패 (${elapsed}분): ${task.taskId} — ${result.result.slice(0, 100)}`);
        this.updateTaskStatus(taskFilePath, "failed", result.completedAt);
        return;
      }

      console.log(`[TaskRunner] 결과 계약 완료 (${elapsed}분): ${task.taskId}`);
      this.updateTaskStatus(taskFilePath, "completed", result.completedAt);
    } catch (err) {
      console.error(`[TaskRunner] 실패: ${task.taskId}`, err);

      const elapsed = Math.round((Date.now() - startedAt) / 60000);
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`[TaskRunner] 작업 실패 내부 처리 (${elapsed}분): ${task.taskId} — ${errMsg.slice(0, 100)}`);

      try {
        this.writeTaskResult(task, "failed", `실행 실패: ${errMsg}`);
      } catch { /* 무시 */ }

      this.updateTaskStatus(taskFilePath, "failed", new Date().toISOString());
    } finally {
      this.running.delete(task.taskId);
    }
  }

  private ensureSuccessResultContract(task: Task, taskFilePath: string): TaskResult {
    if (!fs.existsSync(task.resultFile)) {
      // 결과 파일 부재의 두 가지 원인 구분:
      // (a) 워커가 안 씀 → 폴백 작성. (b) 스케줄러 폴러가 실행 중에 이미 소비·삭제함
      //     → 폴백을 다시 쓰면 안 됨 (재시작 시 stale 파일로 중복 재처리되는 원인).
      //     폴러는 소비 시 task 파일 status를 completed/failed로 갱신하므로 그걸로 판별한다.
      try {
        const saved = JSON.parse(fs.readFileSync(taskFilePath, "utf-8")) as Partial<Task> & { completedAt?: string };
        if (saved.status === "completed" || saved.status === "failed") {
          console.log(`[TaskRunner] 결과는 폴러가 이미 소비함 · 폴백 미작성: ${task.taskId}`);
          return {
            taskId: task.taskId,
            sourceChatId: task.sourceChatId,
            sourceMessageId: task.sourceMessageId,
            status: saved.status,
            result: "결과는 브릿지 폴러가 이미 소비함 (폴백 미작성)",
            completedAt: saved.completedAt ?? new Date().toISOString(),
          };
        }
      } catch { /* task 파일 확인 실패 시 기존 폴백 경로 */ }
      return this.writeTaskResult(
        task,
        "completed",
        "worker가 result file을 쓰지 않아 TaskRunner fallback으로 작성했습니다.",
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(task.resultFile, "utf-8"));
    } catch {
      return this.writeTaskResult(task, "failed", "worker result file schema invalid: JSON parse failed");
    }

    const invalidReason = validateTaskResult(parsed, task);
    if (invalidReason) {
      return this.writeTaskResult(task, "failed", `worker result file schema invalid: ${invalidReason}`);
    }

    return parsed as TaskResult;
  }

  private writeTaskResult(task: Task, status: TaskResult["status"], resultText: string): TaskResult {
    const result: TaskResult = {
      taskId: task.taskId,
      sourceChatId: task.sourceChatId,
      sourceMessageId: task.sourceMessageId,
      status,
      result: resultText,
      completedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(task.resultFile), { recursive: true });
    fs.writeFileSync(task.resultFile, JSON.stringify(result, null, 2), "utf-8");
    return result;
  }

  private updateTaskStatus(taskFilePath: string, status: TaskResult["status"], completedAt: string): void {
    try {
      const task = JSON.parse(fs.readFileSync(taskFilePath, "utf-8"));
      task.status = status;
      task.completedAt = completedAt;
      fs.writeFileSync(taskFilePath, JSON.stringify(task, null, 2), "utf-8");
    } catch { /* 무시 */ }
  }
}

function validateTaskResult(value: unknown, task: Task): string | null {
  const result = value as Partial<TaskResult>;
  if (result.taskId !== task.taskId) return "taskId mismatch";
  if (result.sourceChatId !== task.sourceChatId) return "sourceChatId mismatch";
  if (result.sourceMessageId !== task.sourceMessageId) return "sourceMessageId mismatch";
  if (result.status !== "completed" && result.status !== "failed") return "status missing or invalid";
  if (typeof result.result !== "string" || result.result.trim().length === 0) return "result missing";
  if (typeof result.completedAt !== "string" || Number.isNaN(Date.parse(result.completedAt))) {
    return "completedAt missing or invalid";
  }
  return null;
}
