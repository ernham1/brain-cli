import fs from "node:fs";
import path from "node:path";

export interface MediaRef {
  messageId: number;
  fileId: string;
  type: "video" | "photo" | "animation" | "video_note";
  senderId?: number;
  senderName?: string;
  caption?: string;
  fileSize?: number;
  timestamp: number;
}

const MAX_PER_CHAT = 20;
const SAVE_DEBOUNCE_MS = 1000;

/**
 * 채팅별 최근 미디어 레퍼런스를 추적합니다.
 * 인메모리 + JSON 파일로 영속화하여 봇 재시작 후에도 유지.
 */
export class MediaTracker {
  private store = new Map<number, MediaRef[]>();
  private filePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "media-tracker.json");
    this.load();
  }

  /** 미디어 레퍼런스 추가 (기존 분석 로직과 무관하게 항상 호출) */
  track(chatId: number, ref: MediaRef): void {
    const list = this.store.get(chatId) ?? [];
    list.push(ref);
    // 오래된 것 제거 (FIFO)
    if (list.length > MAX_PER_CHAT) {
      list.splice(0, list.length - MAX_PER_CHAT);
    }
    this.store.set(chatId, list);
    this.scheduleSave();
  }

  /** 최근 미디어 검색. type이 있으면 해당 타입 우선, 없으면 최신 아무거나 */
  findRecent(chatId: number, type?: string): MediaRef | null {
    const list = this.store.get(chatId);
    if (!list || list.length === 0) return null;

    if (type) {
      // video 타입 요청이면 video, animation, video_note 모두 포함
      const videoTypes = ["video", "animation", "video_note"];
      const isVideoRequest = type === "video";

      for (let i = list.length - 1; i >= 0; i--) {
        if (isVideoRequest ? videoTypes.includes(list[i].type) : list[i].type === type) {
          return list[i];
        }
      }
    }

    // 타입 매치 없거나 타입 미지정이면 가장 최근 것
    return list[list.length - 1];
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as Record<string, MediaRef[]>;
        for (const [key, refs] of Object.entries(raw)) {
          this.store.set(Number(key), refs);
        }
        console.log(`[Clo] 미디어 트래커 로드: ${this.store.size}개 채팅`);
      }
    } catch {
      console.error("[Clo] 미디어 트래커 로드 실패, 빈 상태로 시작");
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const obj: Record<string, MediaRef[]> = {};
      for (const [chatId, refs] of this.store) {
        obj[String(chatId)] = refs;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), "utf-8");
    } catch (err) {
      console.error("[Clo] 미디어 트래커 저장 실패:", err);
    }
  }
}
