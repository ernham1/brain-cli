import * as fs from "node:fs";
import * as path from "node:path";
import type { Bot } from "grammy";
import type { Config } from "./config.js";
import { executeRecall, executeTool } from "./tools.js";
import { ClaudeCodeProvider } from "./providers.js";
import { ProactiveEngine, fetchWeather } from "./proactive.js";
import { SessionManager, type DecisionBriefMetadata } from "./session.js";
import type { CloAgent } from "./agent.js";
import type { TaskResult, VscBridge, VscSession, VscSessionEndEvent } from "./bridge.js";
import { TaskRunner } from "./task-runner.js";
import { buildDailyDecisionDigest, readAllDecisions, readDecisionsForDate } from "./orchestrator/decision-digest.js";
import {
  normalizeProjectPath,
  isReportableProjectPath,
  ProjectSessionManager,
  type ProjectSession,
} from "./project-session.js";

export interface BridgeTaskResultHandler {
  handleBridgeTaskResult(result: TaskResult): string | null | Promise<string | null>;
}

export interface DesktopSessionEndReview {
  sourceChatId: number;
  projectPath: string;
  projectName: string;
  reason: string;
  endedAt: string;
  currentTask?: string;
  recentFiles: string[];
  summary?: string;
  remainingTasks: string[];
}

export interface DesktopSessionEndHandler {
  handleDesktopSessionEnd(review: DesktopSessionEndReview): string | null | Promise<string | null>;
}

export interface DecisionReversalProcessor {
  processReversalRequests(): Array<{
    journalId: string;
    status: "reissued" | "failed";
    orchestratorTaskId?: string;
    bridgeTaskId?: string;
    error?: string;
  }>;
}

const DECISION_DIGEST_HOUR = 21; // 일일 결정 다이제스트 발송 시각 (KST)
const PROACTIVE_RECENT_CONVERSATION_SUPPRESS_MS = 3 * 60 * 60 * 1000;
const MAX_SESSION_END_EVENT_ACTIVITY_AGE_MS = 6 * 60 * 60 * 1000;
const SESSION_END_NOTIFY_QUIET_MS = 90_000;
const REMINDER_FAILURE_BACKOFF_MS = [30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000];

interface PendingDesktopSessionEndNotification {
  projectPath: string;
  projectName: string;
  reason: string;
  endedAt: string;
  lastEventAtMs: number;
  sessionIds: Set<string>;
  currentTasks: string[];
  recentFiles: string[];
  summaries: string[];
  remainingTasks: string[];
}

// --- 리마인더 타입 ---

export interface Reminder {
  id: string;
  chatId: number;
  datetime: string; // ISO 8601 (KST offset 포함)
  description: string;
  repeat: "daily" | "weekly" | null;
  notified: boolean;
  retryAfter?: string;
  failureCount?: number;
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
      (r) => (
        !r.notified
        && new Date(r.datetime) <= now
        && (!r.retryAfter || new Date(r.retryAfter) <= now)
      ),
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
      reminders[idx] = {
        ...reminder,
        datetime: next.toISOString(),
        retryAfter: undefined,
        failureCount: undefined,
      };
    } else {
      reminders[idx] = {
        ...reminder,
        notified: true,
        retryAfter: undefined,
        failureCount: undefined,
      };
    }
    this.writeAll(reminders);
  }

  markFailedAttempt(id: string, retryAfter: string, failureCount: number): void {
    const reminders = this.readAll();
    const idx = reminders.findIndex((r) => r.id === id);
    if (idx === -1) return;
    reminders[idx] = {
      ...reminders[idx],
      retryAfter,
      failureCount,
    };
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

function shouldNotifyDesktopSessionEnd(projectSession: ProjectSession): boolean {
  if (projectSession.status === "handed_off") return false;
  const desktop = projectSession.desktopSession;
  if (!desktop) return false;
  if (!isReportableProjectPath(projectSession.projectPath)) return false;
  if (!desktop.currentTask && !desktop.recentFiles?.length && !desktop.summary && projectSession.taskCount === 0) return false;

  const lastActivityMs = Date.parse(desktop.lastActivity ?? desktop.endedAt ?? projectSession.lastActivityAt);
  if (Number.isFinite(lastActivityMs) && Date.now() - lastActivityMs > MAX_SESSION_END_EVENT_ACTIVITY_AGE_MS) return false;

  return true;
}

function appendUnique(target: string[] | Set<string>, value: string | undefined | null, max = 20): void {
  const item = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!item) return;

  if (target instanceof Set) {
    target.add(item);
    return;
  }

  if (target.includes(item)) return;
  target.push(item);
  if (target.length > max) target.splice(0, target.length - max);
}

