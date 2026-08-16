// 회의모드 핸들러 — 시작/메시지누적/종료 + Obsidian 저장
// 짐 호출 실패해도 파일 저장은 성공해야 함 (요약 섹션만 실패 메시지로 채움)

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  startMode,
  endMode,
  appendMessage,
  getModeSession,
  type BufferedMessage,
} from './mode-state.js';
import { summarizeWithJim } from './summarize.js';

const CAPTURE_ROOT = 'G:/내 드라이브/메모/OBSIDIAN_Memo/20_clo-capture/meeting';

export type SummaryMode = 'fast' | 'precise' | 'none';

export async function handleMeetingStart(chatId: number, argsText: string): Promise<string> {
  const existing = getModeSession(chatId);
  if (existing) {
    return `⚠️ 이미 ${existing.mode} 모드가 진행 중이에요. 먼저 \`/회의 종료\`로 끝내주세요.`;
  }
  const title = argsText.trim() || undefined;
  startMode(chatId, 'meeting', title);
  const titleSuffix = title ? ` — "${title}"` : '';
  return `🎤 회의모드 시작${titleSuffix}\n이후 메시지는 조용히 기록됩니다. \`/회의 종료\`로 끝내세요.`;
}

export async function handleMeetingMessage(
  chatId: number,
  msg: BufferedMessage,
): Promise<'captured' | 'ignored'> {
  return appendMessage(chatId, msg) ? 'captured' : 'ignored';
}

export interface MeetingEndResult {
  text: string;
  filePath: string | null;
}

export async function handleMeetingEnd(
  chatId: number,
  summaryMode: SummaryMode = 'fast',
): Promise<MeetingEndResult> {
  const session = endMode(chatId);
  if (!session || session.mode !== 'meeting') {
    return { text: '⚠️ 진행 중인 회의모드가 없어요.', filePath: null };
  }

  const startDate = new Date(session.startedAt);
  const endDate = new Date();
  const durationMin = Math.max(1, Math.round((endDate.getTime() - session.startedAt) / 60000));
  const msgCount = session.buffer.length;

  if (msgCount === 0) {
    return { text: '⚠️ 기록된 메시지가 없어서 저장 안 했어요.', filePath: null };
  }

  const yyyymmdd = formatYmd(startDate);
  const hhmm = `${pad2(startDate.getHours())}${pad2(startDate.getMinutes())}`;
  const titleSlug = session.meta?.title ? `_${sanitizeFilename(session.meta.title)}` : '';
  const filename = `${yyyymmdd}_${hhmm}${titleSlug}.md`;
  const filePath = path.join(CAPTURE_ROOT, filename);

  const transcript = session.buffer
    .map((m) => {
      const time = `${pad2(new Date(m.timestamp).getHours())}:${pad2(new Date(m.timestamp).getMinutes())}`;
      const voicePrefix = m.type === 'voice' ? '🎙 ' : '';
      const durationSuffix = m.type === 'voice' && m.originalVoiceDurationSec
        ? ` (${m.originalVoiceDurationSec}초)`
        : '';
      return `[${time}] ${voicePrefix}${m.content}${durationSuffix}`;
    })
    .join('\n');

  let summarySection = '';
  if (summaryMode === 'fast') {
    const summary = await summarizeWithJim(transcript, session.meta?.title);
    summarySection = `\n## 📝 요약 (짐)\n${summary}\n`;
  } else if (summaryMode === 'precise') {
    summarySection = `\n## 📝 요약 (정밀)\n_정밀 요약은 아직 미구현 — 짐 요약으로 대체_\n${await summarizeWithJim(transcript, session.meta?.title)}\n`;
  }

  const titleLine = session.meta?.title ? ` · ${session.meta.title}` : '';
  const content = [
    `# 회의록 — ${yyyymmdd} ${hhmm}${titleLine}`,
    `> 자동기록: 클로 | 참석자: 이사님 | ${durationMin}분 · 메시지 ${msgCount}개`,
    '',
    summarySection,
    '## 📝 전체 발언 기록',
    transcript,
    '',
  ].join('\n');

  fs.mkdirSync(CAPTURE_ROOT, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');

  const summaryPreview = summarySection ? `\n\n${summarySection.trim().slice(0, 300)}` : '';
  return {
    text: `✅ 회의 종료. ${durationMin}분 / 메시지 ${msgCount}개 기록.\n📄 저장: \`${filename}\`${summaryPreview}`,
    filePath,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatYmd(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function sanitizeFilename(s: string): string {
  return s.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 50);
}
