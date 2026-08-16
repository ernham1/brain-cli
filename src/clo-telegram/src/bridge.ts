import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Bot } from "grammy";
import type { Config } from "./config.js";

const BRIDGE_DIR_NAME = "bridge";
const DEFAULT_ACTIVE_SESSION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SESSION_RECORD_TTL_MS = 24 * 60 * 60 * 1000;

export interface VscSession {
  sessionId: string;
  cwd: string;
  projectName: string;
  startedAt: string;
  watcherPid?: number;
  currentTask?: string;
  lastActivity?: string;
  recentFiles?: string[];
  status?: "working" | "idle" | "offline";
}

export interface CreateTaskParams {
  sourceChatId: number;
  sourceMessageId: number;
  targetCwd: string;
  instruction: string;
  initialStatus?: "pending" | "launched";
}

export interface BridgeTask {
  taskId: string;
  requestedAt: string;
  expiresAt: string;
  sourceChatId: number;
  sourceMessageId: number;
  targetCwd: string;
  instruction: string;
  status: string;
  resultFile: string;
}

export interface TaskResult {
  taskId: string;
  sourceChatId: number;
  sourceMessageId: number;
  status: "completed" | "failed";
  result: string;
  completedAt: string;
}

export interface VscSessionEndEvent {
  id: string;
  sessionId: string;
  cwd: string;
  projectName: string;
  endedAt: string;
  currentTask?: string;
  recentFiles?: string[];
  summary?: string;
  remainingTasks?: string[];
}

export interface ActiveSessionSafetyOptions {
  ttlMs?: number;
  sessionTtlMs?: number;
  now?: Date;
  isProcessAlive?: (pid: number) => boolean;
}

export type ProjectSessionResolution =
  | { status: "none"; session: null; matches: VscSession[] }
  | { status: "active"; session: VscSession; matches: VscSession[] }
  | { status: "ambiguous"; session: null; matches: VscSession[] };

interface ActiveSessionSnapshot {
  sessions: VscSession[];
  updatedAt?: string;
}

export interface DesktopStatusSnapshot {
  /** vscode-active.json에서 찾은 세션 (없으면 null) */
  session: VscSession | null;
  /** 파일 시스템 직접 스캔으로 발견한 최근 변경 파일 */
  recentlyModifiedFiles: RecentFile[];
  /** 스캔 시각 */
  scanTime: string;
}

export interface RecentFile {
  filePath: string;
  modifiedAt: string;
}

/**
 * 프로젝트 경로 아래에서 최근 N분 이내에 수정된 파일을 직접 스캔한다.
 * node_modules, .tmp, dist, .git 등은 제외.
 * vscode-active.json이 오래됐을 때 fallback으로 사용.
 */
function scanRecentFiles(projectPath: string, minutesAgo: number, maxResults = 15): RecentFile[] {
  const { execSync } = require("node:child_process");
  try {
    const output = execSync(
      `find "${projectPath}" -maxdepth 5 -mmin -${minutesAgo} ` +
      `-not -path "*/node_modules/*" -not -path "*/.tmp/*" -not -path "*/dist/*" ` +
      `-not -path "*/.git/*" -not -name "*.tmp" -type f`,
      { encoding: "utf-8", timeout: 5000, windowsHide: true },
    ).trim();
    if (!output) return [];
    const files = output.split("\n").filter(Boolean).slice(0, maxResults * 2);
    // stat으로 정확한 수정 시각 가져오기
    const results: RecentFile[] = [];
    for (const filePath of files) {
      try {
        const stat = fs.statSync(filePath);
        results.push({ filePath: filePath.replace(/\\/g, "/"), modifiedAt: stat.mtime.toISOString() });
      } catch { /* skip */ }
    }
    return results
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
      .slice(0, maxResults);
  } catch {
    return [];
  }
}

export class VscBridge {
  private ownerUserIds: number[];
  private pendingDir: string;
  private responseDir: string;
  private tasksDir: string;
  private taskResultsDir: string;
  private activeFile: string;
  private watcherNotifyFile: string;
  private sessionEndEventsFile: string;
  private processedNotifyIds = new Set<string>();
  private processedResultIds = new Set<string>();
  private notifiedExpiredIds = new Set<string>();
  private processedSessionEndEventIds = new Set<string>();