// --- BotScheduler ---

export class BotScheduler {
  private bot: Bot;
  private config: Config;
  private reminderStore: ReminderStore;
  private proactiveEngine: ProactiveEngine | null = null;
  private agent: CloAgent | null = null;
  private vscBridge: VscBridge | null = null;
  private projectSessionManager: ProjectSessionManager | null = null;
  private taskRunner: TaskRunner | null = null;
  private bridgeTaskResultHandler: BridgeTaskResultHandler | null = null;
  private desktopSessionEndHandler: DesktopSessionEndHandler | null = null;
  private decisionReversalProcessor: DecisionReversalProcessor | null = null;
  private decisionDigestSentToday = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private briefingSentToday = false;
  private reportSentToday = false;
  private weeklyAnalysisSentThisWeek = false;
  private lastCheckedDate = "";
  private lastCheckedWeek = "";
  private sendingReminders = new Map<string, number>(); // 중복 발송 방지 (value: 발송 시작 timestamp)
  private reminderFailureCounts = new Map<string, number>();
  private reminderBackoffUntil = new Map<string, number>();
  private pendingDesktopSessionEnds = new Map<string, PendingDesktopSessionEndNotification>();
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

  setProjectSessionManager(manager: ProjectSessionManager): void {
    this.projectSessionManager = manager;
  }

  /** TaskRunner 주입 */
  setTaskRunner(runner: TaskRunner): void {
    this.taskRunner = runner;
  }

  setBridgeTaskResultHandler(handler: BridgeTaskResultHandler): void {
    this.bridgeTaskResultHandler = handler;
  }

  setDesktopSessionEndHandler(handler: DesktopSessionEndHandler): void {
    this.desktopSessionEndHandler = handler;
  }

  setDecisionReversalProcessor(processor: DecisionReversalProcessor): void {
    this.decisionReversalProcessor = processor;
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
      this.decisionDigestSentToday = false;
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

    // 3.5) 일일 결정 다이제스트 · 21시. 결정 히스토리 전수 열람 대신
    //      요약 1건 + 검토 권장 목록만 텔레그램으로 보낸다 (결정이 있던 날만).
    if (!this.decisionDigestSentToday && hour === DECISION_DIGEST_HOUR && minute === 0) {
      await this.sendDecisionDigest(todayKey);
      this.decisionDigestSentToday = true;
    }

    // 4) 주간 대화 분석 — 월요일 10시
    const weekKey = `${now.getFullYear()}-W${this.getWeekNumber(now)}`;
    if (weekKey !== this.lastCheckedWeek) {
      this.weeklyAnalysisSentThisWeek = false;
      this.lastCheckedWeek = weekKey;
    }
    if (
      now.getDay() === 1 && // 월요일
      hour === 10 &&
      minute === 0 &&
      !this.weeklyAnalysisSentThisWeek
    ) {
      await this.sendWeeklyAnalysis();
      this.weeklyAnalysisSentThisWeek = true;
    }

    // 5) Proactive 메시지 체크 (5분 간격)
    if (this.proactiveEngine && this.agent && minute % 5 === 0) {
      await this.checkProactive(hour, minute);
    }

    // 5) VS Code 브릿지 task 알림 + 결과 폴링 (매 1분)
    if (this.vscBridge) {
      await this.checkBridgeTasks();
    }

    // 6) VS Code 브릿지 만료 파일 정리 (5분 간격)
    if (this.vscBridge && minute % 5 === 0) {
      this.vscBridge.cleanupExpired();
      this.vscBridge.cleanupStale();
      this.projectSessionManager?.pruneExpired();
    }
  }

