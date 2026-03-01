import "dotenv/config";
import { z } from "zod";

const PROVIDER_DEFAULTS: Record<string, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  gemini: "gemini-2.0-flash",
  "claude-code": "claude-sonnet-4-6",
};

const configSchema = z
  .object({
    telegramBotToken: z.string().min(1, "TELEGRAM_BOT_TOKEN 필수"),
    provider: z.enum(["anthropic", "openai", "gemini", "claude-code"]),
    anthropicApiKey: z.string().optional(),
    openaiApiKey: z.string().optional(),
    geminiApiKey: z.string().optional(),
    ownerChatIds: z
      .array(z.number())
      .min(1, "OWNER_CHAT_IDS에 최소 1개 chat_id 필요"),
    ownerUserIds: z
      .array(z.number())
      .default([]),
    brainRoot: z.string().min(1),
    model: z.string(),
    sessionDir: z.string(),
    briefingHour: z.number().min(0).max(23),
    briefingEnabled: z.boolean(),
  })
  .refine(
    (c) => {
      if (c.provider === "anthropic") return !!c.anthropicApiKey;
      if (c.provider === "openai") return !!c.openaiApiKey;
      if (c.provider === "gemini") return !!c.geminiApiKey;
      if (c.provider === "claude-code") return true; // Max 구독 인증 — API 키 불필요
      return false;
    },
    { message: "선택한 프로바이더의 API 키가 필요합니다" },
  );

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const provider = (process.env.PROVIDER || "anthropic") as string;

  return configSchema.parse({
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    provider,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
    openaiApiKey: process.env.OPENAI_API_KEY || undefined,
    geminiApiKey: process.env.GEMINI_API_KEY || undefined,
    ownerChatIds: (process.env.OWNER_CHAT_IDS || "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n) && n > 0),
    ownerUserIds: (process.env.OWNER_USER_IDS || "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n) && n > 0),
    brainRoot: process.env.BRAIN_ROOT || "C:\\Projects\\Brain",
    model: process.env.MODEL || PROVIDER_DEFAULTS[provider] || "gpt-4o",
    sessionDir: process.env.SESSION_DIR || "./data/sessions",
    briefingHour: Number(process.env.BRIEFING_HOUR || "9"),
    briefingEnabled: process.env.BRIEFING_ENABLED !== "false",
  });
}
