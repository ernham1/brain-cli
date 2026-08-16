module.exports = {
  apps: [
    {
      name: "clo-telegram",
      script: "dist/index.js",
      cwd: "C:/Projects/Brain/src/clo-telegram",
      env: {
        PROVIDER: "claude-code",
        MODEL: "claude-opus-5",
        BOT_NAME_KR: "클로",
        BOT_PERSONA: "clo",
        SESSION_DIR: "./data/sessions",
        CLO_PROJECT_ROOT: "D:/Projects",
        BRAIN_ENABLED: "true",
        BRAIN_ROOT: "C:/Users/ernham/Brain",
        BRAIN_CLI_PATH: "C:/Projects/Brain/src/brain-cli/src",
        OBSIDIAN_ROOT: "G:/내 드라이브/메모/OBSIDIAN_Memo",
      },

      // SIGTERM → SIGKILL 사이 대기 시간
      // BWT(Brain Write Transaction)가 완료될 시간 확보
      // 기본 1600ms → 30초: agent.chat() 실행 중 restart 시에도 BWT 완료 보장
      kill_timeout: 30000,

      exec_mode: "fork",
      instances: 1,

      // dist 폴더 변경 감지 → 자동 재시작 (빌드 후 pm2 restart 불필요)
      watch: ["dist"],
      watch_delay: 3000,
      ignore_watch: ["node_modules", "logs", "src"],

      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",

      out_file: "logs/out.log",
      error_file: "logs/error.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};

