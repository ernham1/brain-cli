import "dotenv/config";
import { z } from "zod";

const PROVIDER_DEFAULTS: Record<string, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-4o",
  "claude-code": "claude-opus-4-8",
  "codex-cli": "gpt-5.3-codex",
  "codex-sdk": "",
};

export function normalizeModelName(value: string | undefined, fallback: string): string {
  const raw = (value || fallback).trim();
  return raw
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\[(?:0|1|22|3\d|4\d)m\]?$/g, "")
    .trim();
}

const configSchema = z
  .object({
    telegramBotToken: z.string().min(1, "TELEGRAM_BOT_TOKEN 필수"),
    provider: z.enum(["anthropic", "openai", "claude-code", "codex-cli", "codex-sdk"]),
    anthropicApiKey: z.string().optional(),
    openaiApiKey: z.string().optional(),
    ownerChatIds: z
      .array(z.number())
      .min(1, "OWNER_CHAT_IDS에 최소 1개 chat_id 필요"),
    ownerUserIds: z
      .array(z.number())
      .default([]),
    brainRoot: z.string().optional(),
    obsidianRoot: z.string().optional(),
    brainEnabled: z.boolean(),
    botPersona: z.string().min(1),
    botNameKr: z.string().min(1),
    model: z.string(),
    sessionDir: z.string(),
    briefingHour: z.number().min(0).max(23),
    briefingEnabled: z.boolean(),
    proactiveEnabled: z.boolean(),
    proactiveMaxDaily: z.number().min(0).max(20),
    proactiveMinInterval: z.number().min(1),
    proactiveGroupChatId: z.number().nullable(),
    githubReportEnabled: z.boolean(),
    githubReportHour: z.number().min(0).max(23),
    githubRepo: z.string(),
    npmPackage: z.string(),
    autoApprovePaths: z.array(z.string()).default([]),
    autoApproveBashPatterns: z.array(z.string()).default([]),
    headlessAllowedTools: z.string().default("Read,Glob,Grep,Edit,Write,Bash,WebSearch,WebFetch"),
    headlessSkipPermissions: z.boolean().default(false),
    agentforgeEnabled: z.boolean().default(false),
    agentforgeUrl: z.string().default("http://localhost:5070"),
    agentforgeApiKey: z.string().optional(),
    agentforgeUserId: z.string().default("clo"),
    telegraphToken: z.string().optional(),
    meetingSttEnabled: z.boolean().default(true),
    meetingSttModel: z.string().default("gpt-4o-mini-transcribe"),
    meetingVoiceMaxMb: z.number().min(1).max(100).default(20),
    meetingReminderIntervalMin: z.number().min(0).max(240).default(15),
    delegatedWorkerPollIntervalSec: z.number().min(5).max(3600).default(30),
    delegatedWorkerStaleAfterMin: z.number().min(1).max(1440).default(5),
    codexSdkPython: z.string().default("python"),
    codexSdkModel: z.string().default(""),
    codexSdkSandbox: z.enum(["read_only", "workspace_write", "full_access"]).default("read_only"),
    codexSdkCwd: z.string().optional(),
    codexSdkTimeoutSec: z.number().min(30).max(1800).default(180),
  })
  .refine(
    (c) => {
      if (c.provider === "anthropic") return !!c.anthropicApiKey;
      if (c.provider === "openai") return !!c.openaiApiKey;
      if (c.provider === "claude-code") return true; // Max 구독 인증 — API 키 불필요
      if (c.provider === "codex-cli") return true;  // ChatGPT Pro 구독 — API 키 불필요
      if (c.provider === "codex-sdk") return true;  // Codex 앱/CLI 로컬 인증 재사용
      return false;
    },
    { message: "선택한 프로바이더의 API 키가 필요합니다" },
  )
  .refine(
    (c) => !c.brainEnabled || !!c.brainRoot,
    { message: "BRAIN_ENABLED=true일 때 BRAIN_ROOT가 필요합니다" },
  );

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const provider = (process.env.PROVIDER || "anthropic") as string;

  return configSchema.parse({
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    provider,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
    openaiApiKey: process.env.OPENAI_API_KEY || undefined,
    ownerChatIds: (process.env.OWNER_CHAT_IDS || "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n) && n > 0),
    ownerUserIds: (process.env.OWNER_USER_IDS || "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n) && n > 0),
    brainEnabled: process.env.BRAIN_ENABLED !== "false",
    brainRoot: process.env.BRAIN_ENABLED === "false"
      ? undefined
      : (process.env.BRAIN_ROOT || "C:\\Projects\\Brain"),
    obsidianRoot: process.env.OBSIDIAN_ROOT || undefined,
    botPersona: process.env.BOT_PERSONA || "clo",
    botNameKr: process.env.BOT_NAME_KR || "클로",
    model: normalizeModelName(
      process.env.MODEL,
      PROVIDER_DEFAULTS[provider] || "gpt-4o",
    ),
    sessionDir: process.env.SESSION_DIR || "./data/sessions",
    briefingHour: Number(process.env.BRIEFING_HOUR || "9"),
    briefingEnabled: process.env.BRIEFING_ENABLED !== "false",
    proactiveEnabled: process.env.PROACTIVE_ENABLED !== "false",
    proactiveMaxDaily: Number(process.env.PROACTIVE_MAX_DAILY || "3"),
    proactiveMinInterval: Number(process.env.PROACTIVE_MIN_INTERVAL || "120"),
    proactiveGroupChatId: process.env.PROACTIVE_GROUP_CHAT_ID
      ? Number(process.env.PROACTIVE_GROUP_CHAT_ID)
      : null,
    githubReportEnabled: process.env.GITHUB_REPORT_ENABLED === "true",
    githubReportHour: Number(process.env.GITHUB_REPORT_HOUR || "21"),
    githubRepo: process.env.GITHUB_REPO || "ernham1/brain-cli",
    npmPackage: process.env.NPM_PACKAGE || "@ernham/brain-cli",
    autoApprovePaths: (process.env.AUTO_APPROVE_PATHS || "")
      .split(",").map((s) => s.trim()).filter(Boolean),
    autoApproveBashPatterns: (process.env.AUTO_APPROVE_BASH_PATTERNS || "")
      .split(",").map((s) => s.trim()).filter(Boolean),
    headlessAllowedTools: process.env.HEADLESS_ALLOWED_TOOLS || "Read,Glob,Grep,Edit,Write,Bash,WebSearch,WebFetch",
    headlessSkipPermissions: process.env.HEADLESS_SKIP_PERMISSIONS === "true",
    agentforgeEnabled: process.env.AGENTFORGE_ENABLED === "true",
    agentforgeUrl: process.env.AGENTFORGE_URL || "http://localhost:5070",
    agentforgeApiKey: process.env.AGENTFORGE_API_KEY || undefined,
    agentforgeUserId: process.env.AGENTFORGE_USER_ID || "clo",
    telegraphToken: process.env.TELEGRAPH_TOKEN || undefined,
    meetingSttEnabled: process.env.MEETING_STT_ENABLED !== "false",
    meetingSttModel: process.env.MEETING_STT_MODEL || "gpt-4o-mini-transcribe",
    meetingVoiceMaxMb: Number(process.env.MEETING_VOICE_MAX_MB || "20"),
    meetingReminderIntervalMin: Number(process.env.MEETING_REMINDER_INTERVAL_MIN || "15"),
    delegatedWorkerPollIntervalSec: Number(process.env.DELEGATED_WORKER_POLL_INTERVAL_SEC || "30"),
    delegatedWorkerStaleAfterMin: Number(process.env.DELEGATED_WORKER_STALE_AFTER_MIN || "5"),
    codexSdkPython: process.env.CODEX_SDK_PYTHON || "python",
    codexSdkModel: process.env.CODEX_SDK_MODEL || "",
    codexSdkSandbox: process.env.CODEX_SDK_SANDBOX || "read_only",
    codexSdkCwd: process.env.CODEX_SDK_CWD || process.cwd(),
    codexSdkTimeoutSec: Number(process.env.CODEX_SDK_TIMEOUT_SEC || "180"),
  });
}
