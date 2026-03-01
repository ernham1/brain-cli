import { Bot } from "grammy";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { createAuthMiddleware, isGroupChat } from "./auth.js";
import { CloAgent } from "./agent.js";
import { ApprovalService } from "./approval.js";

export interface BotResult {
  bot: Bot;
  agent: CloAgent;
}

export function createBot(config: Config): BotResult {
  const bot = new Bot(config.telegramBotToken);

  // 봇 정보 캐시 (멘션 감지용, 런타임에 getMe()로 채움)
  let botUsername = "";
  let botId = 0;

  // 승인 서비스 초기화 (콜백 핸들러 등록됨, ownerUserIds로 승인 권한 제한)
  const approvalService = new ApprovalService(bot, config.ownerUserIds);
  const agent = new CloAgent(config, approvalService);

  // 승인 결과를 다음 agent.chat()에서 클로가 인식할 수 있도록 주입
  approvalService.onApprovalResult = (chatId, toolName, approved, userId) => {
    const status = approved ? "✅ 승인됨" : "❌ 거절됨";
    console.log(`[Clo] 승인 결과 주입: ${toolName} → ${status}`);
    agent.injectApprovalResult(chatId, toolName, approved, userId);
  };

  // 인증 미들웨어 (모든 핸들러 앞에 배치)
  bot.use(createAuthMiddleware(config));

  // 승인 콜백 핸들러 (auth 미들웨어 뒤에 등록해야 함)
  approvalService.registerHandlers();

  // /start 명령
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "안녕하세요, 광웅 이사님! 클로입니다.\n" +
        "텔레그램에서도 언제든 말씀해주세요!",
    );
  });

  // /reset 명령 — 세션 초기화
  bot.command("reset", async (ctx) => {
    if (ctx.chat) {
      const userId = ctx.from?.id;
      agent.resetSession(ctx.chat.id, userId);
      await ctx.reply("대화를 새로 시작할게요!");
    }
  });

  // 텍스트 메시지 핸들러
  bot.on("message:text", async (ctx) => {
    if (!ctx.chat || !ctx.message.text) return;

    const userId = ctx.from?.id;
    let text = ctx.message.text;
    const isGroup = isGroupChat(ctx);

    // 그룹: 멘션/reply 여부 감지 (필터링이 아닌 플래그로 전달)
    let isMentioned = false;
    if (isGroup) {
      isMentioned = isMentionedOrReply(ctx, text, botUsername, botId);
      if (isMentioned) {
        text = stripMention(text, botUsername);
      }
    } else {
      // DM은 항상 직접 호출
      isMentioned = true;
    }

    // 멘션된 경우만 "입력 중..." 표시 (자연 참여 판단 중엔 표시 안 함)
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    if (isMentioned) {
      await ctx.replyWithChatAction("typing");
      typingInterval = setInterval(() => {
        ctx.replyWithChatAction("typing").catch(() => {});
      }, 4000);
    }

    try {
      const senderName = ctx.from?.first_name || undefined;
      const response = await agent.chat(ctx.chat.id, text, userId, {
        isGroup,
        senderName,
        isMentioned,
      });
      if (typingInterval) clearInterval(typingInterval);

      // [QUIET] 응답이면 조용히 넘어감 (대화는 히스토리에 기록됨)
      if (response.trim() === "[QUIET]") return;

      // 그룹: 원본 메시지에 reply 형태로 응답
      if (isGroup) {
        await sendLongMessage(ctx, response, ctx.message.message_id);
      } else {
        await sendLongMessage(ctx, response);
      }
    } catch (error) {
      if (typingInterval) clearInterval(typingInterval);
      // 자연 참여 판단 중 에러는 조용히 무시 (멘션 아닌 경우)
      if (!isMentioned) return;
      console.error("[Clo] Agent error:", error);

      if (error instanceof Error && error.message.includes("rate_limit")) {
        await ctx.reply("잠시 후 다시 시도해주세요.");
      } else {
        await ctx.reply(
          "죄송해요, 처리 중 문제가 생겼어요. 잠시 후 다시 시도해주세요.",
        );
      }
    }
  });

  // 이미지 메시지 핸들러
  bot.on("message:photo", async (ctx) => {
    if (!ctx.chat || !ctx.message.photo) return;

    const userId = ctx.from?.id;

    // 그룹: 이미지는 멘션/reply 있을 때만 처리 (자연 참여 대상 아님 — 비용 고려)
    if (isGroupChat(ctx)) {
      const caption = ctx.message.caption || "";
      if (!isMentionedOrReply(ctx, caption, botUsername, botId)) return;
    }

    await ctx.replyWithChatAction("typing");
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4000);

    try {
      // 오래된 임시 이미지 정리 (1시간 이상)
      cleanupTempImages();

      // 가장 큰 해상도 사진 선택
      const photos = ctx.message.photo;
      const photo = photos[photos.length - 1];
      let caption = ctx.message.caption || "이 이미지를 분석해줘";
      if (isGroupChat(ctx)) {
        caption = stripMention(caption, botUsername);
      }

      // 파일 URL 가져오기
      const file = await ctx.api.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;

      // 이미지를 디스크에 저장 → SDK Read 도구가 직접 읽음
      const tempDir = path.join(process.cwd(), "data", "temp");
      fs.mkdirSync(tempDir, { recursive: true });
      const fileName = `img_${Date.now()}.jpg`;
      const filePath = path.join(tempDir, fileName);
      await downloadToFile(fileUrl, filePath);

      const absPath = path.resolve(filePath).replace(/\\/g, "/");
      const message = `[이미지 파일: ${absPath}]\n위 파일을 Read 도구로 확인하고 분석해주세요.\n${caption}`;
      const isGroup = isGroupChat(ctx);
      const senderName = ctx.from?.first_name || undefined;
      const response = await agent.chat(ctx.chat.id, message, userId, {
        isGroup,
        senderName,
      });
      clearInterval(typingInterval);

      if (isGroup) {
        await sendLongMessage(ctx, response, ctx.message.message_id);
      } else {
        await sendLongMessage(ctx, response);
      }
    } catch (error) {
      clearInterval(typingInterval);
      console.error("[Clo] 이미지 처리 오류:", error);
      await ctx.reply("이미지 처리 중 문제가 생겼어요. 다시 시도해주세요.");
    }
  });

  // 에러 핸들러
  bot.catch((err) => {
    console.error("[Clo] Bot error:", err);
  });

  // 봇 시작 시 username + id 취득 (GRP-NFR-003)
  bot.api.getMe().then((me) => {
    botUsername = me.username || "";
    botId = me.id;
    console.log(`[Clo] 봇 username: @${botUsername}, id: ${botId}`);
  }).catch((err) => {
    console.error("[Clo] getMe() 실패:", err);
  });

  return { bot, agent };
}

