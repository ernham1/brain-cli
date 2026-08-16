import type { DelegatedTask, DelegatedTaskStore } from "./delegated-task-store.js";

interface TelegramMessenger {
  sendMessage(chatId: number, text: string): Promise<unknown>;
}

export interface DelegatedTaskPollerOptions {
  store: DelegatedTaskStore;
  messenger: TelegramMessenger;
  intervalMs: number;
  staleAfterMs: number;
  isTaskActive: (task: DelegatedTask) => boolean;
}

export class DelegatedTaskPoller {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(private readonly options: DelegatedTaskPollerOptions) {}

  start(): void {
    if (this.timer) return;
    const intervalMs = Math.max(5000, this.options.intervalMs);
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        console.error("[DelegatedTaskPoller] tick 실패:", error instanceof Error ? error.message : String(error));
      });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const task of this.options.store.listRunning()) {
        this.inspectTask(task);
      }
    } finally {
      this.running = false;
    }
  }

  private inspectTask(task: DelegatedTask): void {
    const now = Date.now();
    const updatedAt = Date.parse(task.updatedAt);
    const lastNotifiedAt = task.lastNotifiedAt ? Date.parse(task.lastNotifiedAt) : 0;
    const isActive = this.options.isTaskActive(task);

    if (!isActive && Number.isFinite(updatedAt) && now - updatedAt > this.options.staleAfterMs) {
      this.options.store.markStale(task.taskId);
      console.log(`[DelegatedTaskPoller] stale 내부 처리: ${task.taskId}`);
      return;
    }

    if (!isActive) return;
    if (lastNotifiedAt && now - lastNotifiedAt < this.options.intervalMs) return;

    console.log(`[DelegatedTaskPoller] running 내부 처리: ${task.taskId} (${formatElapsed(now - Date.parse(task.startedAt))})`);
    this.options.store.markNotified(task.taskId);
  }
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "알 수 없음";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}초`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}분` : `${minutes}분 ${seconds}초`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0 ? `${hours}시간` : `${hours}시간 ${remMinutes}분`;
}
