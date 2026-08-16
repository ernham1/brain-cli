import "dotenv/config";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig } from "./config.js";
import { createBot } from "./bot.js";
import { ReminderStore, BotScheduler } from "./scheduler.js";
import { TaskRunner } from "./task-runner.js";
import { run } from "@grammyjs/runner";
import { brainCli } from "./brain-resolve.js";

async function startKnowledgeSync(): Promise<void> {
  const claudeMdPath = path.join(os.homedir(), ".claude", "CLAUDE.md");
  const rulesDir = path.join(os.homedir(), ".claude", "rules");

  function readKnowledgeFiles(): string {
    let content = "";
    try {
      content += fs.readFileSync(claudeMdPath, "utf-8");
    } catch { /* 파일 없으면 스킵 */ }
    try {
      const ruleFiles = fs.readdirSync(rulesDir).filter((f) => f.endsWith(".md"));
      for (const f of ruleFiles) {
        content += "\n\n---\n" + fs.readFileSync(path.join(rulesDir, f), "utf-8");
      }
    } catch { /* 디렉토리 없으면 스킵 */ }
    return content;
  }

  // (1) recall로 레코드 존재 확인
  let existingRecordId: string | null = null;
  try {
    const recallResult = execSync(
      'brain-cli recall -g "클로 텔레그램 운영 핵심 요약"',
      { encoding: "utf-8", timeout: 10000, windowsHide: true }
    );
    const match = recallResult.match(/\[(rec_[^\]]+)\]/);
    if (match) existingRecordId = match[1];
  } catch { /* recall 실패 시 신규 생성으로 진행 */ }

  // (2) CLAUDE.md + rules 내용으로 500자 요약 생성
  const knowledgeContent = readKnowledgeFiles();
  const summary = knowledgeContent.slice(0, 500);

  const sourceRef = "00_meta/telegram-knowledge-summary.md";
  const record = {
    scopeType: "user",
    scopeId: "ernham",
    type: "rule",
    sourceType: "user_confirmed",
    title: "클로 텔레그램 운영 핵심 요약",
    summary: "CLAUDE.md + rules 기반 텔레그램 클로 운영 규칙 요약",
    tags: ["domain/memory", "intent/retrieval"],
  };

  function syncKnowledgeContent(content: string, successMessage: string): void {
    const brainRoot = brainCli.getDefaultBrainRoot();
    const engine = new brainCli.BWTEngine(brainRoot);

    const updateIntent = existingRecordId
      ? { action: "update", recordId: existingRecordId, sourceRef, content, record }
      : { action: "create", sourceRef, content, record };

    let result = engine.execute(updateIntent);

    if (!result.success && existingRecordId && JSON.stringify(result.report).includes("미발견")) {
      console.log("[Clo] 레코드 미발견 — create로 폴백");
      result = engine.execute({ action: "create", sourceRef, content, record });
    }

    if (result.success) {
      if (result.recordId) existingRecordId = result.recordId;
      console.log(successMessage);
    } else {
      console.error("[Clo] Brain 동기화 실패:", JSON.stringify(result.report));
    }
  }

  try {
    syncKnowledgeContent(summary, "[Clo] 클로 텔레그램 운영 핵심 요약 Brain 동기화 완료");
  } catch (err) {
    console.error("[Clo] Brain 초기 동기화 실패:", err);
  }

  // (3) fs.watch로 변경 자동 감지
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const onFileChange = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const updatedContent = readKnowledgeFiles().slice(0, 500);
        syncKnowledgeContent(updatedContent, "[Clo] CLAUDE.md 변경 감지 → Brain 지식 동기화 완료");
      } catch (err) {
        console.error("[Clo] Brain 동기화 실패:", err);
      }
    }, 5000);
  };

  try {
    fs.watch(claudeMdPath, onFileChange);
  } catch { /* 파일 없으면 watch 스킵 */ }

  try {
    fs.watch(rulesDir, { recursive: false }, (_, filename) => {
      if (filename?.endsWith(".md")) onFileChange();
    });
  } catch { /* 디렉토리 없으면 watch 스킵 */ }
}

