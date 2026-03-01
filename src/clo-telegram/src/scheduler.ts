import * as fs from "node:fs";
import * as path from "node:path";
import type { Bot } from "grammy";
import type { Config } from "./config.js";
import { executeRecall } from "./tools.js";

// --- 리마인더 타입 ---

export interface Reminder {
  id: string;
  chatId: number;
  datetime: string; // ISO 8601 (KST offset 포함)
  description: string;
  repeat: "daily" | "weekly" | null;
  notified: boolean;
}

// --- ReminderStore ---

export class ReminderStore {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "reminders.json");
    this.ensureFile();
  }

  private ensureFile(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "[]", "utf-8");
    }
  }

  private readAll(): Reminder[] {
    const raw = fs.readFileSync(this.filePath, "utf-8");
    return JSON.parse(raw);
  }

  private writeAll(reminders: Reminder[]): void {
    fs.writeFileSync(this.filePath, JSON.stringify(reminders, null, 2), "utf-8");
  }

  add(reminder: Reminder): void {
    const reminders = this.readAll();
    reminders.push(reminder);
    this.writeAll(reminders);
  }

  getDue(now: Date): Reminder[] {
    const reminders = this.readAll();
    return reminders.filter(
      (r) => !r.notified && new Date(r.datetime) <= now,
    );
  }

  markNotified(id: string): void {
    const reminders = this.readAll();
    const idx = reminders.findIndex((r) => r.id === id);
    if (idx === -1) return;

    const reminder = reminders[idx];
    if (reminder.repeat) {
      // 반복 리마인더: 다음 날짜로 갱신
      const next = new Date(reminder.datetime);
      if (reminder.repeat === "daily") {
        next.setDate(next.getDate() + 1);
      } else if (reminder.repeat === "weekly") {
        next.setDate(next.getDate() + 7);
      }
      reminders[idx] = { ...reminder, datetime: next.toISOString() };
    } else {
      reminders[idx] = { ...reminder, notified: true };
    }
    this.writeAll(reminders);
  }

  list(chatId: number): Reminder[] {
    return this.readAll().filter((r) => r.chatId === chatId && !r.notified);
  }

  cancel(id: string): boolean {
    const reminders = this.readAll();
    const idx = reminders.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    reminders.splice(idx, 1);
    this.writeAll(reminders);
    return true;
  }
}

// --- KST 시간 유틸 ---

function getNowKST(): Date {
  // KST = UTC+9
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 9 * 3600000);
}

function getKSTHourMinute(): { hour: number; minute: number } {
  const kst = getNowKST();
  return { hour: kst.getHours(), minute: kst.getMinutes() };
}

// --- BotScheduler ---

export class BotScheduler {
  private bot: Bot;
  private config: Config;
  private reminderStore: ReminderStore;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private briefingSentToday = false;
  private lastCheckedDate = "";

  constructor(bot: Bot, config: Config, reminderStore: ReminderStore) {
    this.bot = bot;
    this.config = config;
    this.reminderStore = reminderStore;
  }

  start(): void {
    console.log("[Clo] 스케줄러 시작");

    this.intervalId = setInterval(() => {
      this.tick().catch((err) => {
        console.error("[Clo] 스케줄러 오류:", err);
      });
    }, 60_000);

    // 시작 직후 1회 즉시 체크
    this.tick().catch((err) => {
      console.error("[Clo] 스케줄러 초기 체크 오류:", err);
    });
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[Clo] 스케줄러 종료");
    }
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const { hour, minute } = getKSTHourMinute();
    const todayKey = getNowKST().toISOString().slice(0, 10);

    // 날짜가 바뀌면 브리핑 플래그 리셋
    if (todayKey !== this.lastCheckedDate) {
      this.briefingSentToday = false;
      this.lastCheckedDate = todayKey;
    }

    // 1) 리마인더 체크
    await this.checkReminders(now);

    // 2) 일일 브리핑 체크
    if (
      this.config.briefingEnabled &&
      !this.briefingSentToday &&
      hour === this.config.briefingHour &&
      minute === 0
    ) {
      await this.sendDailyBriefing();
      this.briefingSentToday = true;
    }
  }

  private async checkReminders(now: Date): Promise<void> {
    const dueReminders = this.reminderStore.getDue(now);

    for (const reminder of dueReminders) {
      const sent = await this.sendReminder(reminder);
      if (sent) {
        this.reminderStore.markNotified(reminder.id);
      }
    }
  }

  private async sendReminder(reminder: Reminder): Promise<boolean> {
    const repeatLabel = reminder.repeat
      ? ` (${reminder.repeat === "daily" ? "매일 반복" : "매주 반복"})`
      : "";
    const message = `⏰ 이사님, 리마인더 알림이에요!\n\n📌 ${reminder.description}${repeatLabel}`;

    try {
      await this.bot.api.sendMessage(reminder.chatId, message);
      console.log(`[Clo] 리마인더 발송: ${reminder.id}`);
      return true;
    } catch (err) {
      console.error(`[Clo] 리마인더 발송 실패 (${reminder.id}):`, err);
      return false;
    }
  }

  private async sendDailyBriefing(): Promise<void> {
    for (const chatId of this.config.ownerChatIds) {
      try {
        // Brain에서 프로젝트 상태/일정 검색
        const brainInfo = executeRecall(
          { goal: "프로젝트 상태 일정 오늘 할일" },
          this.config.brainRoot,
        );

        // 오늘의 리마인더 목록
        const todayReminders = this.reminderStore.list(chatId);
        const kstNow = getNowKST();
        const todayStr = `${kstNow.getFullYear()}-${String(kstNow.getMonth() + 1).padStart(2, "0")}-${String(kstNow.getDate()).padStart(2, "0")}`;

        const todayItems = todayReminders.filter((r) =>
          r.datetime.startsWith(todayStr),
        );

        // 브리핑 메시지 구성
        let briefing = `☀️ 좋은 아침이에요, 이사님!\n\n📋 오늘의 브리핑 (${todayStr})`;

        if (todayItems.length > 0) {
          briefing += "\n\n⏰ 오늘 리마인더:";
          for (const r of todayItems) {
            const time = new Date(r.datetime)
              .toLocaleTimeString("ko-KR", {
                timeZone: "Asia/Seoul",
                hour: "2-digit",
                minute: "2-digit",
              });
            briefing += `\n  • ${time} — ${r.description}`;
          }
        }

        if (brainInfo && brainInfo !== "관련 기억 없음") {
          briefing += `\n\n📊 프로젝트 현황:\n${brainInfo}`;
        }

        briefing += "\n\n오늘도 화이팅이에요! 💪";

        await this.bot.api.sendMessage(chatId, briefing);
        console.log(`[Clo] 일일 브리핑 발송: chatId=${chatId}`);
      } catch (err) {
        console.error(`[Clo] 브리핑 발송 실패 (chatId=${chatId}):`, err);
      }
    }
  }
}
