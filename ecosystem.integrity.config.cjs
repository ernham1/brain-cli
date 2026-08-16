"use strict";

const os = require("os");
const path = require("path");

module.exports = {
  apps: [{
    name: "brain-integrity-monitor",
    script: "src/brain-cli/scripts/run-integrity-monitor-service.js",
    cwd: __dirname,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    env: {
      BRAIN_ROOT: process.env.BRAIN_ROOT || path.join(os.homedir(), "Brain"),
      BRAIN_INTEGRITY_INTERVAL_MS: process.env.BRAIN_INTEGRITY_INTERVAL_MS || "900000",
    },
  }],
};