"use strict";

const os = require("os");
const path = require("path");
const { publicMonitorResult, runIntegrityMonitor } = require("../src/integrity-monitor");

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

function resolveBrainRoot(env = process.env) {
  return path.resolve(env.BRAIN_ROOT || path.join(os.homedir(), "Brain"));
}

function resolveIntervalMs(env = process.env) {
  const value = Number(env.BRAIN_INTEGRITY_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  return Number.isFinite(value) && value >= 1000 ? value : DEFAULT_INTERVAL_MS;
}

function runOnce(options = {}) {
  const brainRoot = options.brainRoot || resolveBrainRoot(options.env);
  const result = runIntegrityMonitor(brainRoot, { recordEvent: true });
  const output = publicMonitorResult(result);
  const logger = options.logger || console;
  const line = JSON.stringify({ component: "brain-integrity-monitor", ...output });
  if (output.status === "healthy") logger.log(line);
  else logger.error(line);
  return output;
}

function startService(options = {}) {
  const env = options.env || process.env;
  const intervalMs = options.intervalMs || resolveIntervalMs(env);
  const execute = () => {
    try { runOnce({ ...options, env }); }
    catch (error) {
      (options.logger || console).error(JSON.stringify({
        component: "brain-integrity-monitor",
        status: "error",
        generatedAt: new Date().toISOString(),
        message: error.message,
      }));
    }
  };
  execute();
  return setInterval(execute, intervalMs);
}

if (require.main === module) {
  if (process.argv.includes("--once")) {
    try {
      const result = runOnce();
      process.exitCode = result.status === "healthy" ? 0 : result.status === "alert" ? 2 : 3;
    } catch (error) {
      console.error(JSON.stringify({ status: "error", message: error.message }));
      process.exitCode = 1;
    }
  } else {
    startService();
  }
}

module.exports = { DEFAULT_INTERVAL_MS, resolveBrainRoot, resolveIntervalMs, runOnce, startService };