  constructor(
    private bot: Bot,
    config: Config,
  ) {
    this.ownerUserIds = config.ownerUserIds;

    const dataDir = path.join(process.cwd(), "data");
    const bridgeDir = path.join(dataDir, BRIDGE_DIR_NAME);
    this.pendingDir = path.join(bridgeDir, "pending");
    this.responseDir = path.join(bridgeDir, "responses");
    this.tasksDir = path.join(bridgeDir, "tasks");
    this.taskResultsDir = path.join(bridgeDir, "task-results");
    this.activeFile = path.join(bridgeDir, "vscode-active.json");
    this.watcherNotifyFile = path.join(bridgeDir, "watcher-notify.jsonl");
    this.sessionEndEventsFile = path.join(bridgeDir, "session-end-events.jsonl");

    this.ensureDirs();
  }

  private ensureDirs(): void {
    for (const dir of [this.pendingDir, this.responseDir, this.tasksDir, this.taskResultsDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /** approval.registerHandlers() 보다 먼저 호출할 것 */
  registerHandlers(): void {
    this.bot.on("callback_query:data", async (ctx, next) => {
      const data = ctx.callbackQuery.data;

      let requestId: string | undefined;
      let approved: boolean;

      if (data.startsWith("vsc_approve_")) {
        requestId = data.slice("vsc_approve_".length);
        approved = true;
      } else if (data.startsWith("vsc_reject_")) {
        requestId = data.slice("vsc_reject_".length);
        approved = false;
      } else {
        return next(); // vsc_ 접두사 아님 → 다음 핸들러(approval.ts)로 전달
      }

      // ownerUserIds 검증
      const clickerId = ctx.from?.id;
      if (
        this.ownerUserIds.length > 0 &&
        clickerId &&
        !this.ownerUserIds.includes(clickerId)
      ) {
        await ctx
          .answerCallbackQuery("VS Code 승인 권한이 없어요.")
          .catch(() => {});
        return;
      }

      // response 파일 작성 → hook이 즉시 감지
      const responseData = {
        id: requestId,
        approved,
        userId: clickerId,
        respondedAt: new Date().toISOString(),
      };

      try {
        fs.writeFileSync(
          path.join(this.responseDir, `${requestId}.json`),
          JSON.stringify(responseData, null, 2),
        );
      } catch (err) {
        console.error("[VscBridge] 응답 파일 작성 실패:", err);
        await ctx
          .answerCallbackQuery("응답 처리 중 오류가 발생했어요.")
          .catch(() => {});
        return;
      }

      // pending 파일 삭제
      try {
        fs.unlinkSync(path.join(this.pendingDir, `${requestId}.json`));
      } catch {
        /* 이미 삭제됐거나 없으면 무시 */
      }

      console.log(
        `[VscBridge] VS Code ${approved ? "승인" : "거절"}: ${requestId}`,
      );

      await ctx
        .answerCallbackQuery(approved ? "VS Code 승인!" : "VS Code 거절")
        .catch(() => {});
      await ctx
        .editMessageText(
          approved
            ? "✅ VS Code 도구 사용 승인됨 — 작업 진행 중..."
            : "❌ VS Code 도구 사용 거절됨",
        )
        .catch(() => {});
    });
  }

  /** 현재 활성 VS Code 세션 목록 반환 */
  getActiveSessions(): VscSession[] {
    return this.readActiveSessionSnapshot().sessions;
  }

  getSafeActiveSessions(options: ActiveSessionSafetyOptions = {}): VscSession[] {
    const snapshot = this.readActiveSessionSnapshot();
    if (!isActiveSnapshotFresh(snapshot, options)) return [];

    const processAlive = options.isProcessAlive ?? isProcessAlive;
    return snapshot.sessions.filter((session) => {
      if (!isSessionRecordFresh(session, options)) return false;
      if (session.status === "offline") return false;
      if (session.watcherPid === undefined) return true;
      return processAlive(session.watcherPid);
    });
  }

  resolveProjectSession(projectName: string, options: ActiveSessionSafetyOptions = {}): ProjectSessionResolution {
    const name = projectName.trim().toLowerCase();
    if (!name) return { status: "none", session: null, matches: [] };

    const matches = this.getSafeActiveSessions(options)
      .filter((session) => session.projectName.toLowerCase() === name);

    if (matches.length === 0) return { status: "none", session: null, matches };
    if (matches.length === 1) return { status: "active", session: matches[0], matches };
    return { status: "ambiguous", session: null, matches };
  }

  private readActiveSessionSnapshot(): ActiveSessionSnapshot {
    try {
      if (!fs.existsSync(this.activeFile)) return { sessions: [] };
      const data = JSON.parse(fs.readFileSync(this.activeFile, "utf-8"));
      const sessions = Array.isArray(data.sessions) ? data.sessions.filter(isVscSession) : [];
      return {
        sessions,
        ...(typeof data.updatedAt === "string" ? { updatedAt: data.updatedAt } : {}),
      };
    } catch {
      return { sessions: [] };
    }
  }

  /** 프로젝트명으로 활성 세션 찾기 (없으면 null) */
  isProjectActive(projectName: string): VscSession | null {
    const sessions = this.getActiveSessions();
    const name = projectName.toLowerCase();
    const matches = sessions.filter(s => s.projectName === name);
    if (matches.length === 0) return null;
    // 동일 프로젝트 세션이 여러 개면 가장 최근 것 사용
    return matches.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  }

  /**
   * 프로젝트의 데스크톱 세션 상태를 종합 조회한다.
   * 1) vscode-active.json에서 해당 프로젝트의 세션 정보
   * 2) active.json이 오래됐으면 파일 시스템에서 최근 변경 파일 직접 스캔 (fallback)
   * 반환값은 시스템 프롬프트에 주입할 수 있는 구조화된 객체.
   */
  getProjectDesktopStatus(projectPath: string): DesktopStatusSnapshot | null {
    const normalizedPath = projectPath.replace(/\\/g, "/").toLowerCase();
    const sessions = this.getActiveSessions();

    // cwd가 프로젝트 경로 아래에 있는 세션 찾기
    const matching = sessions.filter((s) => {
      const sCwd = (s.cwd || "").replace(/\\/g, "/").toLowerCase();
      return sCwd === normalizedPath || sCwd.startsWith(normalizedPath + "/");
    });

    // 가장 최근 활동 세션
    const activeSession = matching
      .sort((a, b) => (b.lastActivity ?? b.startedAt).localeCompare(a.lastActivity ?? a.startedAt))[0] ?? null;

    // 파일 시스템 직접 스캔 — active.json이 오래됐거나 세션 정보가 없을 때 fallback
    // 2시간으로 확대: 이사님이 간헐적으로 저장하는 작업 패턴 대응
    const recentFiles = scanRecentFiles(projectPath, 120); // 최근 2시간

    // vscode-active.json에 매칭 세션이 있으면 파일 스캔 결과와 무관하게 항상 반환
    if (!activeSession && recentFiles.length === 0) return null;

    return {
      session: activeSession,
      recentlyModifiedFiles: recentFiles,
      scanTime: new Date().toISOString(),
    };
  }

  /** VS Code 세션으로 전달할 task 파일 생성 → taskId 반환 */
  createTask(params: CreateTaskParams): string {
    const now = new Date();
    const datePart = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 15);
    const rand = crypto.randomBytes(2).toString("hex");
    const taskId = `task_${datePart}_${rand}`;

    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const resultFile = path.join(this.taskResultsDir, `${taskId}.json`).replace(/\\/g, "/");

    const task: BridgeTask = {
      taskId,
      requestedAt: now.toISOString(),
      expiresAt,
      sourceChatId: params.sourceChatId,
      sourceMessageId: params.sourceMessageId,
      targetCwd: params.targetCwd,
      instruction: params.instruction,
      status: params.initialStatus ?? "pending",
      resultFile,
    };

    const taskFile = path.join(this.tasksDir, `${taskId}.json`);
    const tmp = taskFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(task, null, 2), "utf-8");
    fs.renameSync(tmp, taskFile);

    console.log(`[VscBridge] task 생성: ${taskId} → ${params.targetCwd}`);
    return taskId;
  }

  getTask(taskId: string): BridgeTask | null {
    try {
      const taskFile = path.join(this.tasksDir, `${taskId}.json`);
      if (!fs.existsSync(taskFile)) return null;
      const task = JSON.parse(fs.readFileSync(taskFile, "utf-8"));
      return isBridgeTask(task) ? task : null;
    } catch {
      return null;
    }
  }

  /** watcher-notify.jsonl 폴링 → 미처리 알림 반환 후 소비 마킹 */
  pollWatcherNotify(): Array<{ taskId: string; sourceChatId: number; message: string }> {
    const results: Array<{ taskId: string; sourceChatId: number; message: string }> = [];
    try {
      if (!fs.existsSync(this.watcherNotifyFile)) return results;

      const lines = fs.readFileSync(this.watcherNotifyFile, "utf-8")
        .split("\n")
        .filter(l => l.trim());

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.taskId && !this.processedNotifyIds.has(entry.taskId)) {
            this.processedNotifyIds.add(entry.taskId);
            results.push({
              taskId: entry.taskId,
              sourceChatId: entry.sourceChatId,
              message: entry.message,
            });
          }
        } catch { /* 파싱 실패 무시 */ }
      }