  /** 일일 결정 다이제스트: 당일 요약 + 전 기간 미검토 무작위 샘플(2026-07-28 C안) 1건 발송 */
  private async sendDecisionDigest(todayKey: string): Promise<void> {
    try {
      const rows = readDecisionsForDate(todayKey);
      const allRows = readAllDecisions();
      const digest = buildDailyDecisionDigest(rows, todayKey, allRows);
      // 당일 결정이 없어도 미검토 백로그 샘플이 있으면 발송한다 (놓친 건 재부상)
      if (rows.length === 0 && digest.sampleItems.length === 0) return;
      const ownerChatId = this.config.ownerChatIds[0];
      if (!ownerChatId) return;
      await this.bot.api.sendMessage(ownerChatId, digest.message);
      console.log(`[Clo] 결정 다이제스트 발송: ${digest.total}건 (검토 권장 ${digest.reviewItems.length}건 · 샘플 ${digest.sampleItems.length}건 · 미검토 잔량 ${digest.backlog.total}건)`);
    } catch (err) {
      console.error("[Clo] 결정 다이제스트 발송 실패:", err);
    }
  }

  private async checkBridgeTasks(): Promise<void> {
    if (!this.vscBridge) return;

    // pending task → claude -p 자동 실행
    if (this.taskRunner) {
      await this.taskRunner.runPendingTasks().catch((err) => {
        console.error("[Clo] TaskRunner 오류:", err);
      });
    }

    const activeDesktopSessions = this.vscBridge.getSafeActiveSessions();
    await this.syncProjectSessions(activeDesktopSessions);
    await this.checkSessionEndEvents();
    await this.flushPendingDesktopSessionEndNotifications(activeDesktopSessions);

    // watcher-notify.jsonl 폴링 → 내부 상태만 기록. 모바일에는 decision brief만 보낸다.
    try {
      const notifications = this.vscBridge.pollWatcherNotify();
      for (const notif of notifications) {
        console.log(`[Clo] 브릿지 수신 알림 내부 처리: ${notif.taskId}`);
      }
    } catch (err) {
      console.error("[Clo] pollWatcherNotify 오류:", err);
    }

    // 만료된 pending task → failed TaskResult로 변환하여 오케스트레이터 평가 파이프라인에 전달.
    // 오케스트레이터가 재지시(REWORK) 또는 이사님 결정 요청(ASK)을 판단한다.
    try {
      const expired = this.vscBridge.pollExpiredTasks();
      for (const task of expired) {
        if (!this.bridgeTaskResultHandler) {
          console.log(`[Clo] 만료 task 내부 처리 (핸들러 없음): ${task.taskId}`);
          continue;
        }

        const syntheticResult: TaskResult = {
          taskId: task.taskId,
          sourceChatId: task.sourceChatId,
          sourceMessageId: task.sourceMessageId,
          status: "failed",
          result: `task_expired: 실행 시간 초과로 만료됨. 원 지시: ${task.instruction.slice(0, 200)}`,
          completedAt: new Date().toISOString(),
        };

        try {
          const decisionBrief = await this.bridgeTaskResultHandler.handleBridgeTaskResult(syntheticResult);
          if (decisionBrief?.trim()) {
            const numberedDecisionBrief = this.recordDecisionBrief(task.sourceChatId, decisionBrief, {
              source: "expired_task",
              taskId: task.taskId,
              sourceMessageId: task.sourceMessageId,
            });
            await this.bot.api.sendMessage(task.sourceChatId, numberedDecisionBrief, {
              ...(task.sourceMessageId ? { reply_parameters: { message_id: task.sourceMessageId } } : {}),
            });
            console.log(`[Clo] 만료 task 의사결정 브리프 발송: ${task.taskId}`);
          } else {
            console.log(`[Clo] 만료 task 오케스트레이터 처리 완료: ${task.taskId}`);
          }
        } catch (err) {
          console.error(`[Clo] 만료 task 오케스트레이터 처리 실패 (${task.taskId}):`, err);
        }
      }
    } catch (err) {
      console.error("[Clo] pollExpiredTasks 오류:", err);
    }

    // 감사 GUI 뒤집기 요청 폴링 → 재작업 발행 (텔레그램 전송 없음, 내부 로그만)
    if (this.decisionReversalProcessor) {
      try {
        const outcomes = this.decisionReversalProcessor.processReversalRequests();
        for (const outcome of outcomes) {
          console.log(
            `[Clo] 결정 뒤집기 처리: ${outcome.journalId} → ${outcome.status}`
            + `${outcome.bridgeTaskId ? ` (재작업 ${outcome.bridgeTaskId})` : ""}`
            + `${outcome.error ? ` (${outcome.error})` : ""}`,
          );
        }
      } catch (err) {
        console.error("[Clo] 결정 뒤집기 처리 오류:", err);
      }
    }

    // task-results/ 폴링 → 오케스트레이터 검수. decision brief가 있을 때만 전송.
    try {
      const results = this.vscBridge.pollTaskResults();
      for (const result of results) {
        try {
          const decisionBrief = await this.bridgeTaskResultHandler?.handleBridgeTaskResult(result);
          if (!decisionBrief?.trim()) {
            console.log(`[Clo] 브릿지 결과 내부 처리: ${result.taskId} (${result.status})`);
            continue;
          }
          const numberedDecisionBrief = this.recordDecisionBrief(result.sourceChatId, decisionBrief, {
            source: "bridge_result",
            taskId: result.taskId,
            sourceMessageId: result.sourceMessageId,
          });
          // sourceMessageId 0(세션 종료 continuation 등)은 reply 대상이 없으므로 일반 전송
          await this.bot.api.sendMessage(result.sourceChatId, numberedDecisionBrief, {
            ...(result.sourceMessageId ? { reply_parameters: { message_id: result.sourceMessageId } } : {}),
          });
          console.log(`[Clo] 의사결정 브리프 발송: ${result.taskId} (${result.status})`);
        } catch (err) {
          console.error(`[Clo] 브릿지 결과 처리 실패 (${result.taskId}):`, err);
        }
      }
    } catch (err) {
      console.error("[Clo] pollTaskResults 오류:", err);
    }
  }

