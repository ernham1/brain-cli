"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { init } = require("../src/init");
const { createIntegrityBaseline, readLatestIntegrityEvent } = require("../src/integrity-monitor");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForHealth(port) {
  const url = `http://127.0.0.1:${port}/api/health`;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await globalThis.fetch(url);
      if (response.ok) return response.json();
    } catch { /* server starting */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`health timeout: ${url}`);
}

describe("integrity monitor service", () => {
  it("--once는 즉시 event를 남기고 정상 종료한다", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brain-monitor-service-"));
    const brainRoot = init(parent).brainRoot;
    try {
      createIntegrityBaseline(brainRoot, path.join(brainRoot, "90_index", "integrity-monitor", "baseline.json"));
      const script = path.join(__dirname, "..", "scripts", "run-integrity-monitor-service.js");
      const result = spawnSync(process.execPath, [script, "--once"], {
        env: { ...process.env, BRAIN_ROOT: brainRoot },
        encoding: "utf8",
        windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(readLatestIntegrityEvent(brainRoot).status, "healthy");
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("health는 audit 재실행 없이 latest event를 노출한다", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brain-monitor-health-"));
    const brainRoot = init(parent).brainRoot;
    const monitorScript = path.join(__dirname, "..", "scripts", "run-integrity-monitor-service.js");
    const serverScript = path.resolve(__dirname, "..", "..", "brain-server", "index.js");
    let child;
    try {
      createIntegrityBaseline(brainRoot, path.join(brainRoot, "90_index", "integrity-monitor", "baseline.json"));
      const run = spawnSync(process.execPath, [monitorScript, "--once"], {
        env: { ...process.env, BRAIN_ROOT: brainRoot }, encoding: "utf8", windowsHide: true,
      });
      assert.equal(run.status, 0, run.stderr || run.stdout);
      const port = await freePort();
      child = spawn(process.execPath, [serverScript], {
        env: { ...process.env, PORT: String(port), BRAIN_ROOT: brainRoot, BRAIN_API_KEY: "" },
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      const health = await waitForHealth(port);
      assert.equal(health.integrity.status, "healthy");
      assert.equal(health.integrity.summary.newIssues, 0);
    } finally {
      if (child) child.kill();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});