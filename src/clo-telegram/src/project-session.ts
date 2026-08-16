import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { VscSession } from "./bridge.js";

const DEFAULT_PROJECT_ROOT = "D:/Projects";
const PROJECT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_NOTIFY_SESSION_MS = 30_000;
const MAX_NOTIFY_ACTIVITY_AGE_MS = 6 * 60 * 60 * 1000;

export type ProjectSessionStatus = "active" | "handed_off" | "expired";
export type ProjectSessionOrigin = "teleclo" | "desktop";
export type DesktopSessionStatus = "working" | "idle" | "offline";

export interface DesktopSessionInfo {
  vscSessionId: string;
  currentTask?: string;
  lastActivity?: string;
  recentFiles?: string[];
  status: DesktopSessionStatus;
  startedAt?: string;
  endedAt?: string;
  summary?: string;
  remainingTasks?: string[];
}

export interface ProjectSession {
  projectPath: string;
  projectName: string;
  sdkSessionId: string;
  createdAt: string;
  lastActivityAt: string;
  taskCount: number;
  lastTaskSummary: string;
  status: ProjectSessionStatus;
  origin: ProjectSessionOrigin;
  claudeProjectStorePath: string;
  desktopSession?: DesktopSessionInfo;
  lastSessionEndNotifiedAt?: string;
  lastSessionEndNotifiedId?: string;
}

interface ProjectSessionFile {
  sessions: Record<string, ProjectSession>;
}

export interface DesktopSessionSyncResult {
  endedSessions: Array<{ vscSession: VscSession; projectSession: ProjectSession }>;
  activeSessions: ProjectSession[];
}

export interface DesktopSessionEndMessageOptions {
  reason: string;
  endedAt?: string;
  currentTask?: string;
  recentFiles?: string[];
  summary?: string;
  remainingTasks?: string[];
  workSummaryItems?: string[];
}

export interface ProjectStatusSnapshot {
  projectPath: string;
  projectName: string;
  status: ProjectSessionStatus;
  origin: ProjectSessionOrigin;
  sdkSessionId?: string;
  taskCount: number;
  lastTaskSummary?: string;
  lastActivityAt: string;
  claudeProjectStorePath: string;
  desktopSession?: DesktopSessionInfo;
}

export class ProjectSessionManager {
  private sessions = new Map<string, ProjectSession>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  getSession(projectPath: string): ProjectSession | null {
    return this.sessions.get(normalizeProjectPath(projectPath)) ?? null;
  }

  findByProjectName(projectName: string): ProjectSession | null {
    const name = projectName.trim().toLowerCase();
    if (!name) return null;

    const matches = Array.from(this.sessions.values())
      .filter(session => session.projectName.toLowerCase() === name)
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    return matches[0] ?? null;
  }

  ensureSession(projectPath: string, projectName: string, origin: ProjectSessionOrigin = "teleclo"): ProjectSession {
    const normalizedPath = normalizeProjectPath(projectPath);
    const existing = this.sessions.get(normalizedPath);
    if (existing) {
      existing.projectName = projectName || existing.projectName;
      existing.origin = existing.origin === "teleclo" ? "teleclo" : origin;
      if (existing.status === "expired") existing.status = "active";
      this.save();
      return existing;
    }

    const now = new Date().toISOString();
    const session: ProjectSession = {
      projectPath: normalizedPath,
      projectName,
      sdkSessionId: "",
      createdAt: now,
      lastActivityAt: now,
      taskCount: 0,
      lastTaskSummary: "",
      status: "active",
      origin,
      claudeProjectStorePath: getClaudeProjectStorePath(normalizedPath),
    };
    this.sessions.set(normalizedPath, session);
    this.save();
    return session;
  }

