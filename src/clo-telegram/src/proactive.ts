import * as fs from "node:fs";
import * as path from "node:path";

// --- 타입 ---

export type ProactiveMessageType =
  | "weather_health"
  | "work_checkin"
  | "conversation_followup"
  | "emotional_support"
  | "random_natural"
  | "market_insight";

export interface ProactiveConfig {
  enabled: boolean;
  maxDailyMessages: number;
  minIntervalMinutes: number;
  activeHoursStart: number;
  activeHoursEnd: number;
  ownerChatId: number;       // 이사님 DM
  groupChatId: number | null; // 가족 그룹 (없으면 null)
}

interface ProactiveState {
  todaySentCount: number;
  lastSentAt: number;        // timestamp ms
  lastDate: string;          // "YYYY-MM-DD"
  recentTypes: string[];     // 최근 보낸 타입 (중복 방지, 최대 5개)
}

// --- 시간대별 확률 가중치 ---

const HOUR_WEIGHTS: Record<number, number> = {
  8: 0.4, 9: 0.5, 10: 0.3,
  11: 0.15, 12: 0.25, 13: 0.2,
  14: 0.15, 15: 0.25, 16: 0.2,
  17: 0.15, 18: 0.2, 19: 0.15,
  20: 0.1, 21: 0.05,
};

// --- ProactiveEngine ---

export class ProactiveEngine {
  private config: ProactiveConfig;
  private state: ProactiveState;
  private statePath: string;

  constructor(config: ProactiveConfig, dataDir: string) {
    this.config = config;
    this.statePath = path.join(dataDir, "proactive-state.json");
    this.state = this.loadState();
  }

  /** 지금 proactive 메시지를 보낼 시점인지 판단 */
  shouldSendNow(hour: number, _minute: number): boolean {
    if (!this.config.enabled) return false;

    // 활성 시간 체크
    if (hour < this.config.activeHoursStart || hour >= this.config.activeHoursEnd) {
      return false;
    }

    // 날짜 리셋
    const today = this.todayKey();
    if (this.state.lastDate !== today) {
      this.state.todaySentCount = 0;
      this.state.lastDate = today;
      this.state.recentTypes = [];
      this.saveState();
    }

    // 일일 한도 체크
    if (this.state.todaySentCount >= this.config.maxDailyMessages) {
      return false;
    }

    // 최소 간격 체크
    const elapsed = (Date.now() - this.state.lastSentAt) / 60_000;
    if (elapsed < this.config.minIntervalMinutes) {
      return false;
    }

    // 시간대별 확률 가중치
    const weight = HOUR_WEIGHTS[hour] ?? 0.1;
    return Math.random() < weight;
  }

  /** 어떤 타입의 메시지를 보낼지 선택 */
  selectMessageType(weatherInfo: string | null, brainContext: string): ProactiveMessageType {
    const candidates: ProactiveMessageType[] = [];

    // 날씨가 눈에 띄면 weather_health 우선
    if (weatherInfo && this.isNotableWeather(weatherInfo)) {
      candidates.push("weather_health");
    }

    // Brain에 진행 중 프로젝트/바쁜 시기 정보가 있으면
    if (brainContext.includes("바쁜") || brainContext.includes("마감") || brainContext.includes("진행")) {
      candidates.push("work_checkin");
      candidates.push("emotional_support");
    }

    // 대화 후속 가능성
    if (brainContext.includes("핸드오프") || brainContext.includes("세션")) {
      candidates.push("conversation_followup");
    }

    // 토크업/사업 관련 맥락이 있으면 market_insight
    if (brainContext.includes("토크업") || brainContext.includes("Talkup") ||
        brainContext.includes("수익화") || brainContext.includes("시장")) {
      candidates.push("market_insight");
    }

    // 기본값
    candidates.push("random_natural");

    // 최근에 보낸 타입 제외
    const filtered = candidates.filter(
      (t) => !this.state.recentTypes.includes(t),
    );
    const pool = filtered.length > 0 ? filtered : candidates;

    return pool[Math.floor(Math.random() * pool.length)];
  }