// --- 그룹 헬퍼 ---

/** 그룹에서 @멘션 또는 reply로 직접 호출됐는지 감지 */
function isMentionedOrReply(
  ctx: { message?: { reply_to_message?: { from?: { id?: number; is_bot?: boolean } } } },
  text: string,
  botUsername: string,
  botId: number,
): boolean {
  // @username 멘션 확인
  if (botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) {
    return true;
  }

  // "클로" 또는 "클로야" 등 이름으로 직접 호출한 경우
  if (/\b클로[야아]?\b/.test(text)) {
    return true;
  }

  // reply로 클로 자신의 메시지에 답장한 경우 (다른 봇 reply는 무시)
  const replyFrom = ctx.message?.reply_to_message?.from;
  if (replyFrom?.is_bot && botId && replyFrom.id === botId) {
    return true;
  }

  return false;
}

/** 텍스트에서 @username 멘션 제거 */
function stripMention(text: string, botUsername: string): string {
  if (!botUsername) return text;
  const regex = new RegExp(`@${botUsername}\\b`, "gi");
  return text.replace(regex, "").trim();
}

// --- 기존 헬퍼 ---

/** URL에서 이미지를 다운로드해 파일로 저장 */
function downloadToFile(url: string, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);
    https.get(url, (res) => {
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
      res.on("error", reject);
    }).on("error", (err) => { fs.unlink(filePath, () => {}); reject(err); });
  });
}

/** 1시간 이상 된 임시 이미지 삭제 */
function cleanupTempImages(): void {
  const tempDir = path.join(process.cwd(), "data", "temp");
  try {
    const files = fs.readdirSync(tempDir);
    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(tempDir, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > 60 * 60 * 1000) {
        fs.unlinkSync(filePath);
      }
    }
  } catch { /* temp 디렉토리가 없으면 무시 */ }
}

const TELEGRAM_MAX_LENGTH = 4096;

async function sendLongMessage(
  ctx: { reply: (text: string, options?: Record<string, unknown>) => Promise<unknown> },
  text: string,
  replyToMessageId?: number,
): Promise<void> {
  if (text.length <= TELEGRAM_MAX_LENGTH) {
    await safeReply(ctx, text, replyToMessageId);
    return;
  }

  const chunks = splitMessage(text, TELEGRAM_MAX_LENGTH);
  for (let i = 0; i < chunks.length; i++) {
    // 첫 chunk만 reply, 나머지는 일반 전송
    await safeReply(ctx, chunks[i], i === 0 ? replyToMessageId : undefined);
  }
}

/** Markdown 파싱 실패 시 plain text로 폴백 */
async function safeReply(
  ctx: { reply: (text: string, options?: Record<string, unknown>) => Promise<unknown> },
  text: string,
  replyToMessageId?: number,
): Promise<void> {
  const opts: Record<string, unknown> = { parse_mode: "Markdown" };
  if (replyToMessageId) {
    opts.reply_to_message_id = replyToMessageId;
  }

  try {
    await ctx.reply(text, opts);
  } catch {
    // Markdown 파싱 오류 → plain text 전송
    const fallback: Record<string, unknown> = {};
    if (replyToMessageId) fallback.reply_to_message_id = replyToMessageId;
    await ctx.reply(text, fallback);
  }
}

function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // 줄바꿈 기준으로 분할 시도
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex <= 0) splitIndex = maxLength;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trimStart();
  }

  return chunks;
}
