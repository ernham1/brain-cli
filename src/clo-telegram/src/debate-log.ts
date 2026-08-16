import fs from "node:fs";
import path from "node:path";

export interface DebateEntry {
  timestamp: string;
  sender: string;   // "클로", "제미", "사용자", 등
  text: string;
  human?: boolean;  // true = 사람 메시지, false/undefined = 봇 응답
  mentions?: string[]; // 멘션된 봇 이름 목록 (예: ["클로"])
  messageId?: number;  // 중복 방지용 Telegram message_id
}

const MAX_CONTEXT_ENTRIES = 20;

export class DebateLog {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = path.join(dataDir, "debate");
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  private filePath(chatId: number): string {
    return path.join(this.dataDir, `${chatId}.jsonl`);
  }

  /** messageId 또는 동일 sender+text(5초 이내, 사람 메시지만) 기준 중복 검사 후 skip */
  append(chatId: number, sender: string, text: string, mentions?: string[], messageId?: number, human?: boolean): void {
    if (messageId && this.hasEntry(chatId, messageId)) return;
    if (human && this.hasDuplicateText(chatId, sender, text, 5000)) return;

    const entry: DebateEntry = {
      timestamp: new Date().toISOString(),
      sender,
      text: text.slice(0, 1000),
      ...(human ? { human: true } : {}),
      ...(mentions && mentions.length > 0 ? { mentions } : {}),
      ...(messageId ? { messageId } : {}),
    };
    fs.appendFileSync(this.filePath(chatId), JSON.stringify(entry) + "\n", "utf-8");
  }

  /** 최근 항목에서 동일 messageId가 있는지 확인 */
  hasEntry(chatId: number, messageId: number): boolean {
    const file = this.filePath(chatId);
    if (!fs.existsSync(file)) return false;
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
    return lines.slice(-20).some((line) => {
      try {
        return (JSON.parse(line) as DebateEntry).messageId === messageId;
      } catch { return false; }
    });
  }

  /** 최근 windowMs 이내에 동일 sender + text 항목이 있는지 확인 */
  private hasDuplicateText(chatId: number, sender: string, text: string, windowMs: number): boolean {
    const file = this.filePath(chatId);
    if (!fs.existsSync(file)) return false;
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
    const cutoff = Date.now() - windowMs;
    return lines.slice(-20).some((line) => {
      try {
        const entry = JSON.parse(line) as DebateEntry;
        return (
          entry.sender === sender &&
          entry.text === text.slice(0, 1000) &&
          new Date(entry.timestamp).getTime() >= cutoff
        );
      } catch { return false; }
    });
  }

  /** 최근 N개 항목을 프롬프트용 문자열로 반환 (5초 내 동일 sender+text 중복 제거) */
  getContext(chatId: number, limit = MAX_CONTEXT_ENTRIES): string {
    const file = this.filePath(chatId);
    if (!fs.existsSync(file)) return "";

    const lines = fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
    const parsed = lines.map((line) => {
      try { return JSON.parse(line) as DebateEntry; } catch { return null; }
    }).filter(Boolean) as DebateEntry[];

    // 5초 이내 동일 sender+text 중복 제거 (race condition으로 생긴 파일 내 중복 흡수)
    const seen = new Set<string>();
    const deduped = parsed.filter((entry) => {
      const window = Math.floor(new Date(entry.timestamp).getTime() / 5000);
      const key = `${entry.sender}::${entry.text.slice(0, 100)}::${window}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const recent = deduped.slice(-limit);
    if (recent.length === 0) return "";

    return recent.map((entry) => {
      const time = new Date(entry.timestamp).toLocaleTimeString("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
      });
      const mentionStr = entry.mentions ? ` →${entry.mentions.join(",")}` : "";
      return `[${time}] ${entry.sender}${mentionStr}: ${entry.text}`;
    }).join("\n");
  }

  /** 최근 N개 항목 반환 (DebateWatcher 체인 체크용, 5초 내 중복 제거) */
  getRecentEntries(chatId: number, limit: number): DebateEntry[] {
    const file = this.filePath(chatId);
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
    const parsed = lines.map((line) => {
      try { return JSON.parse(line) as DebateEntry; } catch { return null; }
    }).filter(Boolean) as DebateEntry[];

    // 5초 이내 동일 sender+text 중복 제거 (raw 파일의 race condition 중복 흡수)
    const seen = new Set<string>();
    const deduped = parsed.filter((entry) => {
      const window = Math.floor(new Date(entry.timestamp).getTime() / 5000);
      const key = `${entry.sender}::${entry.text.slice(0, 100)}::${window}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return deduped.slice(-limit);
  }

  /** 마지막 항목 반환 */
  getLastEntry(chatId: number): DebateEntry | null {
    const file = this.filePath(chatId);
    if (!fs.existsSync(file)) return null;
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
    const last = lines[lines.length - 1];
    if (!last) return null;
    try {
      return JSON.parse(last) as DebateEntry;
    } catch {
      return null;
    }
  }

  /** 토론 로그가 있는 chatId 목록 반환 */
  getActiveChatIds(): number[] {
    try {
      return fs.readdirSync(this.dataDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => parseInt(f.replace(".jsonl", ""), 10))
        .filter((n) => !isNaN(n));
    } catch {
      return [];
    }
  }

  /** 오래된 항목 정리 (500줄 초과 시 최근 300개만 유지) */
  cleanup(chatId: number): void {
    const file = this.filePath(chatId);
    if (!fs.existsSync(file)) return;

    const lines = fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
    if (lines.length > 500) {
      fs.writeFileSync(file, lines.slice(-300).join("\n") + "\n", "utf-8");
    }
  }
}
