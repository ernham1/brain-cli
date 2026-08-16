#!/usr/bin/env node
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const command = process.argv[2];

function getInstallDir(): string {
  // .env 파일이 있는 디렉토리 = 설치 디렉토리
  // npm 글로벌 설치 시 dist/cli.js → 패키지 루트는 한 단계 위
  return path.resolve(__dirname, "..");
}

function pm2(action: string, extra = ""): void {
  const installDir = getInstallDir();
  const ecosystemPath = path.join(installDir, "ecosystem.config.cjs");
  try {
    execSync(`pm2 ${action} ${ecosystemPath} ${extra}`, {
      stdio: "inherit",
      cwd: installDir,
    });
  } catch {
    if (action === "describe") {
      console.log("clo-telegram이 실행 중이 아닙니다.");
    } else {
      console.error(`pm2 ${action} 실패. PM2가 설치되어 있는지 확인하세요.`);
      console.log("  npm install -g pm2");
    }
  }
}

async function main(): Promise<void> {
  switch (command) {
    case "setup": {
      const { runSetup } = await import("./setup.js");
      await runSetup();
      break;
    }
    case "start":
      pm2("start");
      break;
    case "stop":
      pm2("stop", "clo-telegram");
      break;
    case "restart":
      pm2("restart", "clo-telegram --update-env");
      break;
    case "logs":
      pm2("logs", "clo-telegram --lines 50");
      break;
    case "status":
      pm2("describe", "clo-telegram");
      break;
    default:
      console.log(`
clo-telegram — Brain 연동 AI 텔레그램 봇

사용법:
  clo-telegram setup     대화형 설치 마법사
  clo-telegram start     봇 시작 (PM2)
  clo-telegram stop      봇 정지
  clo-telegram restart   봇 재시작
  clo-telegram logs      로그 보기
  clo-telegram status    실행 상태 확인
      `.trim());
      break;
  }
}

main().catch((err) => {
  console.error("오류:", err.message || err);
  process.exit(1);
});