      // 처리 완료된 파일 초기화 (다음 번엔 빈 상태로)
      if (results.length > 0) {
        try { fs.writeFileSync(this.watcherNotifyFile, "", "utf-8"); } catch { /* 무시 */ }
      }
    } catch { /* 무시 */ }
    return results;
  }

  pollSessionEndEvents(): VscSessionEndEvent[] {
    const results: VscSessionEndEvent[] = [];
    try {
      if (!fs.existsSync(this.sessionEndEventsFile)) return results;

      const lines = fs.readFileSync(this.sessionEndEventsFile, "utf-8")
        .split("\n")
        .filter(l => l.trim());

      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (!isVscSessionEndEvent(event)) continue;
          if (this.processedSessionEndEventIds.has(event.id)) continue;
          this.processedSessionEndEventIds.add(event.id);
          results.push(event);
        } catch { /* 파싱 실패 무시 */ }
      }

      if (results.length > 0) {
        try { fs.writeFileSync(this.sessionEndEventsFile, "", "utf-8"); } catch { /* 무시 */ }
      }
    } catch { /* 무시 */ }
    return results;
  }

  /** task-results/ 폴링 → 완료된 결과 반환 후 파일 삭제 */
  pollTaskResults(): TaskResult[] {
    const results: TaskResult[] = [];
    try {
      if (!fs.existsSync(this.taskResultsDir)) return results;

      for (const file of fs.readdirSync(this.taskResultsDir)) {
        if (!file.endsWith(".json")) continue;
        const filePath = path.join(this.taskResultsDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          if (
            data.taskId &&
            !this.processedResultIds.has(data.taskId) &&
            (data.status === "completed" || data.status === "failed")
          ) {
            this.processedResultIds.add(data.taskId);
            results.push(data as TaskResult);
            fs.unlinkSync(filePath);

            // 원본 task 파일도 상태 갱신
            const taskFile = path.join(this.tasksDir, `${data.taskId}.json`);
            if (fs.existsSync(taskFile)) {
              try {
                const task = JSON.parse(fs.readFileSync(taskFile, "utf-8"));
                task.status = data.status;
                task.completedAt = data.completedAt;
                fs.writeFileSync(taskFile, JSON.stringify(task, null, 2), "utf-8");
              } catch { /* 무시 */ }
            }
          }
        } catch { /* 파싱 실패 무시 */ }
      }
    } catch { /* 무시 */ }
    return results;
  }

  /** 만료된 pending task 감지 → 알림 대상 반환 */
  pollExpiredTasks(): { taskId: string; sourceChatId: number; sourceMessageId: number; instruction: string }[] {
    const expired: { taskId: string; sourceChatId: number; sourceMessageId: number; instruction: string }[] = [];
    try {
      if (!fs.existsSync(this.tasksDir)) return expired;
      const now = new Date();
      for (const file of fs.readdirSync(this.tasksDir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const task = JSON.parse(fs.readFileSync(path.join(this.tasksDir, file), "utf-8"));
          if (
            task.status === "pending" &&
            task.expiresAt &&
            new Date(task.expiresAt) < now &&
            !this.notifiedExpiredIds.has(task.taskId)
          ) {
            this.notifiedExpiredIds.add(task.taskId);
            // task 파일 상태 expired로 갱신
            task.status = "expired";
            fs.writeFileSync(path.join(this.tasksDir, file), JSON.stringify(task, null, 2), "utf-8");
            expired.push({
              taskId: task.taskId,
              sourceChatId: task.sourceChatId,
              sourceMessageId: task.sourceMessageId,
              instruction: task.instruction,
            });
          }
        } catch { /* 무시 */ }
      }
    } catch { /* 무시 */ }
    return expired;
  }

  /** 크래시된 세션 + 만료 task 정리 */
  cleanupStale(): void {
    // 만료된 pending task 처리
    try {
      const now = new Date();
      for (const file of fs.readdirSync(this.tasksDir)) {
        if (!file.endsWith(".json")) continue;
        const filePath = path.join(this.tasksDir, file);
        try {
          const task = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          if (task.status === "pending" && task.expiresAt && new Date(task.expiresAt) < now) {
            task.status = "timed_out";
            task.timedOutAt = now.toISOString();
            fs.writeFileSync(filePath, JSON.stringify(task, null, 2), "utf-8");
          }
        } catch { /* 무시 */ }
      }
    } catch { /* 무시 */ }
  }

  /** 만료된 pending/response 파일 정리 (스케줄러에서 호출) */
  cleanupExpired(): void {
    const now = Date.now();

    // 만료된 pending 파일 삭제
    try {
      for (const file of fs.readdirSync(this.pendingDir)) {
        const filePath = path.join(this.pendingDir, file);
        try {
          const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          if (
            content.expiresAt &&
            new Date(content.expiresAt).getTime() < now
          ) {
            fs.unlinkSync(filePath);
          }
        } catch {
          fs.unlinkSync(filePath); // 파싱 실패 → 삭제
        }
      }
    } catch {
      /* 디렉토리 없으면 무시 */
    }

    // 10분 이상 된 고아 response 파일 삭제
    try {
      for (const file of fs.readdirSync(this.responseDir)) {
        const filePath = path.join(this.responseDir, file);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > 10 * 60 * 1000) {
          fs.unlinkSync(filePath);
        }
      }
    } catch {
      /* 무시 */
    }
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}


