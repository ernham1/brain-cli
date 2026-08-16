import type { Bot } from "grammy";
import type { CloAgent } from "./agent.js";
import type { Config } from "./config.js";
import { DebateLog } from "./debate-log.js";

/** 토론이 끝난 것으로 간주하는 마지막 메시지 경과 시간 */
const DEBATE_MAX_AGE_MS = 30 * 60 * 1000; // 30분

/** 토론 순번 — 마지막 발언 봇의 다음 봇이 발화 */
const BOT_ORDER = ["클로", "제미", "지피"];

/**
 * 자율 토론 감시자 — 공유 토론 로그를 주기적으로 확인하여
 * 다른 AI가 마지막으로 발언했을 때 이 봇이 자동으로 응답합니다.
 *
 * 각 봇 인스턴스는 독립적으로 실행되며, 0~3초 랜덤 지연으로
 * 동시 발화를 분산시킵니다.
 */
export class DebateWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRespondedAt = new Map<number, number>(); // chatId → 마지막 응답 시각
  private processing = new Set<number>(); // 현재 debateChat 진행 중인 chatId
  private mainHandling = new Set<number>(); // 메인 메시지 핸들러가 처리 중인 chatId

  constructor(
    private debateLog: DebateLog,
    private agent: CloAgent,
    private bot: Bot,
    private config: Config,
  ) {}

  start(intervalMs = 10_000): void {
    // 봇마다 시작 시점을 분산 (0~3초 랜덤 지연으로 동시 발화 방지)
    const jitter = Math.floor(Math.random() * 3000);
    setTimeout(() => {
      console.log(`[DebateWatcher] ${this.config.botNameKr} — ${intervalMs / 1000}초 간격으로 시작 (지연: ${jitter}ms)`);
      this.timer = setInterval(() => this.check(), intervalMs);
    }, jitter);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 메시지 핸들러가 처리 중일 때 DebateWatcher 발화 억제 (기본 15초) */
  suppress(chatId: number, ms = 15_000): void {
    this.lastRespondedAt.set(chatId, Date.now() + ms - 8_000);
  }

  /** 메인 메시지 핸들러 처리 시작 — DebateWatcher 발화 완전 차단 */
  startHandling(chatId: number): void {
    this.mainHandling.add(chatId);
  }

  /** 메인 메시지 핸들러 처리 완료 — DebateWatcher 발화 재허용 */
  endHandling(chatId: number): void {
    this.mainHandling.delete(chatId);
  }

  private async check(): Promise<void> {
    const chatIds = this.debateLog.getActiveChatIds();
    for (const chatId of chatIds) {
      await this.checkChat(chatId);
    }
  }

  private async checkChat(chatId: number): Promise<void> {
    const last = this.debateLog.getLastEntry(chatId);
    if (!last) return;

    const age = Date.now() - new Date(last.timestamp).getTime();

    // 조용한 skip 조건은 로그를 남기지 않는다. 활성 채팅에서는 10초마다 호출되기 때문이다.
    if (last.sender === this.config.botNameKr) return;
    if (age > DEBATE_MAX_AGE_MS) return;

    const lastResp = this.lastRespondedAt.get(chatId);
    const cooldownLeft = lastResp === undefined
      ? 0
      : Math.max(0, 8_000 - (Date.now() - lastResp));

    // 마지막 발언자가 봇이면 순번 체크 — 내 차례가 아니면 skip
    if (!last.human) {
      const lastIdx = BOT_ORDER.indexOf(last.sender);
      if (lastIdx !== -1) {
        const nextBot = BOT_ORDER[(lastIdx + 1) % BOT_ORDER.length];
        if (nextBot !== this.config.botNameKr) return;
      }
    }

    // 이 봇이 최근 응답했으면 skip (suppress 쿨다운)
    if (cooldownLeft > 0) return;

    // 봇 간 무한 체인 방지 — 최근 30개가 전부 봇 응답이면 skip
    const recentEntries = this.debateLog.getRecentEntries(chatId, 30);
    const hasRecentHuman = recentEntries.some((e) => e.human === true);
    if (recentEntries.length >= 30 && !hasRecentHuman) return;

    // 메인 메시지 핸들러가 처리 중이면 skip (중복 응답 방지)
    if (this.mainHandling.has(chatId)) return;

    // 이미 debateChat 실행 중이면 skip (SDK 응답 대기 중 중복 발화 방지)
    if (this.processing.has(chatId)) return;

    const context = this.debateLog.getContext(chatId);
    this.processing.add(chatId);
    console.log(`[DW:${this.config.botNameKr}] debateChat 호출 시작`);

    try {
      const response = await this.agent.debateChat(chatId, context);
      console.log(`[DW:${this.config.botNameKr}] debateChat 응답: ${response?.slice(0, 50)}`);
      if (!response || response.trim() === "[QUIET]" || response.trim() === "[SKIP]") return;

      await this.bot.api.sendMessage(chatId, response);
      this.debateLog.append(chatId, this.config.botNameKr, response);
      this.debateLog.cleanup(chatId);
      this.lastRespondedAt.set(chatId, Date.now());

      console.log(`[DebateWatcher] ${this.config.botNameKr} → chatId=${chatId} 자동 발언`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[DebateWatcher] chatId=${chatId} 오류: ${msg}`);
    } finally {
      this.processing.delete(chatId);
    }
  }
}