  updateAfterTask(projectPath: string, sdkSessionId: string, taskSummary: string): ProjectSession {
    const normalizedPath = normalizeProjectPath(projectPath);
    const session = this.ensureSession(normalizedPath, path.basename(normalizedPath), "teleclo");
    session.sdkSessionId = sdkSessionId || session.sdkSessionId;
    session.lastActivityAt = new Date().toISOString();
    session.taskCount += 1;
    session.lastTaskSummary = summarizeTask(taskSummary);
    session.status = "active";
    session.origin = "teleclo";
    session.claudeProjectStorePath = getClaudeProjectStorePath(normalizedPath);
    this.save();
    return session;
  }

  markHandedOff(projectPath: string): ProjectSession | null {
    const session = this.getSession(projectPath);
    if (!session) return null;
    session.status = "handed_off";
    session.lastActivityAt = new Date().toISOString();
    this.save();
    return session;
  }

  markDesktopOffline(projectPath: string, vscSessionId?: string): ProjectSession | null {
    const session = this.getSession(projectPath);
    if (!session?.desktopSession) return session;
    if (vscSessionId && session.desktopSession.vscSessionId !== vscSessionId) return session;
    const endedAt = new Date().toISOString();
    session.desktopSession.status = "offline";
    session.desktopSession.endedAt = endedAt;
    session.lastActivityAt = endedAt;
    this.save();
    return session;
  }

  syncDesktopSession(projectPath: string, info: DesktopSessionInfo, projectName = path.basename(projectPath)): ProjectSession {
    const session = this.ensureSession(projectPath, projectName, "desktop");
    session.desktopSession = {
      ...info,
      recentFiles: dedupeRecentFiles(info.recentFiles ?? []),
      status: info.status,
    };
    session.lastActivityAt = info.endedAt ?? info.lastActivity ?? new Date().toISOString();
    session.projectName = projectName || session.projectName;
    session.claudeProjectStorePath = getClaudeProjectStorePath(session.projectPath);
    if (info.status !== "offline" && session.origin === "teleclo" && session.status === "active") {
      session.status = "handed_off";
    }
    this.save();
    return session;
  }

  syncDesktopSessions(vscSessions: VscSession[]): DesktopSessionSyncResult {
    const currentByKey = new Set(vscSessions.map(session => desktopKey(session.cwd, session.sessionId)));
    const endedSessions: Array<{ vscSession: VscSession; projectSession: ProjectSession }> = [];

    for (const session of this.sessions.values()) {
      const desktop = session.desktopSession;
      if (!desktop || desktop.status === "offline") continue;
      const key = desktopKey(session.projectPath, desktop.vscSessionId);
      if (currentByKey.has(key)) continue;

      const vscSession: VscSession = {
        sessionId: desktop.vscSessionId,
        cwd: session.projectPath,
        projectName: session.projectName,
        startedAt: desktop.startedAt ?? session.createdAt,
        currentTask: desktop.currentTask,
        lastActivity: desktop.lastActivity,
        recentFiles: desktop.recentFiles,
        status: desktop.status,
      };
      const endedAt = new Date().toISOString();
      session.desktopSession = { ...desktop, status: "offline", endedAt };
      session.lastActivityAt = endedAt;
      endedSessions.push({ vscSession, projectSession: { ...session } });
    }

    const activeSessions: ProjectSession[] = [];
    for (const vscSession of vscSessions) {
      activeSessions.push(this.syncDesktopSession(vscSession.cwd, {
        vscSessionId: vscSession.sessionId,
        currentTask: vscSession.currentTask,
        lastActivity: vscSession.lastActivity ?? new Date().toISOString(),
        recentFiles: vscSession.recentFiles ?? [],
        status: normalizeDesktopStatus(vscSession.status),
        startedAt: vscSession.startedAt,
      }, vscSession.projectName));
    }

    if (endedSessions.length > 0) this.save();
    return { endedSessions, activeSessions };
  }

