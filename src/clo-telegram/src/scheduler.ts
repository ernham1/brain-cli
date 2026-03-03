import * as fs from "node:fs";
import * as path from "node:path";
import type { Bot } from "grammy";
import type { Config } from "./config.js";
import { executeRecall } from "./tools.js";
import { ProactiveEngine, fetchWeather } from "./proactive.js";
import { SessionManager } from "./session.js";
import type { CloAgent } from "./agent.js";
import type { VscBridge } from "./bridge.js";

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
  private proactiveEngine: ProactiveEngine | null = null;
  private agent: CloAgent | null = null;
  private vscBridge: VscBridge | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private briefingSentToday = false;
  private reportSentToday = false;
  private lastCheckedDate = "";
  private sendingReminders = new Set<string>(); // 중복 발송 방지
  private sessionManager: SessionManager;

  constructor(bot: Bot, config: Config, reminderStore: ReminderStore) {
    this.bot = bot;
    this.config = config;
    this.reminderStore = reminderStore;
    this.sessionManager = new SessionManager(config.sessionDir);

    // Proactive 엔진 초기화
    if (config.proactiveEnabled && config.ownerChatIds.length > 0) {
      this.proactiveEngine = new ProactiveEngine(
        {
          enabled: config.proactiveEnabled,
          maxDailyMessages: config.proactiveMaxDaily,
          minIntervalMinutes: config.proactiveMinInterval,
          activeHoursStart: 8,
          activeHoursEnd: 22,
          ownerChatId: config.ownerChatIds[0],
          groupChatId: config.proactiveGroupChatId,
        },
        config.sessionDir,
      );
    }
  }

  /** CloAgent 참조 주입 (proactive 메시지 생성에 필요) */
  setAgent(agent: CloAgent): void {
    this.agent = agent;
  }

  /** VscBridge 참조 주입 (만료 파일 정리용) */
  setVscBridge(bridge: VscBridge): void {
    this.vscBridge = bridge;
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

    // 날짜가 바뀌면 브리핑/리포트 플래그 리셋
    if (todayKey !== this.lastCheckedDate) {
      this.briefingSentToday = false;
      this.reportSentToday = false;
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

    // 3) GitHub/npm 일일 리포트
    if (
      this.config.githubReportEnabled &&
      !this.reportSentToday &&
      hour === this.config.githubReportHour &&
      minute === 0
    ) {
      await this.sendDailyReport();
      this.reportSentToday = true;
    }

    // 4) Proactive 메시지 체크 (5분 간격)
    if (this.proactiveEngine && this.agent && minute % 5 === 0) {
      await this.checkProactive(hour, minute);
    }

    // 5) VS Code 브릿지 만료 파일 정리 (5분 간격)
    if (this.vscBridge && minute % 5 === 0) {
      this.vscBridge.cleanupExpired();
    }
  }

  private async checkReminders(now: Date): Promise<void> {
    const dueReminders = this.reminderStore.getDue(now);

    for (const reminder of dueReminders) {
      // 이미 발송 중인 리마인더는 건너뛰기 (비동기 레이스 방지)
      if (this.sendingReminders.has(reminder.id)) continue;
      this.sendingReminders.add(reminder.id);

      try {
        const sent = await this.sendReminder(reminder);
        if (sent) {
          this.reminderStore.markNotified(reminder.id);
        }
      } finally {
        this.sendingReminders.delete(reminder.id);
      }
    }
  }

  private async sendReminder(reminder: Reminder): Promise<boolean> {
    const repeatLabel = reminder.repeat
      ? ` (${reminder.repeat === "daily" ? "매일 반복" : "매주 반복"})`
      : "";

    let weatherText = "";
    if (reminder.description.includes("날씨")) {
      try {
        const [seoulWeather, seongnamWeather] = await Promise.all([
          fetchWeather("Seoul"),
          fetchWeather("Seongnam"),
        ]);
        weatherText = `\n\n🌤️ 날씨 정보\n서울: ${seoulWeather}\n성남: ${seongnamWeather}`;
      } catch {
        weatherText = "\n\n🌤️ 날씨 정보를 가져오지 못했어요.";
      }
    }

    const message = `⏰ 이사님, 리마인더 알림이에요!\n\n📌 ${reminder.description}${repeatLabel}${weatherText}`;

    try {
      await this.bot.api.sendMessage(reminder.chatId, message);
      console.log(`[Clo] 리마인더 발송: ${reminder.id}`);
      return true;
    } catch (err) {
      console.error(`[Clo] 리마인더 발송 실패 (${reminder.id}):`, err);
      return false;
    }
  }

  private async checkProactive(hour: number, minute: number): Promise<void> {
    if (!this.proactiveEngine || !this.agent) return;
    if (!this.proactiveEngine.shouldSendNow(hour, minute)) return;

    try {
      // Brain에서 최근 맥락 검색
      const brainContext = executeRecall(
        { goal: "최근 대화 프로젝트 상태 바쁜 핸드오프" },
        this.config.brainRoot,
      );

      // 날씨 정보
      const weatherInfo = await fetchWeather("Seoul");

      // 이사님 DM 세션에서 마지막 대화 시점 읽기
      const ownerChatId = this.config.ownerChatIds[0];
      const ownerSession = this.sessionManager.load(`${ownerChatId}`);
      const lastMessageAt = ownerSession?.lastMessageAt ?? null;

      // 메시지 타입 선택
      const type = this.proactiveEngine.selectMessageType(weatherInfo, brainContext);
      const target = this.proactiveEngine.getTarget(type);

      // LLM context 생성
      const context = this.proactiveEngine.buildContext(
        type, target.name, brainContext, weatherInfo, hour, lastMessageAt,
      );

      // LLM으로 자연스러운 메시지 생성
      console.log(`[Clo] Proactive: ${type} → ${target.name} (chatId: ${target.chatId})`);
      const message = await this.agent.proactiveChat(target.chatId, context);

      // [SKIP]이거나 빈 메시지면 보내지 않음
      if (message.trim() === "[SKIP]" || message.trim() === "") {
        console.log("[Clo] Proactive: 발송 건너뜀 (SKIP 또는 빈 메시지)");
        return;
      }

      // 발송
      await this.bot.api.sendMessage(target.chatId, message);
      this.proactiveEngine.recordSent(type);
      console.log(`[Clo] Proactive 발송 완료: ${type}`);
    } catch (err) {
      console.error("[Clo] Proactive 오류:", err);
    }
  }

  private async sendDailyReport(): Promise<void> {
    for (const chatId of this.config.ownerChatIds) {
      try {
        // 1. GitHub stats (public REST API)
        const ghRes = await fetch(
          `https://api.github.com/repos/${this.config.githubRepo}`,
          { headers: { "User-Agent": "clo-telegram-bot" } },
        );
        const gh = (await ghRes.json()) as Record<string, unknown>;

        // 2. npm downloads (last-day, last-week)
        const pkg = encodeURIComponent(this.config.npmPackage);
        const [dayRes, weekRes] = await Promise.all([
          fetch(`https://api.npmjs.org/downloads/point/last-day/${pkg}`),
          fetch(`https://api.npmjs.org/downloads/point/last-week/${pkg}`),
        ]);
        const dayDl = (await dayRes.json()) as Record<string, unknown>;
        const weekDl = (await weekRes.json()) as Record<string, unknown>;

        // 3. 전일 데이터 로드
        const statsPath = path.join(this.config.sessionDir, "report-stats.json");
        const prev = this.loadPrevStats(statsPath);
        const current = {
          stars: (gh.stargazers_count as number) ?? 0,
          forks: (gh.forks_count as number) ?? 0,
          issues: (gh.open_issues_count as number) ?? 0,
          dayDownloads: (dayDl.downloads as number) ?? 0,
          weekDownloads: (weekDl.downloads as number) ?? 0,
          date: getNowKST().toISOString().slice(0, 10),
        };

        // 4. delta 계산
        const delta = (cur: number, prv: number | undefined): string => {
          if (prv === undefined) return "";
          const diff = cur - prv;
          return diff > 0 ? ` (+${diff})` : diff < 0 ? ` (${diff})` : "";
        };

        // 5. 메시지 포맷
        const kst = getNowKST();
        const dateStr = `${kst.getFullYear()}-${String(kst.getMonth() + 1).padStart(2, "0")}-${String(kst.getDate()).padStart(2, "0")}`;
        const report = [
          `📊 Engram 일일 리포트 (${dateStr})`,
          ``,
          `⭐ GitHub (${this.config.githubRepo})`,
          `  Stars: ${current.stars}${delta(current.stars, prev?.stars)}`,
          `  Forks: ${current.forks}${delta(current.forks, prev?.forks)}`,
          `  Open Issues: ${current.issues}${delta(current.issues, prev?.issues)}`,
          ``,
          `📦 npm (${this.config.npmPackage})`,
          `  어제 다운로드: ${current.dayDownloads}`,
          `  주간 다운로드: ${current.weekDownloads}${delta(current.weekDownloads, prev?.weekDownloads)}`,
        ].join("\n");

        await this.bot.api.sendMessage(chatId, report);

        // 6. 현재 데이터 저장 (내일 비교용)
        this.savePrevStats(statsPath, current);
        console.log(`[Clo] 일일 리포트 발송: chatId=${chatId}`);
      } catch (err) {
        console.error(`[Clo] 리포트 발송 실패 (chatId=${chatId}):`, err);
      }
    }
  }

  private loadPrevStats(statsPath: string): Record<string, number> | null {
    try {
      if (fs.existsSync(statsPath)) {
        return JSON.parse(fs.readFileSync(statsPath, "utf-8"));
      }
    } catch { /* 첫 실행 시 없음 */ }
    return null;
  }

  private savePrevStats(statsPath: string, data: Record<string, unknown>): void {
    try {
      fs.writeFileSync(statsPath, JSON.stringify(data, null, 2), "utf-8");
    } catch { /* best-effort */ }
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
