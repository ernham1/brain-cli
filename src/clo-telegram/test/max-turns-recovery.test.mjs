import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const providersSource = readFileSync(new URL("../src/providers.ts", import.meta.url), "utf-8");
const botSource = readFileSync(new URL("../src/bot.ts", import.meta.url), "utf-8");

test("maxTurns no longer creates an automatic worker fallback signal", () => {
  assert.doesNotMatch(providersSource, /MAX_TURNS_RECOVERY/);
  assert.doesNotMatch(providersSource, /buildMaxTurnsRecoverySignal/);
  assert.doesNotMatch(providersSource, /parseMaxTurnsRecoverySignal/);
  assert.doesNotMatch(providersSource, /워커 자동 전환 시그널/);
  assert.match(providersSource, /formatSdkResultError\("error_max_turns", msg\)/);
});

test("bot starts background workers only from LLM SPAWN_WORKER signals", () => {
  assert.doesNotMatch(botSource, /parseMaxTurnsRecoverySignal/);
  assert.match(botSource, /parseWorkerSignal\(response\)/);
  assert.match(botSource, /워커 생성은 LLM이 \[SPAWN_WORKER\] 시그널을 낸 경우에만 수행한다/);
});