async function main(): Promise<void> {
  console.log("[Clo] 텔레그램 봇 시작 중...");

  const config = loadConfig();
  const displayedModel = config.provider === "codex-sdk"
    ? (config.codexSdkModel || "Codex SDK default")
    : config.model;
  console.log(`[Clo] 프로바이더: ${config.provider}`);
  console.log(`[Clo] 모델: ${displayedModel}`);
  console.log(`[Clo] Brain 경로: ${config.brainRoot}`);
  console.log(`[Clo] 허용 사용자: ${config.ownerChatIds.join(", ")}`);

  const { bot, agent, vscBridge, projectSessionManager, orchestratorRuntime, debateWatcher } = createBot(config);

  // 리마인더 저장소 초기화 + agent에 주입
  const reminderStore = new ReminderStore(config.sessionDir);
  agent.setReminderStore(reminderStore);

  // TaskRunner 초기화 (pending task → 텔레그램 승인 후 agent로 실행)
  const bridgeDir = path.join(process.cwd(), "data", "bridge");
  const taskRunner = new TaskRunner(bridgeDir, agent);

  // 스케줄러 시작 (리마인더 체크 + 일일 브리핑 + proactive)
  const scheduler = new BotScheduler(bot, config, reminderStore);
  scheduler.setAgent(agent);
  scheduler.setVscBridge(vscBridge);
  scheduler.setProjectSessionManager(projectSessionManager);
  scheduler.setTaskRunner(taskRunner);
  scheduler.setBridgeTaskResultHandler({
    handleBridgeTaskResult: async (result) => (await orchestratorRuntime.handleBridgeTaskResult(result))?.message ?? null,
  });
  scheduler.setDesktopSessionEndHandler({
    handleDesktopSessionEnd: (review) => orchestratorRuntime.handleDesktopSessionEnd(review).message,
  });
  scheduler.setDecisionReversalProcessor(orchestratorRuntime);
  scheduler.start();

  // KnowledgeSync 시작 (에러 시 봇 시작 차단 안 함)
  startKnowledgeSync().catch((err) => {
    console.error("[Clo] KnowledgeSync 시작 실패:", err);
  });

  // 자율 토론 감시자 시작 (10초 간격, 0~3초 랜덤 지연으로 봇 간 분산)
  debateWatcher.start(10_000);

  // bot.start()는 업데이트를 순차 처리 → 승인 콜백과 교착 상태 발생
  // run()은 동시 처리 → SDK 대기 중에도 버튼 콜백 수신 가능
  // 시작 전 getUpdates(offset=-1) flush는 재시작 직전/직후 들어온 메시지를
  // 확인 처리해 버릴 수 있다. 중복 응답보다 메시지 유실 위험이 더 크므로
  // runner의 정상 offset 관리에 맡긴다.
  console.log("[Clo] 미확인 업데이트 flush 생략");
  const telegramRunnerOptions = { runner: { silent: true } } as const;
  let runner = run(bot, telegramRunnerOptions);

  // Runner watchdog — ECONNRESET 등으로 polling이 죽으면 자동 재시작
  // grammY runner는 에러 후 자동 복구를 보장하지 않아 수동 감시 필요
  const runnerWatchdog = setInterval(async () => {
    if (!runner.isRunning()) {
      console.log("[Clo] Runner 중단 감지 — 재시작");
      try {
        runner = run(bot, telegramRunnerOptions);
      } catch (e) {
        console.error("[Clo] Runner 재시작 실패:", e);
      }
    }
  }, 15_000);

  // Graceful shutdown
  // runner.stop()은 비동기 — await 없이 호출하면 PM2가 SIGKILL 보내기 전에
  // BWT가 완료되지 않아 .tmp 파일이 잔류함.
  // process.exit(0)으로 명시적 종료해야 PM2가 프로세스 종료를 확인함.
  const shutdown = async (): Promise<void> => {
    console.log("[Clo] 봇 종료 중...");
    // 1. 새 메시지 수신 중단
    clearInterval(runnerWatchdog);
    scheduler.stop();
    debateWatcher.stop();
    await runner.stop();
    // 2. 진행 중인 claude.exe subprocess 정리 (프로세스 누적 방지)
    await agent.cleanup();
    // 3. orphan claude.exe 정리 — pm2 restart 시 Node가 죽어도 자식 프로세스가 남는 문제 방지
    try {
      const myPid = process.pid;
      const wmicOut = execSync(
        `wmic process where "name='claude.exe'" get processid,parentprocessid /format:csv`,
        { encoding: "utf-8", timeout: 5000, windowsHide: true }
      );
      const orphanPids: number[] = [];
      for (const line of wmicOut.split("\n")) {
        const parts = line.trim().split(",");
        if (parts.length >= 3) {
          const ppid = parseInt(parts[1], 10);
          const pid = parseInt(parts[2], 10);
          if (ppid === myPid && !isNaN(pid)) orphanPids.push(pid);
        }
      }
      if (orphanPids.length > 0) {
        console.log(`[Clo] orphan claude.exe ${orphanPids.length}개 정리 중: ${orphanPids.join(", ")}`);
        for (const pid of orphanPids) {
          try { execSync(`taskkill /PID ${pid} /T /F`, { windowsHide: true }); } catch { /* already gone */ }
        }
      }
    } catch (err) {
      console.error("[Clo] orphan 정리 실패 (무시):", err);
    }
    console.log("[Clo] 봇 종료 완료");
    process.exit(0);
  };
  process.on("SIGINT", () => { shutdown().catch(console.error); });
  process.on("SIGTERM", () => { shutdown().catch(console.error); });

  console.log("[Clo] 봇이 시작되었습니다!");
}

main().catch((error) => {
  console.error("[Clo] 봇 시작 실패:", error);
  process.exit(1);
});