  private async syncProjectSessions(activeDesktopSessions: VscSession[]): Promise<void> {
    if (!this.vscBridge || !this.projectSessionManager) return;

    try {
      const syncResult = this.projectSessionManager.syncDesktopSessions(activeDesktopSessions);
      for (const { vscSession, projectSession } of syncResult.endedSessions) {
        if (!this.projectSessionManager.shouldNotifySessionEnd(vscSession, projectSession)) continue;
        this.queueDesktopSessionEnd(projectSession, "active 목록에서 사라짐", {
          id: `active:${vscSession.sessionId}`,
          sessionId: vscSession.sessionId,
          cwd: vscSession.cwd,
          projectName: vscSession.projectName,
          endedAt: projectSession.desktopSession?.endedAt ?? new Date().toISOString(),
          currentTask: vscSession.currentTask,
          recentFiles: vscSession.recentFiles,
        });
      }
    } catch (err) {
      console.error("[Clo] 프로젝트 세션 동기화 오류:", err);
    }
  }

  private async checkSessionEndEvents(): Promise<void> {
    if (!this.vscBridge || !this.projectSessionManager) return;

    try {
      const events: VscSessionEndEvent[] = this.vscBridge.pollSessionEndEvents();
      for (const event of events) {
        const existing = this.projectSessionManager.getSession(event.cwd);
        const alreadyNotified = existing?.lastSessionEndNotifiedId === event.sessionId;
        const projectSession = this.projectSessionManager.syncDesktopSession(event.cwd, {
          vscSessionId: event.sessionId,
          currentTask: event.currentTask ?? existing?.desktopSession?.currentTask,
          lastActivity: existing?.desktopSession?.lastActivity ?? event.endedAt,
          recentFiles: event.recentFiles?.length ? event.recentFiles : existing?.desktopSession?.recentFiles ?? [],
          status: "offline",
          startedAt: existing?.desktopSession?.startedAt ?? event.endedAt,
          endedAt: event.endedAt,
          summary: event.summary ?? existing?.desktopSession?.summary,
          remainingTasks: event.remainingTasks?.length ? event.remainingTasks : existing?.desktopSession?.remainingTasks,
        }, existing?.projectName ?? event.projectName);
        if (alreadyNotified || projectSession.lastSessionEndNotifiedId === event.sessionId) continue;
        if (!shouldNotifyDesktopSessionEnd(projectSession)) continue;
        this.queueDesktopSessionEnd(projectSession, "정상 종료 hook 이벤트", event);
      }
    } catch (err) {
      console.error("[Clo] 세션 종료 이벤트 처리 오류:", err);
    }
  }

