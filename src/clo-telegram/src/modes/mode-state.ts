// 캡처 모드 chatId별 세션 상태 저장소
// MVP: meeting 모드만 — 확장 시 ModeType에 'memo' | 'idea' | 'draft' 추가

export type ModeType = 'meeting';

export interface BufferedMessage {
  timestamp: number;
  type: 'text' | 'voice';
  content: string;
  originalVoiceDurationSec?: number;
}

export interface ModeSession {
  mode: ModeType;
  startedAt: number;
  buffer: BufferedMessage[];
  meta?: { title?: string };
}

const sessions = new Map<number, ModeSession>();

export function getModeSession(chatId: number): ModeSession | null {
  return sessions.get(chatId) ?? null;
}

export function startMode(chatId: number, mode: ModeType, title?: string): ModeSession {
  const session: ModeSession = {
    mode,
    startedAt: Date.now(),
    buffer: [],
    meta: { title },
  };
  sessions.set(chatId, session);
  return session;
}

export function endMode(chatId: number): ModeSession | null {
  const session = sessions.get(chatId);
  if (!session) return null;
  sessions.delete(chatId);
  return session;
}

export function appendMessage(chatId: number, msg: BufferedMessage): boolean {
  const session = sessions.get(chatId);
  if (!session) return false;
  session.buffer.push(msg);
  return true;
}

export function isInMode(chatId: number): boolean {
  return sessions.has(chatId);
}
