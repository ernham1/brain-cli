import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "./providers.js";

export interface SessionData {
  chatId: number;
  userId?: number;
  history: ChatMessage[];
  createdAt: string;
  lastMessageAt: string;
}

const MAX_MESSAGES = 40; // 최근 20턴 유지

/** 세션 키 생성: 그룹은 userId_chatId, DM은 chatId */
export function makeSessionKey(chatId: number, userId?: number): string {
  if (userId != null && userId !== chatId) {
    return `${userId}_${chatId}`;
  }
  return `${chatId}`;
}

export class SessionManager {
  private dir: string;

  constructor(sessionDir: string) {
    this.dir = sessionDir;
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  private filePath(sessionKey: string): string {
    return path.join(this.dir, `${sessionKey}.json`);
  }

  load(sessionKey: string): SessionData | null {
    const p = this.filePath(sessionKey);
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as SessionData;
    } catch {
      return null;
    }
  }

  save(session: SessionData): void {
    const key = makeSessionKey(session.chatId, session.userId);
    fs.writeFileSync(
      this.filePath(key),
      JSON.stringify(session, null, 2),
      "utf-8",
    );
  }

  reset(sessionKey: string): void {
    const p = this.filePath(sessionKey);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  getOrCreate(chatId: number, userId?: number): SessionData {
    const key = makeSessionKey(chatId, userId);
    const existing = this.load(key);
    if (existing && Array.isArray(existing.history)) return existing;

    return {
      chatId,
      userId,
      history: [],
      createdAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
    };
  }

  trimHistory(session: SessionData): void {
    if (session.history.length > MAX_MESSAGES) {
      session.history = session.history.slice(-MAX_MESSAGES);
    }
  }
}
