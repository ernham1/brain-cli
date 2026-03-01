import "dotenv/config";
import { loadConfig } from "./config.js";
import { createBot } from "./bot.js";
import { ReminderStore, BotScheduler } from "./scheduler.js";
import { run } from "@grammyjs/runner";

async function main(): Promise<void> {
  console.log("[Clo] 텔레그램 봇 시작 중...");

  const config = loadConfig();
  console.log(`[Clo] 프로바이더: ${config.provider}`);
  console.log(`[Clo] 모델: ${config.model}`);
  console.log(`[Clo] Brain 경로: ${config.brainRoot}`);
  console.log(`[Clo] 허용 사용자: ${config.ownerChatIds.join(", ")}`);

  const { bot, agent } = createBot(config);

  // 리마인더 저장소 초기화 + agent에 주입
  const reminderStore = new ReminderStore(config.sessionDir);
  agent.setReminderStore(reminderStore);

  // 스케줄러 시작 (리마인더 체크 + 일일 브리핑)
  const scheduler = new BotScheduler(bot, config, reminderStore);
  scheduler.start();

  // bot.start()는 업데이트를 순차 처리 → 승인 콜백과 교착 상태 발생
  // run()은 동시 처리 → SDK 대기 중에도 버튼 콜백 수신 가능
  const runner = run(bot);

  // Graceful shutdown
  const shutdown = (): void => {
    console.log("[Clo] 봇 종료 중...");
    scheduler.stop();
    runner.stop();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("[Clo] 봇이 시작되었습니다!");
}

main().catch((error) => {
  console.error("[Clo] 봇 시작 실패:", error);
  process.exit(1);
});