  /** LLM에 넘길 proactive context 생성 */
  buildContext(
    type: ProactiveMessageType,
    targetName: string,
    brainContext: string,
    weatherInfo: string | null,
    kstHour: number,
    lastMessageAt: string | null = null,
  ): string {
    const timeLabel = kstHour < 12 ? "오전" : kstHour < 18 ? "오후" : "저녁";

    let context = `## 먼저 말 걸기 모드\n`;
    context += `- 메시지 유형: ${type}\n`;
    context += `- 수신 대상: ${targetName}\n`;
    context += `- 현재 시간: ${timeLabel} ${kstHour}시 (KST)\n`;

    // 마지막 대화 시점 정보 — 세션 기록 우선, 없으면 proactive 발송 기록 사용
    const lastTs = lastMessageAt
      ? new Date(lastMessageAt).getTime()
      : this.state.lastSentAt > 0 ? this.state.lastSentAt : null;

    if (lastTs) {
      const elapsedMin = Math.floor((Date.now() - lastTs) / 60_000);
      if (elapsedMin < 60) {
        context += `- 마지막 대화: ${elapsedMin}분 전 (매우 최근, 새 안부가 아니면 [SKIP])\n`;
      } else if (elapsedMin < 180) {
        context += `- 마지막 대화: ${Math.floor(elapsedMin / 60)}시간 전 (가볍게 안부, 이전 질문 재답변 금지)\n`;
      } else {
        context += `- 마지막 대화: ${Math.floor(elapsedMin / 60)}시간 전 (충분히 시간이 지났으니 자연스럽게 먼저 말 걸기)\n`;
      }
    } else {
      context += `- 마지막 대화: 기록 없음 (처음 말 거는 느낌으로)\n`;
    }

    // 시간대별 톤 가이드
    context += `\n## 시간대별 톤 가이드\n`;
    if (kstHour >= 8 && kstHour < 10) {
      context += `아침 시간 — 하루 시작하는 가벼운 인사 톤. 활기차고 짧게. "좋은 아침" 느낌.\n`;
    } else if (kstHour >= 10 && kstHour < 12) {
      context += `오전 업무 시간 — 집중 중일 수 있으니 짧고 핵심적으로. 방해가 되지 않는 가벼운 톤.\n`;
    } else if (kstHour >= 12 && kstHour < 14) {
      context += `점심 시간 — 잠깐 쉬는 타이밍. 가볍고 편안한 대화 톤. 밥 잘 드셨는지 등 일상적 안부도 자연스러움.\n`;
    } else if (kstHour >= 14 && kstHour < 17) {
      context += `오후 업무 시간 — 오전보다 여유 있는 편. 업무 체크인이나 짧은 정보 공유가 자연스러움.\n`;
    } else if (kstHour >= 17 && kstHour < 19) {
      context += `업무 마무리 시간 — 하루 정리하는 느낌. "오늘 어떠셨어요?" 같은 마무리 톤.\n`;
    } else if (kstHour >= 19 && kstHour < 21) {
      context += `저녁 시간 — 편안하고 느긋한 톤. 일 얘기보다 가벼운 일상 대화가 자연스러움.\n`;
    } else {
      context += `늦은 저녁 — 조용하고 차분한 톤. 짧게, 부담 없이.\n`;
    }

    if (weatherInfo) {
      context += `\n## 현재 날씨\n${weatherInfo}\n`;
    }

    if (brainContext && brainContext !== "관련 기억 없음") {
      context += `\n## Brain 맥락 (최근 활동)\n${brainContext}\n`;
    }

    context += `\n## 선제 메시지 안전 규칙\n`;
    context += `- 이전 사용자 질문에 대한 답변, 정정, 사과처럼 쓰지 마세요.\n`;
    context += `- 파일 경로, 작업 완료 결과, 확인 요청을 다시 보내지 마세요.\n`;
    context += `- 자연스러운 안부나 짧은 체크인이 아니면 정확히 [SKIP]만 반환하세요.\n`;

    context += `\n## 유형별 가이드\n`;
    switch (type) {
      case "weather_health":
        context += `날씨와 관련된 건강/생활 이야기. 영지님이 몸이 약하시니 건강 걱정을 자연스럽게.\n`;
        break;
      case "work_checkin":
        context += `이사님의 업무 진행에 대한 가벼운 체크인. "잘 되고 있어요?" 느낌.\n`;
        break;
      case "conversation_followup":
        context += `이전 대화에서 나왔던 주제의 후속. Brain 맥락을 참조해서 자연스럽게 이어가기.\n`;
        break;
      case "emotional_support":
        context += `바쁜 시기에 응원과 격려. 짧고 따뜻하게.\n`;
        break;
      case "random_natural":
        context += `특별한 이유 없이 자연스럽게 안부. 날씨, 시간대에 맞는 가벼운 대화.\n`;
        break;
      case "market_insight":
        context += `이사님의 사업(토크업 등)과 관련된 시장 동향이나 경쟁사 소식을 전달. WebSearch로 최신 정보를 검색한 후 핵심만 짧게 공유. "이런 소식 봤는데요" 느낌으로 자연스럽게.\n`;
        break;
    }

    return context;
  }

  /** 발송 후 상태 업데이트 */
  recordSent(type: ProactiveMessageType): void {
    this.state.todaySentCount++;
    this.state.lastSentAt = Date.now();
    this.state.recentTypes.push(type);
    if (this.state.recentTypes.length > 5) {
      this.state.recentTypes.shift();
    }
    this.saveState();
  }

  /** 메시지 대상 chatId와 이름 결정 */
  getTarget(type: ProactiveMessageType): { chatId: number; name: string } {
    // weather_health → 그룹 (없으면 이사님 DM)
    if (type === "weather_health" && this.config.groupChatId) {
      return { chatId: this.config.groupChatId, name: "가족" };
    }
    // 나머지 모든 타입 → 이사님 DM
    return { chatId: this.config.ownerChatId, name: "이사님" };
  }

  // --- 내부 헬퍼 ---

  private isNotableWeather(info: string): boolean {
    return /비|눈|폭우|폭설|한파|폭염|태풍|미세먼지|나쁨|매우|Rain|Snow|Storm/i.test(info);
  }

  private todayKey(): string {
    // KST 기준
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const kst = new Date(utc + 9 * 3600000);
    return kst.toISOString().slice(0, 10);
  }

  private loadState(): ProactiveState {
    try {
      if (fs.existsSync(this.statePath)) {
        return JSON.parse(fs.readFileSync(this.statePath, "utf-8"));
      }
    } catch { /* 파일 손상 시 초기화 */ }
    return {
      todaySentCount: 0,
      lastSentAt: 0,
      lastDate: "",
      recentTypes: [],
    };
  }

  private saveState(): void {
    try {
      const dir = path.dirname(this.statePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), "utf-8");
    } catch { /* 저장 실패 무시 */ }
  }
}

/** wttr.in에서 날씨 정보를 가져옴 (proactive 판단용) */
export async function fetchWeather(city: string = "Seoul"): Promise<string | null> {
  try {
    const encoded = encodeURIComponent(city);
    const url = `https://wttr.in/${encoded}?format=3&lang=ko`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.text()).trim();
  } catch {
    return null;
  }
}