  private queueDesktopSessionEnd(
    projectSession: ProjectSession,
    reason: string,
    event?: VscSessionEndEvent,
  ): void {
    const desktop = projectSession.desktopSession;
    const key = normalizeProjectPath(projectSession.projectPath).toLowerCase();
    const endedAt = event?.endedAt ?? desktop?.endedAt ?? desktop?.lastActivity ?? projectSession.lastActivityAt;
    const endedAtMs = Date.parse(endedAt);
    const eventMs = Number.isFinite(endedAtMs) ? endedAtMs : Date.now();
    let pending = this.pendingDesktopSessionEnds.get(key);
    const hadPendingNotification = pending !== undefined;

    if (!pending) {
      pending = {
        projectPath: projectSession.projectPath,
        projectName: projectSession.projectName,
        reason,
        endedAt,
        lastEventAtMs: eventMs,
        sessionIds: new Set<string>(),
        currentTasks: [],
        recentFiles: [],
        summaries: [],
        remainingTasks: [],
      };
      this.pendingDesktopSessionEnds.set(key, pending);
    }

    pending.reason = reason.includes("정상 종료") ? reason : pending.reason;
    pending.projectName = projectSession.projectName || pending.projectName;
    const isSyntheticDisappearance = reason === "active 목록에서 사라짐";
    if ((!hadPendingNotification || !isSyntheticDisappearance) && eventMs >= pending.lastEventAtMs) {
      pending.endedAt = endedAt;
      pending.lastEventAtMs = eventMs;
    }

    appendUnique(pending.sessionIds, event?.sessionId ?? desktop?.vscSessionId);
    appendUnique(pending.currentTasks, event?.currentTask ?? desktop?.currentTask, 10);
    for (const file of event?.recentFiles ?? desktop?.recentFiles ?? []) appendUnique(pending.recentFiles, file, 20);
    appendUnique(pending.summaries, event?.summary ?? desktop?.summary, 10);
    for (const task of event?.remainingTasks ?? desktop?.remainingTasks ?? []) appendUnique(pending.remainingTasks, task, 10);
  }

  private async flushPendingDesktopSessionEndNotifications(
    activeDesktopSessions: VscSession[],
    nowMs = Date.now(),
  ): Promise<void> {
    if (!this.projectSessionManager) return;

    for (const [key, pending] of Array.from(this.pendingDesktopSessionEnds.entries())) {
      if (nowMs - pending.lastEventAtMs < SESSION_END_NOTIFY_QUIET_MS) continue;
      if (this.hasActiveDesktopSessionForPending(pending, activeDesktopSessions)) continue;

      const projectSession = this.projectSessionManager.getSession(pending.projectPath);
      if (!projectSession) {
        this.pendingDesktopSessionEnds.delete(key);
        continue;
      }

      const sessionIds = Array.from(pending.sessionIds).filter(Boolean);
      const event: VscSessionEndEvent = {
        id: `pending:${key}:${pending.endedAt}`,
        sessionId: sessionIds.at(-1) ?? projectSession.desktopSession?.vscSessionId ?? "",
        cwd: pending.projectPath,
        projectName: pending.projectName,
        endedAt: pending.endedAt,
        currentTask: pending.currentTasks.at(-1),
        recentFiles: pending.recentFiles,
        summary: pending.summaries.join("\n"),
        remainingTasks: pending.remainingTasks,
      };

      await this.notifyDesktopSessionEnd(projectSession, pending.reason, event);
      for (const sessionId of sessionIds) {
        this.projectSessionManager.markSessionEndNotified(pending.projectPath, sessionId);
      }
      this.pendingDesktopSessionEnds.delete(key);
    }
  }

  private hasActiveDesktopSessionForPending(
    pending: PendingDesktopSessionEndNotification,
    activeDesktopSessions: VscSession[],
  ): boolean {
    const targetPath = normalizeProjectPath(pending.projectPath).toLowerCase();
    return activeDesktopSessions.some((session) => (
      normalizeProjectPath(session.cwd).toLowerCase() === targetPath
      && session.status !== "offline"
    ));
  }