  shouldNotifySessionEnd(vscSession: VscSession, projectSession?: ProjectSession | null): boolean {
    if (!projectSession?.desktopSession) return false;
    const desktop = projectSession.desktopSession;
    if (!desktop.recentFiles?.length && !desktop.currentTask) return false;
    if (projectSession.status === "handed_off") return false;
    if (projectSession.lastSessionEndNotifiedId === vscSession.sessionId) return false;
    if (!isReportableProjectPath(projectSession.projectPath)) return false;

    const lastActivityMs = Date.parse(desktop.lastActivity ?? vscSession.lastActivity ?? "");
    if (Number.isFinite(lastActivityMs) && Date.now() - lastActivityMs > MAX_NOTIFY_ACTIVITY_AGE_MS) return false;

    const startedMs = Date.parse(vscSession.startedAt);
    if (Number.isFinite(startedMs) && Date.now() - startedMs < MIN_NOTIFY_SESSION_MS) return false;
    return true;
  }

  markSessionEndNotified(projectPath: string, vscSessionId: string): void {
    const session = this.getSession(projectPath);
    if (!session) return;
    session.lastSessionEndNotifiedAt = new Date().toISOString();
    session.lastSessionEndNotifiedId = vscSessionId;
    this.save();
  }

  pruneExpired(now = Date.now()): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.status === "expired") continue;
      const lastMs = Date.parse(session.lastActivityAt);
      if (Number.isFinite(lastMs) && now - lastMs > PROJECT_SESSION_TTL_MS) {
        session.status = "expired";
        count += 1;
      }
    }
    if (count > 0) this.save();
    return count;
  }

  resolveProjectFromText(text: string, options: { projectRoot?: string; aliasFile?: string } = {}): ProjectStatusSnapshot | null {
    const resolved = resolveProjectPathFromText(text, options);
    if (resolved) {
      const session = this.getSession(resolved.projectPath)
        ?? this.findByProjectName(resolved.projectName)
        ?? this.ensureSession(resolved.projectPath, resolved.projectName, "desktop");
      return toStatusSnapshot(session);
    }

    const mentioned = findMentionedExistingSession(text, Array.from(this.sessions.values()));
    return mentioned ? toStatusSnapshot(mentioned) : null;
  }

  formatStatus(snapshot: ProjectStatusSnapshot): string {
    const displayName = formatProjectDisplayName(snapshot.projectPath, snapshot.projectName);
    const lines = [
      `📌 ${displayName} 상태`,
      `- 경로: ${snapshot.projectPath}`,
      `- 세션 상태: ${formatSessionStatus(snapshot.status, snapshot.origin)}`,
      `- 텔레클로 작업 수: ${snapshot.taskCount}`,
      `- 마지막 활동: ${snapshot.lastActivityAt}`,
      `- Claude 세션 저장소: ${snapshot.claudeProjectStorePath}`,
    ];
    if (snapshot.lastTaskSummary) lines.push(`- 마지막 텔레클로 작업: ${snapshot.lastTaskSummary}`);
    if (snapshot.sdkSessionId) lines.push(`- SDK session_id: ${snapshot.sdkSessionId}`);
    if (snapshot.desktopSession) {
      lines.push("");
      lines.push("## 데탑클로");
      lines.push(`- 상태: ${snapshot.desktopSession.status}`);
      if (snapshot.desktopSession.currentTask) {
        lines.push(`- 현재 작업: ${formatDesktopTaskSummary(snapshot.desktopSession.currentTask, snapshot.projectPath)}`);
      }
      if (snapshot.desktopSession.lastActivity) lines.push(`- 최근 활동: ${snapshot.desktopSession.lastActivity}`);
      if (snapshot.desktopSession.recentFiles?.length) {
        lines.push(`- 최근 파일: ${formatRecentFiles(snapshot.projectPath, snapshot.desktopSession.recentFiles, 6).join(", ")}`);
      }
      if (snapshot.desktopSession.summary) lines.push(`- 종료 요약: ${snapshot.desktopSession.summary}`);
    }
    return lines.join("\n");
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as ProjectSessionFile;
      this.sessions = new Map(Object.entries(data.sessions ?? {}).map(([key, value]) => [key, value]));
    } catch {
      this.sessions = new Map();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const data: ProjectSessionFile = { sessions: Object.fromEntries(this.sessions) };
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
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

export function projectSessionKey(projectPath: string): string {
  return `project:${normalizeProjectPath(projectPath).toLowerCase()}`;
}

export function normalizeProjectPath(projectPath: string): string {
  return path.resolve(projectPath).replace(/\\/g, "/");
}

export function getClaudeProjectStorePath(projectPath: string, claudeHome = path.join(os.homedir(), ".claude")): string {
  const normalized = normalizeProjectPath(projectPath);
  const slug = normalized.replace(/[:/\\]/g, "-").replace(/^-+/, "");
  return path.join(claudeHome, "projects", slug);
}

export function isReportableProjectPath(projectPath: string): boolean {
  const normalized = normalizeProjectPath(projectPath).toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  const projectsIndex = segments.findIndex((segment) => segment === "projects");
  if (projectsIndex < 0 || projectsIndex === segments.length - 1) return false;
  return ![
    "/node_modules/",
    "/test-results/",
    "/playwright-report/",
    "/.git/",
  ].some((fragment) => normalized.includes(fragment));
}

export function formatProjectDisplayName(projectPath: string, projectName = ""): string {
  const normalized = normalizeProjectPath(projectPath);
  const segments = normalized.split("/").filter(Boolean);
  const projectsIndex = segments.findIndex((segment) => segment.toLowerCase() === "projects");
  if (projectsIndex >= 0) {
    const first = segments[projectsIndex + 1];
    const second = segments[projectsIndex + 2];
    const third = segments[projectsIndex + 3];
    const fourth = segments[projectsIndex + 4];
    if (first === "지원사업" && second) {
      const nested = third && ["source", "src", "apps", "packages", "demo"].includes(third.toLowerCase())
        ? fourth
        : undefined;
      return nested ? `${second} / ${nested}` : second;
    }

    if (first) {
      const nested = second && ["source", "src", "apps", "packages", "demo"].includes(second.toLowerCase())
        ? third
        : undefined;
      return nested ? `${first} / ${nested}` : first;
    }
  }

  return projectName.trim() || path.basename(normalized);
}

export function formatProjectRelativePath(projectPath: string): string {
  const normalized = normalizeProjectPath(projectPath);
  const segments = normalized.split("/").filter(Boolean);
  const projectsIndex = segments.findIndex((segment) => segment.toLowerCase() === "projects");
  if (projectsIndex >= 0 && projectsIndex < segments.length - 1) {
    return segments.slice(projectsIndex + 1).join("/");
  }
  return normalized;
}

export function formatDesktopTaskSummary(currentTask: string, projectPath: string): string {
  const compactTask = compactText(currentTask, 220);
  const match = /^([^:]{1,40}):\s*(.*)$/s.exec(compactTask);
  if (!match) return compactTask;

  const toolName = match[1].trim();
  const detail = match[2].trim();
  if (["Edit", "MultiEdit"].includes(toolName)) return `파일 수정: ${formatRelativeFile(projectPath, detail)}`;
  if (toolName === "Write") return `파일 작성: ${formatRelativeFile(projectPath, detail)}`;
  if (toolName === "Read") return `파일 확인: ${formatRelativeFile(projectPath, detail)}`;
  if (toolName === "Bash") return `명령 실행: ${sanitizeCommand(detail || "명령 실행")}`;
  return detail ? `${toolName}: ${formatRelativeFile(projectPath, detail)}` : toolName;
}

export function formatRecentFiles(projectPath: string, files: string[], max = 4): string[] {
  const result: string[] = [];
  for (const file of files) {
    const relative = formatRelativeFile(projectPath, file);
    if (!relative || result.includes(relative)) continue;
    result.push(relative);
  }
  return result.slice(-max);
}

export function formatDesktopSessionEndMessage(
  projectSession: ProjectSession,
  options: DesktopSessionEndMessageOptions,
): string {
  const desktop = projectSession.desktopSession;
  const displayName = formatProjectDisplayName(projectSession.projectPath, projectSession.projectName);
  const currentTask = options.currentTask ?? desktop?.currentTask ?? "";
  const recentFiles = (options.recentFiles?.length ? options.recentFiles : desktop?.recentFiles) ?? [];
  const summary = String(options.summary ?? desktop?.summary ?? "").trim();
  const remainingTasks = normalizeRemainingTasks(options.remainingTasks?.length ? options.remainingTasks : desktop?.remainingTasks);
  const workSummaryItems = normalizeWorkSummaryItems(
    options.workSummaryItems?.length
      ? options.workSummaryItems
      : buildWorkSummaryItems(summary, currentTask, recentFiles, projectSession.projectPath),
  );

  const lines = [
    "종료메시지: 데탑클로 세션 종료를 감지했습니다.",
    `프로젝트명칭: ${displayName}`,
    "작업내용요약:",
    ...workSummaryItems.map((item) => `- ${item}`),
    "남은작업목록:",
    ...remainingTasks.map((task) => `- ${task}`),
  ];

  return lines.join("\n");
}

export function isProjectStatusQuery(text: string): boolean {
  return /(지금|현재|최근|마지막).*(뭐|어디|상태|작업|진행)|어디까지|작업\s*상태|마지막\s*작업/.test(text);
}

export function resolveProjectPathFromText(
  text: string,
  options: { projectRoot?: string; aliasFile?: string } = {},
): { projectName: string; projectPath: string } | null {
  const absoluteProject = resolveAbsoluteProjectPathFromText(text);
  if (absoluteProject) return absoluteProject;

  const projectRoot = options.projectRoot ?? process.env.CLO_PROJECT_ROOT ?? DEFAULT_PROJECT_ROOT;
  const aliases = loadAliases(options.aliasFile);
  const lower = text.replace(/\b(?:https?|ftp):\/\/[^\s"'<>]+/gi, " ").toLowerCase();

  for (const [alias, projectName] of Object.entries(aliases)) {
    if (lower.includes(alias.toLowerCase())) {
      const projectPath = path.join(projectRoot, projectName);
      if (fs.existsSync(projectPath)) return { projectName, projectPath: normalizeProjectPath(projectPath) };
    }
  }

  const projectNames = listProjectNames(projectRoot);
  for (const projectName of projectNames) {
    if (lower.includes(projectName.toLowerCase())) {
      return { projectName, projectPath: normalizeProjectPath(path.join(projectRoot, projectName)) };
    }
  }

  const explicit = /@D\s+["'“”‘’]?([A-Za-z0-9_.-]{2,80})["'“”‘’]?/i.exec(text)
    ?? /["'“”‘’]?([A-Za-z0-9_.-]{2,80})["'“”‘’]?\s*(?:프로젝트|에서|에)/i.exec(text);
  const candidate = explicit?.[1];
  if (candidate) {
    const projectPath = path.join(projectRoot, candidate);
    if (fs.existsSync(projectPath)) return { projectName: candidate, projectPath: normalizeProjectPath(projectPath) };
  }

  return null;
}

function resolveAbsoluteProjectPathFromText(text: string): { projectName: string; projectPath: string } | null {
  for (const rawCandidate of extractAbsolutePathCandidates(text)) {
    for (const candidate of buildAbsolutePathVariants(rawCandidate)) {
      if (!fs.existsSync(candidate)) continue;
      const projectPath = normalizeProjectPath(candidate);
      return {
        projectName: path.basename(projectPath),
        projectPath,
      };
    }
  }
  return null;
}

function extractAbsolutePathCandidates(text: string): string[] {
  const candidates: string[] = [];
  const quotedPathPattern = /["'“”‘’]((?:[A-Za-z]:[\\/]|\/\/)[^"'“”‘’]+)["'“”‘’]/g;
  const unquotedPathPattern = /(?:^|[\s([{<])((?:[A-Za-z]:[\\/]|\/\/)[^\s"'“”‘’<>|?*]+)/g;

  for (const match of text.matchAll(quotedPathPattern)) {
    if (match[1]) candidates.push(match[1]);
  }
  for (const match of text.matchAll(unquotedPathPattern)) {
    if (match[1]) candidates.push(match[1]);
  }
  return [...new Set(candidates)];
}

function buildAbsolutePathVariants(rawPath: string): string[] {
  const cleaned = rawPath
    .trim()
    .replace(/^[（("'“”‘’]+/, "")
    .replace(/[）)"'“”‘’,，.。;；:：!?！？]+$/u, "");
  const variants = [cleaned];
  const suffixes = ["에서", "으로", "에게", "부터", "까지", "로", "에", "을", "를", "은", "는"];

  for (const suffix of suffixes) {
    if (cleaned.endsWith(suffix)) {
      variants.push(cleaned.slice(0, -suffix.length));
    }
  }

  return [...new Set(variants.filter(Boolean))];
}
function toStatusSnapshot(session: ProjectSession): ProjectStatusSnapshot {
  return {
    projectPath: session.projectPath,
    projectName: session.projectName,
    status: session.status,
    origin: session.origin,
    sdkSessionId: session.sdkSessionId || undefined,
    taskCount: session.taskCount,
    lastTaskSummary: session.lastTaskSummary || undefined,
    lastActivityAt: session.lastActivityAt,
    claudeProjectStorePath: session.claudeProjectStorePath,
    desktopSession: session.desktopSession,
  };
}

function findMentionedExistingSession(text: string, sessions: ProjectSession[]): ProjectSession | null {
  const lower = text.toLowerCase();
  return sessions
    .filter(session => lower.includes(session.projectName.toLowerCase()))
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0] ?? null;
}

function summarizeTask(taskSummary: string): string {
  return taskSummary.replace(/\s+/g, " ").trim().slice(0, 240);
}

function compactText(value: string, max = 160): string {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function buildWorkSummaryItems(summary: string, currentTask: string, recentFiles: string[], projectPath: string): string[] {
  const summaryItems = extractSummaryItems(summary);
  if (summaryItems.length > 0) return summaryItems;
  if (currentTask) return [formatDesktopTaskSummary(currentTask, projectPath)];

  const formattedFiles = formatRecentFiles(projectPath, recentFiles, 3);
  if (formattedFiles.length > 0) return formattedFiles.map((file) => `파일 작업: ${file}`);

  return ["저장된 작업 요약 없음"];
}

function extractSummaryItems(summary: string): string[] {
  const text = String(summary || "").trim();
  if (!text) return [];

  const jsonSummaryMatches = extractJsonStringFieldValues(text, "summary");
  if (jsonSummaryMatches.length > 0) return normalizeWorkSummaryItems(jsonSummaryMatches);

  const bulletItems = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*•]\s+/.test(line))
    .map((line) => line.replace(/^[-*•]\s+/, ""));
  if (bulletItems.length > 0) return normalizeWorkSummaryItems(bulletItems);

  return normalizeWorkSummaryItems([text]);
}

function normalizeWorkSummaryItems(items: string[]): string[] {
  const result: string[] = [];
  for (const item of items) {
    const normalized = compactText(item.replace(/^[-*•]\s*/, "").replace(/^\[[ xX]\]\s*/, ""), 160);
    if (!normalized || result.includes(normalized)) continue;
    result.push(normalized);
  }

  return result.length > 0 ? result.slice(0, 7) : ["저장된 작업 요약 없음"];
}

function unescapeJsonish(value: string): string {
  return value
    .replace(/\\"/g, "\"")
    .replace(/\\n/g, " ")
    .replace(/\\r/g, " ")
    .replace(/\\t/g, " ");
}

function extractJsonStringFieldValues(text: string, fieldName: string): string[] {
  const values: string[] = [];
  const source = String(text || "");
  const fieldTokens = [`"${fieldName}"`, `'${fieldName}'`];
  let cursor = 0;

  while (cursor < source.length) {
    const matches = fieldTokens
      .map((token) => ({ token, index: source.indexOf(token, cursor) }))
      .filter((item) => item.index >= 0)
      .sort((a, b) => a.index - b.index);
    const next = matches[0];
    if (!next) break;

    let index = next.index + next.token.length;
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (source[index] !== ":") {
      cursor = next.index + next.token.length;
      continue;
    }

    index += 1;
    while (/\s/.test(source[index] ?? "")) index += 1;
    const quote = source[index];
    if (quote !== "\"" && quote !== "'") {
      cursor = index + 1;
      continue;
    }
    index += 1;

    let value = "";
    let escaped = false;

    for (; index < source.length; index += 1) {
      const char = source[index];
      if (escaped) {
        value += `\\${char}`;
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        index += 1;
        break;
      }
      value += char;
    }

    if (value.trim()) values.push(unescapeJsonish(value));
    cursor = index;
  }

  return values;
}

function normalizeRemainingTasks(tasks: string[] | undefined): string[] {
  const result: string[] = [];
  for (const task of tasks ?? []) {
    const normalized = compactText(task.replace(/^[-*•]\s*/, "").replace(/^\[[ xX]\]\s*/, ""), 120);
    if (!normalized || result.includes(normalized)) continue;
    result.push(normalized);
  }

  return result.length > 0
    ? result.slice(0, 5)
    : ["세션 종료 요약에서 명시된 남은 작업 없음"];
}

function sanitizeCommand(command: string): string {
  return compactText(command, 160)
    .replace(/\b(token|api[_-]?key|secret|password|passwd)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi, "$1=***")
    .replace(/--(token|api-key|secret|password)\s+("[^"]*"|'[^']*'|\S+)/gi, "--$1 ***");
}

function formatRelativeFile(projectPath: string, filePath: string): string {
  const normalizedProject = normalizeProjectPath(projectPath);
  const normalizedFile = normalizeFilePath(filePath);
  if (!normalizedFile) return "";

  const lowerFile = normalizedFile.toLowerCase();
  const lowerProject = normalizedProject.toLowerCase();
  if (lowerFile.startsWith(`${lowerProject}/`)) return normalizedFile.slice(normalizedProject.length + 1);

  const projectRoot = normalizeProjectPath(DEFAULT_PROJECT_ROOT);
  const rootLower = projectRoot.toLowerCase();
  if (lowerFile.startsWith(`${rootLower}/`)) return normalizedFile.slice(projectRoot.length + 1);

  return normalizedFile;
}

function normalizeFilePath(filePath: string): string {
  const normalized = String(filePath || "").replace(/\\/g, "/").trim();
  if (!normalized) return "";
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/")) {
    return path.resolve(normalized).replace(/\\/g, "/");
  }
  return normalized;
}

function loadAliases(aliasFile = path.join(process.cwd(), "data", "project-aliases.json")): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(aliasFile, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function listProjectNames(projectRoot: string): string[] {
  try {
    return fs.readdirSync(projectRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((a, b) => b.length - a.length);
  } catch {
    return [];
  }
}

function dedupeRecentFiles(files: string[]): string[] {
  const result: string[] = [];
  for (const file of files) {
    const normalized = String(file).replace(/\\/g, "/").trim();
    if (!normalized || result.includes(normalized)) continue;
    result.push(normalized);
  }
  return result.slice(-12);
}

function desktopKey(projectPath: string, sessionId: string): string {
  return `${normalizeProjectPath(projectPath).toLowerCase()}::${sessionId}`;
}

function normalizeDesktopStatus(status: unknown): DesktopSessionStatus {
  return status === "idle" || status === "offline" ? status : "working";
}

function formatSessionStatus(status: ProjectSessionStatus, origin: ProjectSessionOrigin): string {
  if (status === "handed_off") return "VS Code 인계됨";
  if (status === "expired") return "만료됨";
  return origin === "teleclo" ? "텔레클로 프로젝트 세션 활성" : "데탑클로 세션 추적 중";
}
