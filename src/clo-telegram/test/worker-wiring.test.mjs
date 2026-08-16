import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const botSource = readFileSync(new URL("../src/bot.ts", import.meta.url), "utf-8");
const agentSource = readFileSync(new URL("../src/agent.ts", import.meta.url), "utf-8");
const providerSource = readFileSync(new URL("../src/providers.ts", import.meta.url), "utf-8");

test("bot uses worker contract parser and completion evidence gate", () => {
  assert.match(botSource, /parseWorkerSignal/);
  assert.match(botSource, /evaluateWorkerCompletion/);
  assert.match(botSource, /buildWorkerExecutionContract/);
  assert.match(botSource, /clearPersistedWorkerStatuses/);
  assert.doesNotMatch(botSource, /task:\\s\*\(\[\\s\\S\]\*\?\)\(\?:\\ncontext:\|\\n\\\[/);
});

test("worker cancellation reaches the Claude SDK query", () => {
  assert.match(agentSource, /abortController\?: AbortController/);
  assert.match(providerSource, /abortController\?: AbortController/);
  assert.match(providerSource, /abortController: opts\.abortController/);
  assert.match(botSource, /abortController\.abort\("TIMEOUT"\)/);
  assert.match(botSource, /abortController: abortController/);
});

test("worker commander review has read tools instead of tools disabled", () => {
  assert.match(botSource, /readOnlyTools: true/);
  assert.doesNotMatch(botSource, /agent\.chat\(chatId, handoffMsg, userId, \{ maxTurns: 20, disableTools: true \}\)/);
});