  private async notifyDesktopSessionEnd(
    projectSession: ProjectSession,
    reason: string,
    event?: VscSessionEndEvent,
  ): Promise<void> {
    const ownerChatId = this.config.ownerChatIds[0];
    if (ownerChatId === undefined) return;

    const review = buildDesktopSessionEndReview(ownerChatId, projectSession, reason, event);
    const decisionBrief = await this.desktopSessionEndHandler?.handleDesktopSessionEnd(review);
    if (!decisionBrief?.trim()) {
      console.log(
        `[Clo] 프로젝트 세션 종료 내부 처리: ${projectSession.projectName} (${reason})`
        + (event?.summary ? " summary=1" : " summary=0"),
      );
      return;
    }

    const numberedDecisionBrief = this.recordDecisionBrief(ownerChatId, decisionBrief, {
      source: "desktop_session_end",
    });
    await this.bot.api.sendMessage(ownerChatId, numberedDecisionBrief);
    console.log(`[Clo] 세션 종료 의사결정 브리프 발송: ${projectSession.projectName}`);
  }

  private recordDecisionBrief(chatId: number, message: string, metadata: DecisionBriefMetadata): string {
    if (this.agent) {
      return this.agent.recordDecisionBrief(chatId, message, metadata);
    }
    return this.sessionManager.recordDecisionBrief(chatId, message, metadata);
  }
  private recordAssistantMessage(chatId: number, message: string): void {
    if (this.agent) {
      this.agent.recordAssistantMessage(chatId, message);
      return;
    }

    const session = this.sessionManager.getOrCreate(chatId);
    session.history.push({ role: "assistant", content: message });
    this.sessionManager.trimHistory(session);
    session.lastMessageAt = new Date().toISOString();
    this.sessionManager.save(session);
  }
  private async checkReminders(now: Date): Promise<void> {
    const dueReminders = this.reminderStore.getDue(now);

    for (const reminder of dueReminders) {
      const backoffUntil = this.reminderBackoffUntil.get(reminder.id) ?? 0;
      if (backoffUntil > Date.now()) continue;

      // 이미 발송 중인 리마인더는 건너뛰기 (비동기 레이스 방지)
      const sendingAt = this.sendingReminders.get(reminder.id);
      if (sendingAt && Date.now() - sendingAt < 5 * 60_000) continue; // 5분 내 재시도 차단
      this.sendingReminders.set(reminder.id, Date.now());

      try {
        const sent = await this.sendReminder(reminder);
        if (sent) {
          this.reminderStore.markNotified(reminder.id);
          this.reminderFailureCounts.delete(reminder.id);
          this.reminderBackoffUntil.delete(reminder.id);
        } else {
          this.deferReminderRetry(reminder);
        }
      } finally {
        this.sendingReminders.delete(reminder.id);
      }
    }
  }

  private deferReminderRetry(reminder: Reminder): void {
    if (reminder.repeat) {
      this.reminderFailureCounts.delete(reminder.id);
      this.reminderBackoffUntil.delete(reminder.id);
      this.reminderStore.markNotified(reminder.id);
      console.warn(`[Clo] 반복 리마인더 발송 실패 (${reminder.id}): 다음 일정으로 넘김`);
      return;
    }

    const previousFailureCount = Math.max(
      reminder.failureCount ?? 0,
      this.reminderFailureCounts.get(reminder.id) ?? 0,
    );
    const failureCount = previousFailureCount + 1;
    this.reminderFailureCounts.set(reminder.id, failureCount);
    const delayMs = REMINDER_FAILURE_BACKOFF_MS[Math.min(failureCount - 1, REMINDER_FAILURE_BACKOFF_MS.length - 1)];
    const retryAt = new Date(Date.now() + delayMs);
    this.reminderBackoffUntil.set(reminder.id, retryAt.getTime());
    this.reminderStore.markFailedAttempt(reminder.id, retryAt.toISOString(), failureCount);
    console.warn(`[Clo] 리마인더 재시도 보류 (${reminder.id}): ${Math.round(delayMs / 60_000)}분 후`);
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

    const fallbackMessage = `⏰ 이사님, 리마인더 알림이에요!\n\n📌 ${reminder.description}${repeatLabel}${weatherText}`;

    let sent = false;

    try {
      await this.bot.api.sendMessage(reminder.chatId, fallbackMessage);
      console.log(`[Clo] 리마인더 발송: ${reminder.id}`);
      sent = true;
    } catch (err) {
      console.error(`[Clo] 리마인더 발송 실패 (${reminder.id}): ${summarizeTelegramDeliveryError(err)}`);
      return false;
    }

    // Brain 백업 — 발송 성공 시 기록 (다른 인스턴스/채팅에서 recall 가능하도록)
    if (sent) {
      try {
        const kstNow = getNowKST();
        const dateStr = kstNow.toISOString().slice(0, 10).replace(/-/g, "");
        await executeTool("brain_write", {
          action: "create",
          sourceRef: `30_topics/reminders/${dateStr}_${reminder.id}.md`,
          content: `# 리마인더 발송 — ${reminder.description}\n\n- ID: ${reminder.id}\n- 시간: ${reminder.datetime}\n- 대상 chatId: ${reminder.chatId}\n- 반복: ${reminder.repeat ?? "없음"}\n- 발송 완료: ${kstNow.toISOString()}`,
          record: {
            scopeType: "topic",
            scopeId: "reminders",
            type: "note",
            title: `리마인더 발송 — ${reminder.description.slice(0, 40)}`,
            summary: `${reminder.datetime} chatId:${reminder.chatId} ${reminder.repeat ? `(${reminder.repeat})` : ""}`,
            tags: ["domain/reminder", "intent/retrieval"],
            sourceType: "candidate",
          },
        }, this.config.brainRoot || "");
      } catch (err) {
        console.error(`[Clo] 리마인더 Brain 백업 실패 (${reminder.id}):`, err);
      }
    }

    return sent;
  }