function isSessionRecordFresh(session: VscSession, options: ActiveSessionSafetyOptions): boolean {
  const ttlMs = options.sessionTtlMs ?? DEFAULT_SESSION_RECORD_TTL_MS;
  if (ttlMs <= 0) return true;

  const basis = session.lastActivity ?? session.startedAt;
  const activityMs = Date.parse(basis ?? "");
  if (!Number.isFinite(activityMs)) return false;

  const nowMs = (options.now ?? new Date()).getTime();
  return nowMs - activityMs <= ttlMs;
}
function isActiveSnapshotFresh(snapshot: ActiveSessionSnapshot, options: ActiveSessionSafetyOptions): boolean {
  const ttlMs = options.ttlMs ?? DEFAULT_ACTIVE_SESSION_TTL_MS;
  if (ttlMs <= 0) return true;

  const heartbeatMs = Date.parse(snapshot.updatedAt ?? "");
  if (!Number.isFinite(heartbeatMs)) return false;

  const nowMs = (options.now ?? new Date()).getTime();
  return nowMs - heartbeatMs <= ttlMs;
}

function isVscSession(value: unknown): value is VscSession {
  const session = value as Partial<VscSession>;
  return typeof session.sessionId === "string"
    && typeof session.cwd === "string"
    && typeof session.projectName === "string"
    && typeof session.startedAt === "string"
    && (session.watcherPid === undefined || typeof session.watcherPid === "number")
    && (session.currentTask === undefined || typeof session.currentTask === "string")
    && (session.lastActivity === undefined || typeof session.lastActivity === "string")
    && (session.recentFiles === undefined || Array.isArray(session.recentFiles))
    && (session.status === undefined || session.status === "working" || session.status === "idle" || session.status === "offline");
}

function isBridgeTask(value: unknown): value is BridgeTask {
  const task = value as Partial<BridgeTask>;
  return typeof task.taskId === "string"
    && typeof task.requestedAt === "string"
    && typeof task.expiresAt === "string"
    && typeof task.sourceChatId === "number"
    && typeof task.sourceMessageId === "number"
    && typeof task.targetCwd === "string"
    && typeof task.instruction === "string"
    && typeof task.status === "string"
    && typeof task.resultFile === "string";
}
function isVscSessionEndEvent(value: unknown): value is VscSessionEndEvent {
  const event = value as Partial<VscSessionEndEvent>;
  return typeof event.id === "string"
    && typeof event.sessionId === "string"
    && typeof event.cwd === "string"
    && typeof event.projectName === "string"
    && typeof event.endedAt === "string"
    && (event.currentTask === undefined || typeof event.currentTask === "string")
    && (event.recentFiles === undefined || Array.isArray(event.recentFiles))
    && (event.summary === undefined || typeof event.summary === "string")
    && (event.remainingTasks === undefined || Array.isArray(event.remainingTasks));
}

