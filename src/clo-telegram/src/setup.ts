import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { input, select, confirm } from "@inquirer/prompts";

// ─── 상수 ───

const PROVIDERS = [
  { name: "anthropic  — Claude API (API 키 필요)", value: "anthropic" },
  { name: "openai     — GPT-4o (API 키 필요)", value: "openai" },
  { name: "claude-code — Claude Max 구독자 전용 (API 키 불필요)", value: "claude-code" },
] as const;

const PROVIDER_KEY_URLS: Record<string, string> = {
  anthropic: "https://console.anthropic.com",
  openai: "https://platform.openai.com/api-keys",
};

const PROVIDER_ENV_KEY: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

// ─── 유틸 ───

function line(msg = ""): void {
  console.log(msg);
}

function section(title: string): void {
  line();
  line(`━━━ ${title} ━━━`);
  line();
}

function ok(msg: string): void {
  console.log(`  ✅ ${msg}`);
}

function fail(msg: string): void {
  console.log(`  ❌ ${msg}`);
}

function cmdExists(cmd: string): boolean {
  try {
    const check = process.platform === "win32" ? `where ${cmd}` : `which ${cmd}`;
    execSync(check, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getNodeVersion(): string {
  return process.version;
}

function getBrainCliVersion(): string | null {
  try {
    return execSync("brain-cli --version", { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

function getBrainRoot(): string | null {
  try {
    const { getDefaultBrainRoot } = require(
      path.join(
        execSync("npm root -g", { encoding: "utf-8" }).trim(),
        "@ernham", "brain-cli", "src", "utils.js",
      ),
    );
    return getDefaultBrainRoot() || null;
  } catch {
    return process.env.BRAIN_ROOT || null;
  }
}

async function validateBotToken(token: string): Promise<{ ok: boolean; username?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json() as { ok: boolean; result?: { username?: string } };
    if (json.ok) {
      return { ok: true, username: json.result?.username };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

// ─── 메인 셋업 ───

export async function runSetup(): Promise<void> {
  console.log(`
╔══════════════════════════════════════════╗
║   clo-telegram 설치 마법사               ║
║   Brain 연동 AI 텔레그램 봇              ║
╚══════════════════════════════════════════╝
  `);

  // ─── Step 1: 전제조건 확인 ───
  section("🔍 환경 확인");

  const nodeVer = getNodeVersion();
  ok(`Node.js ${nodeVer}`);

  const brainCliVer = getBrainCliVersion();
  if (!brainCliVer) {
    fail("brain-cli가 설치되지 않았습니다.");
    line();
    line("  먼저 brain-cli를 설치해주세요:");
    line("  npm install -g @ernham/brain-cli");
    line();
    process.exit(1);
  }
  ok(`brain-cli ${brainCliVer}`);

  const brainRoot = getBrainRoot();
  if (brainRoot) {
    ok(`Brain 경로: ${brainRoot}`);
  } else {
    fail("Brain 디렉토리를 찾을 수 없습니다.");
    line("  BRAIN_ROOT 환경변수를 설정하거나 brain-cli init을 실행하세요.");
    process.exit(1);
  }

  // ─── Step 2: 텔레그램 봇 토큰 ───
  section("📱 텔레그램 봇 만들기");

  line("  아직 봇을 만들지 않았다면 아래 순서를 따라하세요:");
  line();
  line("  1. 텔레그램 앱에서 @BotFather 검색");
  line("  2. /newbot 명령어 전송");
  line('  3. 봇 이름 입력 (예: "내 AI 비서")');
  line("  4. 봇 username 입력 (예: my_ai_assistant_bot)");
  line("  5. BotFather가 알려주는 토큰을 복사");
  line();

  let botToken = "";
  let botUsername = "";

  while (true) {
    botToken = await input({
      message: "봇 토큰:",
      validate: (v) => /^\d+:[A-Za-z0-9_-]+$/.test(v.trim()) || "유효한 토큰 형식이 아닙니다",
    });
    botToken = botToken.trim();

    line("  토큰 검증 중...");
    const result = await validateBotToken(botToken);
    if (result.ok) {
      botUsername = result.username || "unknown";
      ok(`봇 확인됨: @${botUsername}`);
      break;
    }
    fail("토큰이 유효하지 않습니다. 다시 입력하세요.");
  }

  // ─── Step 3: Chat ID ───
  section("🆔 Chat ID 확인");

  line("  봇이 나에게만 응답하도록 인증 설정이 필요합니다.");
  line();
  line("  1. 텔레그램에서 @userinfobot 검색");
  line("  2. 아무 메시지를 보내세요");
  line('  3. 봇이 알려주는 "Id" 숫자를 복사');
  line();

  const chatIdsRaw = await input({
    message: "Chat ID (복수면 쉼표로 구분):",
    validate: (v) => {
      const ids = v.split(",").map((s) => s.trim()).filter(Boolean);
      return ids.every((id) => /^\d+$/.test(id)) || "숫자만 입력하세요";
    },
  });

  const userIdsRaw = await input({
    message: "User ID (그룹 승인용, 보통 Chat ID와 동일, Enter로 동일 사용):",
    default: chatIdsRaw,
  });

  // ─── Step 4: AI 프로바이더 ───
  section("🤖 AI 프로바이더 선택");

  const provider = await select({
    message: "사용할 AI 프로바이더:",
    choices: PROVIDERS.map((p) => ({ name: p.name, value: p.value })),
  });

  let apiKey = "";
  if (provider !== "claude-code") {
    const url = PROVIDER_KEY_URLS[provider];
    line();
    line(`  API 키는 ${url} 에서 발급할 수 있습니다.`);
    line("  준비되셨으면 입력하세요.");
    line();

    apiKey = await input({
      message: `${provider} API 키:`,
      validate: (v) => v.trim().length > 10 || "유효한 API 키를 입력하세요",
    });
    apiKey = apiKey.trim();
  } else {
    line();
    line("  Claude Max 구독과 Claude Code 설치가 필요합니다.");
    if (!cmdExists("claude")) {
      fail("Claude Code CLI가 감지되지 않았습니다.");
      line("  npm install -g @anthropic-ai/claude-code 로 설치 후 로그인하세요.");
      const proceed = await confirm({ message: "그래도 계속 진행할까요?", default: false });
      if (!proceed) process.exit(0);
    } else {
      ok("Claude Code CLI 감지됨");
    }
  }

  // ─── Step 5: 선택 기능 ───
  section("⚙️ 추가 기능");

  const briefingEnabled = await confirm({ message: "아침 브리핑 활성화?", default: true });
  let briefingHour = 9;
  if (briefingEnabled) {
    const hourStr = await input({
      message: "브리핑 시간 (0~23시):",
      default: "9",
      validate: (v) => {
        const n = Number(v);
        return (!isNaN(n) && n >= 0 && n <= 23) || "0~23 사이 숫자를 입력하세요";
      },
    });
    briefingHour = Number(hourStr);
  }

  const proactiveEnabled = await confirm({
    message: "클로가 먼저 말 걸기 (Proactive) 활성화?",
    default: true,
  });

  const githubReportEnabled = await confirm({
    message: "GitHub/npm 일일 리포트?",
    default: false,
  });

  let githubRepo = "";
  let npmPackage = "";
  if (githubReportEnabled) {
    githubRepo = await input({ message: "GitHub repo (owner/repo):", default: "" });
    npmPackage = await input({ message: "npm 패키지명:", default: "" });
  }

  // ─── Step 6: 설치 ───
  section("🚀 설치 중");

  const installDir = getInstallDir();
  fs.mkdirSync(path.join(installDir, "data", "sessions"), { recursive: true });

  // .env 생성
  process.stdout.write("  [1/5] .env 파일 생성 중...              ");
  const envLines: string[] = [
    `TELEGRAM_BOT_TOKEN=${botToken}`,
    `PROVIDER=${provider}`,
    `OWNER_CHAT_IDS=${chatIdsRaw}`,
    `OWNER_USER_IDS=${userIdsRaw}`,
    `BRAIN_ROOT=${brainRoot}`,
    `SESSION_DIR=./data/sessions`,
    `BRIEFING_ENABLED=${briefingEnabled}`,
    `BRIEFING_HOUR=${briefingHour}`,
    `PROACTIVE_ENABLED=${proactiveEnabled}`,
    `PROACTIVE_MAX_DAILY=3`,
    `PROACTIVE_MIN_INTERVAL=120`,
  ];

  if (apiKey) {
    envLines.push(`${PROVIDER_ENV_KEY[provider]}=${apiKey}`);
  }
  if (githubReportEnabled) {
    envLines.push(`GITHUB_REPORT_ENABLED=true`);
    if (githubRepo) envLines.push(`GITHUB_REPO=${githubRepo}`);
    if (npmPackage) envLines.push(`NPM_PACKAGE=${npmPackage}`);
  }

  fs.writeFileSync(path.join(installDir, ".env"), envLines.join("\n") + "\n");
  console.log("✅");

  // 빌드 (npm 글로벌 설치 시 dist/가 이미 있으므로 스킵 가능)
  process.stdout.write("  [2/5] 빌드 확인 중...                   ");
  const distIndex = path.join(installDir, "dist", "index.js");
  if (fs.existsSync(distIndex)) {
    console.log("✅ (이미 빌드됨)");
  } else {
    try {
      execSync("npm run build", { cwd: installDir, stdio: "pipe" });
      console.log("✅");
    } catch {
      console.log("❌");
      fail("빌드 실패. npm run build를 직접 실행해 확인하세요.");
      process.exit(1);
    }
  }

  // PM2 설정
  process.stdout.write("  [3/5] PM2 설정 중...                    ");
  if (!cmdExists("pm2")) {
    console.log("");
    line("  PM2가 설치되지 않았습니다. 설치합니다...");
    try {
      execSync("npm install -g pm2", { stdio: "inherit" });
      ok("PM2 설치 완료");
    } catch {
      fail("PM2 설치 실패. 수동으로 설치하세요: npm install -g pm2");
      process.exit(1);
    }
  } else {
    console.log("✅");
  }

  // ecosystem.config.cjs 생성
  const ecosystemContent = `module.exports = {
  apps: [{
    name: "clo-telegram",
    script: "dist/index.js",
    cwd: ${JSON.stringify(installDir.replace(/\\/g, "/"))},
    env: {
      NODE_ENV: "production",
      BOT_NAME_KR: "클로",
      BOT_PERSONA: "clo",
      SESSION_DIR: "./data/sessions",
    },
    max_memory_restart: "512M",
    autorestart: true,
    watch: false,
  }],
};
`;
  fs.writeFileSync(path.join(installDir, "ecosystem.config.cjs"), ecosystemContent);

  // PM2 시작
  process.stdout.write("  [4/5] PM2로 봇 시작 중...               ");
  try {
    // 기존 프로세스가 있으면 삭제
    try { execSync("pm2 delete clo-telegram", { stdio: "pipe" }); } catch { /* 없으면 무시 */ }
    execSync(`pm2 start ${path.join(installDir, "ecosystem.config.cjs")}`, {
      stdio: "pipe",
      cwd: installDir,
    });
    console.log("✅");
  } catch (err) {
    console.log("❌");
    fail("PM2 시작 실패. clo-telegram start로 재시도하세요.");
  }

  // Hooks 설치
  process.stdout.write("  [5/5] Claude Code 알림 훅...            ");
  const useHooks = await confirm({
    message: "VS Code에서 Claude Code를 사용하시나요?",
    default: false,
  });

  if (useHooks) {
    installHooks(installDir);
    console.log("  ✅ 훅 설치 완료");
  } else {
    console.log("  건너뜀");
  }

  // PM2 save
  try { execSync("pm2 save", { stdio: "pipe" }); } catch { /* 무시 */ }

  // ─── Step 7: 완료 ───
  section("✅ 설치 완료!");

  line(`  봇 이름:    @${botUsername}`);
  line(`  프로바이더:  ${provider}`);
  line(`  Brain:      ${brainRoot}`);
  line(`  설치 경로:  ${installDir}`);
  line();
  line("  👉 텔레그램에서 봇에게 메시지를 보내보세요!");
  line();
  line("  유용한 명령어:");
  line("    clo-telegram status   — 실행 상태 확인");
  line("    clo-telegram logs     — 로그 보기");
  line("    clo-telegram restart  — 재시작");
  line("    clo-telegram stop     — 정지");
  line();
}

// ─── 훅 설치 ───

function installHooks(installDir: string): void {
  const hookDir = path.join(os.homedir(), ".claude", "hooks");
  fs.mkdirSync(hookDir, { recursive: true });

  const templateDir = path.join(installDir, "hook-templates");
  if (!fs.existsSync(templateDir)) return;

  const templates = fs.readdirSync(templateDir).filter((f) => f.endsWith(".template"));

  for (const tmpl of templates) {
    const content = fs.readFileSync(path.join(templateDir, tmpl), "utf-8");
    const rendered = content.replace(/__INSTALL_DIR__/g, installDir.replace(/\\/g, "\\\\"));
    const outName = tmpl.replace(".template", "");
    const outPath = path.join(hookDir, outName);

    if (fs.existsSync(outPath)) {
      // 기존 훅이 있으면 스킵 (사용자 커스텀일 수 있음)
      console.log(`    ⚠️ ${outName} 이미 존재 — 건너뜀`);
    } else {
      fs.writeFileSync(outPath, rendered);
      console.log(`    📄 ${outName} 설치됨`);
    }
  }
}

function getInstallDir(): string {
  // npm 글로벌 설치 시 dist/setup.js → 패키지 루트는 한 단계 위
  // 개발 모드 시 src/setup.ts → 패키지 루트는 한 단계 위
  const thisFile = import.meta.url;
  const thisDir = path.dirname(thisFile.startsWith("file://")
    ? thisFile.slice(process.platform === "win32" ? 8 : 7)
    : thisFile);
  return path.resolve(thisDir, "..");
}
