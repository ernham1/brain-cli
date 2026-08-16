import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configSource = readFileSync(resolve(root, "src/config.ts"), "utf-8");
const providersSource = readFileSync(resolve(root, "src/providers.ts"), "utf-8");
const runnerPath = resolve(root, "tools/codex-sdk-run.py");

test("codex-sdk provider is selectable without API key", () => {
  assert.match(configSource, /"codex-sdk"/);
  assert.match(configSource, /Codex 앱\/CLI 로컬 인증 재사용/);
  assert.match(configSource, /codexSdkModel/);
  assert.match(configSource, /CODEX_SDK_MODEL/);
  assert.match(providersSource, /class CodexSdkProvider/);
  assert.match(providersSource, /case "codex-sdk"/);
  assert.match(providersSource, /this\.model = config\.codexSdkModel/);
  assert.match(providersSource, /spawnCliProcess/);
});

test("codex-sdk runner is available for TeleClo runtime", () => {
  assert.equal(existsSync(runnerPath), true);
  const runnerSource = readFileSync(runnerPath, "utf-8");
  assert.match(runnerSource, /from openai_codex import Codex/);
  assert.match(runnerSource, /Sandbox\.read_only/);
  assert.match(runnerSource, /retry_on_overload/);
});