  private async checkProactive(hour: number, minute: number): Promise<void> {
    if (!this.proactiveEngine || !this.agent) return;
    if (!this.proactiveEngine.shouldSendNow(hour, minute)) return;

    try {
      // 이사님과 최근 대화가 있으면 proactive가 직전 질문을 재답변할 수 있으므로 건너뛴다.
      const ownerChatId = this.config.ownerChatIds[0];
      const ownerSession = this.sessionManager.load(`${ownerChatId}`);
      const lastMessageAt = ownerSession?.lastMessageAt ?? null;
      if (lastMessageAt) {
        const lastMessageTime = new Date(lastMessageAt).getTime();
        if (
          Number.isFinite(lastMessageTime) &&
          Date.now() - lastMessageTime < PROACTIVE_RECENT_CONVERSATION_SUPPRESS_MS
        ) {
          console.log("[Clo] Proactive: 최근 대화가 있어 발송 건너뜀");
          return;
        }
      }

      // Brain에서 최근 맥락 검색
      const brainContext = await executeRecall(
        { goal: "최근 대화 프로젝트 상태 바쁜 핸드오프" },
        this.config.brainRoot || "",
      );

      // 날씨 정보
      const weatherInfo = await fetchWeather("Seoul");

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

  private getWeekNumber(date: Date): number {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  }

  private async sendWeeklyAnalysis(): Promise<void> {
    const dataDir = path.join(process.cwd(), "data");
    const summary = ClaudeCodeProvider.analyzeConversationTurns(dataDir);

    for (const chatId of this.config.ownerChatIds) {
      try {
        const msg = [
          `🔍 주간 대화 패턴 분석`,
          ``,
          summary,
          ``,
          `위 분석을 바탕으로 프롬프트 개선이 필요한 항목이 있으면 제안드릴게요.`,
          `개선 제안을 받으시겠어요? [✅ 네] [❌ 나중에]`,
        ].join("\n");

        await this.bot.api.sendMessage(chatId, msg, {
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ 개선 제안 받기", callback_data: "weekly_analysis_approve" },
              { text: "❌ 나중에", callback_data: "weekly_analysis_skip" },
            ]],
          },
        });
      } catch (err) {
        console.error("[Clo] 주간 분석 전송 실패:", err);
      }
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

        // Brain 저장 — 리포트 이력 추적
        try {
          await executeTool("brain_write", {
            action: "create",
            sourceRef: `30_topics/reports/${current.date.replace(/-/g, "")}_report.md`,
            content: report,
            record: {
              scopeType: "topic",
              scopeId: "reports",
              type: "log",
              title: `Engram 일일 리포트 — ${current.date}`,
              summary: `Stars:${current.stars} npm 주간:${current.weekDownloads}`,
              tags: ["domain/engram", "intent/retrieval"],
              sourceType: "candidate",
            },
          }, this.config.brainRoot || "");
        } catch (err) {
          console.error("[Clo] 리포트 Brain 저장 실패:", err);
        }
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
        const brainInfo = await executeRecall(
          { goal: "프로젝트 상태 일정 오늘 할일" },
          this.config.brainRoot || "",
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

        // Wiki Lint 상태 (주 1회 월 06:00 자동 실행, 2026-04-19 도입)
        try {
          const lintPath = path.join(this.config.brainRoot || "", "00_meta", "wiki-lint-latest.json");
          if (fs.existsSync(lintPath)) {
            const lintRaw = fs.readFileSync(lintPath, "utf-8");
            const lintData = JSON.parse(lintRaw);
            const issues = Array.isArray(lintData.issues) ? lintData.issues : [];
            const critical = issues.filter((i: { severity: string }) => i.severity === "critical").length;
            const warning = issues.filter((i: { severity: string }) => i.severity === "warning").length;
            const ageDays = Math.floor((Date.now() - fs.statSync(lintPath).mtimeMs) / 86400000);
            const statusIcon = critical > 0 ? "🔴" : warning > 0 ? "🟡" : "🟢";
            const ageWarn = ageDays >= 8 ? " ⚠️ 스케줄러 실패 의심" : "";
            briefing += `\n\n${statusIcon} Wiki 상태: ${ageDays}일 전 검사, critical ${critical} / warning ${warning}${ageWarn}`;
          } else {
            briefing += `\n\n⚪ Wiki 상태: Lint 기록 없음 (아직 자동 실행 전)`;
          }
        } catch (err) {
          console.error("[Clo] Wiki Lint 상태 읽기 실패:", err);
        }

        briefing += "\n\n오늘도 화이팅이에요! 💪";

        await this.bot.api.sendMessage(chatId, briefing);
        console.log(`[Clo] 일일 브리핑 발송: chatId=${chatId}`);

        // Brain 저장 — 브리핑 이력 추적
        try {
          await executeTool("brain_write", {
            action: "create",
            sourceRef: `30_topics/briefings/${todayStr.replace(/-/g, "")}_briefing.md`,
            content: briefing,
            record: {
              scopeType: "topic",
              scopeId: "briefings",
              type: "log",
              title: `일일 브리핑 — ${todayStr}`,
              summary: `${todayStr} 브리핑 발송 완료 (리마인더 ${todayItems.length}건)`,
              tags: ["domain/schedule", "intent/retrieval"],
              sourceType: "candidate",
            },
          }, this.config.brainRoot || "");
        } catch (err) {
          console.error("[Clo] 브리핑 Brain 저장 실패:", err);
        }
      } catch (err) {
        console.error(`[Clo] 브리핑 발송 실패 (chatId=${chatId}):`, err);
      }
    }
  }
}

