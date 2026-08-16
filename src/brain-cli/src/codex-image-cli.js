#!/usr/bin/env node
"use strict";

const { generateCodexImage, getCodexSubscriptionStatus } = require("./codex-image");

function parseRequest(argv) {
  const requestIndex = argv.indexOf("--request-base64");
  if (requestIndex < 0 || !argv[requestIndex + 1]) {
    throw new Error("--request-base64 인자가 필요합니다.");
  }
  const json = Buffer.from(argv[requestIndex + 1], "base64url").toString("utf-8");
  return JSON.parse(json);
}

async function main() {
  if (process.argv.includes("--check")) {
    const status = await getCodexSubscriptionStatus();
    process.stdout.write(`${JSON.stringify(status)}\n`);
    process.exitCode = status.ok ? 0 : 1;
    return;
  }

  const request = parseRequest(process.argv.slice(2));
  const result = await generateCodexImage(request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
