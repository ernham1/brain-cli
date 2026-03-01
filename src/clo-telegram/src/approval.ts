import { Bot, InlineKeyboard } from "grammy";
import crypto from "node:crypto";

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  chatId: number;
  messageId?: number;
  toolName: string;
  requesterId?: number; // 요청자 userId (그룹에서 무단 승인 방지)
}

const TIMEOUT_MS = 5 * 60 * 1000; // 5분

export class ApprovalService {
  private bot: Bot;
  private ownerUserIds: number[];
  private pending: Map<string, PendingApproval> = new Map();
  /** 승인 결과를 SDK에 주입할 콜백 (bot.ts에서 설정) */
  onApprovalResult?: (chatId: number, toolName: string, approved: boolean, userId?: number) => void;

  constructor(bot: Bot, ownerUserIds: number[] = []) {
    this.bot = bot;
    this.ownerUserIds = ownerUserIds;
  }

  /** bot.ts에서 auth 미들웨어 뒤에 호출해야 함 */
  registerHandlers(): void {
    this.setupHandlers();
  }

  /** 텔레그램에 승인 요청을 보내고, 버튼 클릭까지 대기 */
  async requestApproval(
    chatId: number,
    toolName: string,
    input: Record<string, unknown>,
    requesterId?: number,
  ): Promise<boolean> {
    const requestId = crypto.randomUUID().slice(0, 8);
    const text = this.formatMessage(toolName, input);

    const keyboard = new InlineKeyboard()
      .text("✅ 수락", `approve_${requestId}`)
      .text("❌ 거절", `reject_${requestId}`);

    const sent = await this.bot.api.sendMessage(chatId, text, {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          this.bot.api
            .editMessageText(chatId, sent.message_id, "⏰ 시간 초과 — 자동 거절됨")
            .catch(() => {});
          resolve(false);
        }
      }, TIMEOUT_MS);

      this.pending.set(requestId, {
        resolve,
        timer,
        chatId,
        messageId: sent.message_id,
        toolName,
        requesterId,
      });
    });
  }

  private setupHandlers(): void {
    // callback_query:data로 모든 콜백 처리 (auth 미들웨어 뒤에 등록됨)
    this.bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      console.log(`[Clo] 콜백 수신: ${data}`);

      try {
        let requestId: string | undefined;
        let approved: boolean;

        if (data.startsWith("approve_")) {
          requestId = data.slice("approve_".length);
          approved = true;
        } else if (data.startsWith("reject_")) {
          requestId = data.slice("reject_".length);
          approved = false;
        } else {
          return; // 관련 없는 콜백
        }

        const entry = this.pending.get(requestId);
        if (!entry) {
          await ctx.answerCallbackQuery("이미 처리된 요청이에요.").catch(() => {});
          return;
        }

        // 도구 승인 권한 검증: ownerUserIds만 승인/거절 가능
        const clickerId = ctx.from?.id;
        if (this.ownerUserIds.length > 0 && clickerId && !this.ownerUserIds.includes(clickerId)) {
          await ctx.answerCallbackQuery("도구 승인 권한이 없어요.").catch(() => {});
          return;
        }

        clearTimeout(entry.timer);
        this.pending.delete(requestId);

        // Promise를 먼저 resolve → SDK가 즉시 진행 가능
        // 텔레그램 UI 업데이트는 부가 작업 (실패해도 무관)
        entry.resolve(approved);
        console.log(`[Clo] ${approved ? "승인" : "거절"}됨: ${requestId}`);

        // 승인 결과를 SDK 컨텍스트에 주입 (클로가 승인 여부 인식 가능)
        this.onApprovalResult?.(entry.chatId, entry.toolName, approved, entry.requesterId);

        await ctx.answerCallbackQuery(approved ? "승인됨!" : "거절됨").catch(() => {});
        await ctx.editMessageText(
          approved ? "✅ 승인됨 — 작업 진행 중..." : "❌ 거절됨",
        ).catch(() => {});
      } catch (err) {
        console.error("[Clo] 콜백 처리 오류:", err);
        await ctx.answerCallbackQuery("오류가 발생했어요").catch(() => {});
      }
    });
  }

  private formatMessage(
    toolName: string,
    input: Record<string, unknown>,
  ): string {
    switch (toolName) {
      case "Edit": {
        const filePath = String(input.file_path || "");
        const oldStr = String(input.old_string || "").slice(0, 200);
        const newStr = String(input.new_string || "").slice(0, 200);
        return (
          `🔧 <b>파일 수정 요청</b>\n` +
          `📁 <code>${escapeHtml(filePath)}</code>\n\n` +
          `<b>기존:</b>\n<pre>${escapeHtml(oldStr)}</pre>\n` +
          `<b>변경:</b>\n<pre>${escapeHtml(newStr)}</pre>`
        );
      }
      case "Write": {
        const filePath = String(input.file_path || "");
        const content = String(input.content || "");
        const lines = content.split("\n").length;
        return (
          `📝 <b>파일 생성/덮어쓰기 요청</b>\n` +
          `📁 <code>${escapeHtml(filePath)}</code>\n` +
          `📏 ~${lines}줄`
        );
      }
      case "Bash": {
        const command = String(input.command || "");
        return (
          `💻 <b>명령어 실행 요청</b>\n` +
          `<pre>${escapeHtml(command.slice(0, 500))}</pre>`
        );
      }
      default:
        return `⚠️ <b>${escapeHtml(toolName)}</b> 도구 사용 요청`;
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