function buildDesktopSessionEndReview(
  sourceChatId: number,
  projectSession: ProjectSession,
  reason: string,
  event?: VscSessionEndEvent,
): DesktopSessionEndReview {
  const desktop = projectSession.desktopSession;
  const currentTask = event?.currentTask ?? desktop?.currentTask;
  const summary = event?.summary ?? desktop?.summary;
  return {
    sourceChatId,
    projectPath: projectSession.projectPath,
    projectName: projectSession.projectName,
    reason,
    endedAt: event?.endedAt ?? desktop?.endedAt ?? desktop?.lastActivity ?? projectSession.lastActivityAt,
    ...(currentTask ? { currentTask } : {}),
    recentFiles: event?.recentFiles?.length ? event.recentFiles : desktop?.recentFiles ?? [],
    ...(summary ? { summary } : {}),
    remainingTasks: event?.remainingTasks?.length ? event.remainingTasks : desktop?.remainingTasks ?? [],
  };
}
function summarizeTelegramDeliveryError(error: unknown): string {
  const text = getTelegramErrorText(error);
  const code = text.match(/\b(E[A-Z_]+|ETIMEDOUT|ECONNRESET|ECONNREFUSED)\b/)?.[1];
  if (code) return code;
  return text.split(/\r?\n/)[0]?.trim().slice(0, 120) || "unknown Telegram delivery error";
}

function getTelegramErrorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (current instanceof Error) {
      parts.push(current.name, current.message);
    }
    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      for (const key of ["code", "errno", "type", "status"]) {
        if (record[key] !== undefined) parts.push(String(record[key]));
      }
      current = record.error ?? record.cause;
    } else {
      break;
    }
  }

  return parts
    .filter(Boolean)
    .join(" ")
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>");
}
