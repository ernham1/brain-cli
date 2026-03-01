import type { Context, NextFunction } from "grammy";
import type { Config } from "./config.js";

/** chat.type이 group 또는 supergroup인지 확인 */
export function isGroupChat(ctx: Context): boolean {
  const chatType = ctx.chat?.type;
  return chatType === "group" || chatType === "supergroup";
}

export function createAuthMiddleware(config: Config) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    if (isGroupChat(ctx)) {
      // 그룹: 누구나 대화 가능 (멘션/reply 필터는 bot.ts에서 처리)
      // 도구 승인(Edit/Write/Bash)은 approval.ts에서 ownerUserIds로 제한
    } else {
      // DM: 기존 chatId 기반 인증 유지 (하위 호환)
      // ownerUserIds도 체크 — userId로 통합 인증 가능
      const userId = ctx.from?.id;
      const chatIdOk = config.ownerChatIds.includes(chatId);
      const userIdOk = userId != null && config.ownerUserIds.includes(userId);

      if (!chatIdOk && !userIdOk) {
        if (ctx.message) {
          await ctx.reply("이 봇은 비공개입니다.");
        }
        return;
      }
    }

    await next();
  };
}
