import fs from "node:fs";
import path from "node:path";

export type DelegatedTaskStatus = "running" | "completed" | "reviewed" | "failed" | "cancelled" | "stale";
export type DelegatedTaskBackend = "bandingai" | "local";

export interface DelegatedTask {
  taskId: string;
  chatId: number;
  userId?: number;
  title: string;
  why: string;
  backend: DelegatedTaskBackend;
  status: DelegatedTaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  completedAt?: string;
  currentStep?: string;
  milestones: string[];
  findings: string[];
  progressLog: string[];
  resultPreview?: string;
  error?: string;
  lastNotifiedAt?: string;
  notificationCount: number;
}

export interface CreateDelegatedTaskInput {
  taskId: string;
  chatId: number;
  userId?: number;
  title: string;
  why: string;
  backend: DelegatedTaskBackend;
  startedAt?: string;
}

export class DelegatedTaskStore {
  constructor(private readonly filePath: string) {}

  create(input: CreateDelegatedTaskInput): DelegatedTask {
    const now = new Date().toISOString();
    const task: DelegatedTask = {
      taskId: input.taskId,
      chatId: input.chatId,
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      title: input.title,
      why: input.why,
      backend: input.backend,
      status: "running",
      createdAt: now,
      updatedAt: now,
      startedAt: input.startedAt ?? now,
      milestones: [],
      findings: [],
      progressLog: [],
      notificationCount: 0,
    };
    const tasks = this.loadAll().filter((t) => t.taskId !== task.taskId);
    tasks.push(task);
    this.saveAll(tasks);
    return task;
  }

  get(taskId: string): DelegatedTask | undefined {
    return this.loadAll().find((task) => task.taskId === taskId);
  }

  listAll(): DelegatedTask[] {
    return this.loadAll().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listByChat(chatId: number, limit = 5): DelegatedTask[] {
    return this.listAll().filter((task) => task.chatId === chatId).slice(0, limit);
  }

  listRunning(): DelegatedTask[] {
    return this.listAll().filter((task) => task.status === "running");
  }

  update(taskId: string, patch: Partial<Omit<DelegatedTask, "taskId" | "createdAt">>): DelegatedTask | undefined {
    const tasks = this.loadAll();
    const index = tasks.findIndex((task) => task.taskId === taskId);
    if (index < 0) return undefined;
    const updated: DelegatedTask = {
      ...tasks[index],
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    tasks[index] = updated;
    this.saveAll(tasks);
    return updated;
  }

  appendProgress(taskId: string, input: { kind: "milestone" | "finding" | "step" | "log"; message: string }): DelegatedTask | undefined {
    const task = this.get(taskId);
    if (!task) return undefined;
    const progressLog = [...task.progressLog, `[${input.kind}] ${input.message}`].slice(-20);
    const patch: Partial<DelegatedTask> = { progressLog };
    if (input.kind === "milestone") patch.milestones = [...task.milestones, input.message].slice(-20);
    if (input.kind === "finding") patch.findings = [...task.findings, input.message].slice(-20);
    if (input.kind === "step") patch.currentStep = input.message;
    return this.update(taskId, patch);
  }

  markNotified(taskId: string): DelegatedTask | undefined {
    const task = this.get(taskId);
    if (!task) return undefined;
    return this.update(taskId, {
      lastNotifiedAt: new Date().toISOString(),
      notificationCount: task.notificationCount + 1,
    });
  }

  markCompleted(taskId: string, resultPreview: string): DelegatedTask | undefined {
    return this.update(taskId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      resultPreview: resultPreview.slice(0, 1200),
    });
  }

  markReviewed(taskId: string): DelegatedTask | undefined {
    return this.update(taskId, { status: "reviewed" });
  }

  markFailed(taskId: string, error: string, resultPreview?: string): DelegatedTask | undefined {
    return this.update(taskId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: error.slice(0, 1200),
      ...(resultPreview ? { resultPreview: resultPreview.slice(0, 1200) } : {}),
    });
  }

  markCancelled(taskId: string): DelegatedTask | undefined {
    return this.update(taskId, {
      status: "cancelled",
      completedAt: new Date().toISOString(),
    });
  }

  markStale(taskId: string): DelegatedTask | undefined {
    return this.update(taskId, {
      status: "stale",
      completedAt: new Date().toISOString(),
      error: "봇 재시작 또는 프로세스 종료로 실행 중 워커를 찾을 수 없습니다.",
    });
  }

  private loadAll(): DelegatedTask[] {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isDelegatedTask);
    } catch {
      return [];
    }
  }

  private saveAll(tasks: DelegatedTask[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(tasks, null, 2), "utf-8");
    replaceFileWithRetry(tmpPath, this.filePath);
  }
}

function replaceFileWithRetry(tmpPath: string, targetPath: string): void {
  const delaysMs = [20, 50, 100, 200, 400, 800];
  let lastError: unknown;

  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      fs.renameSync(tmpPath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableFileError(error) || attempt >= delaysMs.length) break;
      sleepSync(delaysMs[attempt]);
    }
  }

  try {
    fs.copyFileSync(tmpPath, targetPath);
    fs.unlinkSync(tmpPath);
    return;
  } catch (fallbackError) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup failure */ }
    throw fallbackError instanceof Error
      ? fallbackError
      : lastError instanceof Error
        ? lastError
        : new Error(String(fallbackError));
  }
}

function isRetryableFileError(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function isDelegatedTask(value: unknown): value is DelegatedTask {
  const task = value as Partial<DelegatedTask>;
  return typeof task.taskId === "string"
    && typeof task.chatId === "number"
    && typeof task.title === "string"
    && typeof task.why === "string"
    && typeof task.backend === "string"
    && typeof task.status === "string"
    && typeof task.createdAt === "string"
    && typeof task.updatedAt === "string"
    && typeof task.startedAt === "string"
    && Array.isArray(task.milestones)
    && Array.isArray(task.findings)
    && Array.isArray(task.progressLog)
    && typeof task.notificationCount === "number";
}

