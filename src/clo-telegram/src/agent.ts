import type { Config } from "./config.js";
import { createProvider, type ChatProvider, type ApprovalService } from "./providers.js";
import type { ReminderStore } from "./scheduler.js";
import { SessionManager, makeSessionKey } from "./session.js";
import { CLO_SYSTEM_PROMPT } from "./prompt.js";

export class CloAgent {
  private provider: ChatProvider;
  private sessions: SessionManager;
  /** 승인 결과 큐: sessionKey → 최근 승인/거절 내역 */
  private approvalResults: Map<string, { toolName: string; approved: boolean; at: number }[]> = new Map();

  constructor(config: Config, approvalService?: ApprovalService) {
    this.provider = createProvider(config);
    if (approvalService) {
      this.provider.setApprovalService?.(approvalService);
    }
    this.sessions = new SessionManager(config.sessionDir);
  }

  /** 승인 결과를 큐에 저장 (다음 chat() 턴에서 시스템 컨텍스트로 주입됨) */
  injectApprovalResult(chatId: number, toolName: string, approved: boolean, userId?: number): void {
    const key = makeSessionKey(chatId, userId);
    const queue = this.approvalResults.get(key) ?? [];
    queue.push({ toolName, approved, at: Date.now() });
    this.approvalResults.set(key, queue);
  }

  async chat(
    chatId: number,
    userMessage: string,
    userId?: number,
    opts?: { isGroup?: boolean; senderName?: string; isMentioned?: boolean },
  ): Promise<string> {
    const session = this.sessions.getOrCreate(chatId, userId);
    const sessionKey = makeSessionKey(chatId, userId);

    session.history.push({ role: "user", content: userMessage });
    this.sessions.trimHistory(session);

    // 시스템 프롬프트에 현재 chatId 주입 (리마인더 도구에서 사용)
    let prompt = `${CLO_SYSTEM_PROMPT}\n\n## 현재 세션 정보\n- chatId: ${chatId}\n- 리마인더 도구 호출 시 이 chatId를 사용하세요.`;

    // 그룹채팅 컨텍스트 주입
    if (opts?.isGroup) {
      prompt += `\n- 채팅 유형: 그룹채팅`;
      if (opts.senderName) {
        prompt += `\n- 현재 발신자: ${opts.senderName}`;
        prompt += `\n- 이 메시지는 "${opts.senderName}"님이 보낸 것입니다. 이 분이 처음이라면 brain_recall로 "${opts.senderName}"에 대한 정보를 먼저 확인하세요.`;
      }
      if (opts.isMentioned) {
        prompt += `\n- 호출 방식: 직접 호출됨 (@멘션, 이름 호출, 또는 reply) — 반드시 응답하세요.`;
      } else {
        prompt += `\n- 호출 방식: 직접 호출 아님 — 대화를 듣고 있습니다. "자연스러운 대화 참여" 규칙에 따라 개입 여부를 판단하세요. 개입하지 않으려면 정확히 [QUIET]만 반환하세요.`;
      }
    } else {
      prompt += `\n- 채팅 유형: 1:1 DM (이사님과의 개인 대화)`;
    }

    // 승인 결과 큐가 있으면 시스템 프롬프트에 주입 → 클로가 승인 여부 인식
    const pendingResults = this.approvalResults.get(sessionKey);
    if (pendingResults && pendingResults.length > 0) {
      const lines = pendingResults.map(
        (r) => `- ${r.toolName}: ${r.approved ? "✅ 승인됨" : "❌ 거절됨"}`,
      );
      prompt += `\n\n## 직전 도구 승인 결과\n${lines.join("\n")}`;
      this.approvalResults.delete(sessionKey); // 소비 후 삭제
    }

    // provider가 도구 루프를 내부에서 처리하고 최종 텍스트만 반환
    // sessionKey를 사용해 SDK sessionMap도 분리됨
    const response = await this.provider.chat(
      session.history,
      prompt,
      chatId,
      sessionKey,
    );

    session.history.push({ role: "assistant", content: response });
    session.lastMessageAt = new Date().toISOString();
    this.sessions.save(session);

    return response;
  }

  setReminderStore(store: ReminderStore): void {
    this.provider.setReminderStore?.(store);
  }

  resetSession(chatId: number, userId?: number): void {
    const key = makeSessionKey(chatId, userId);
    this.sessions.reset(key);
    this.provider.resetSession?.(chatId, key);
  }
}
