import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const agentSource = readFileSync(new URL("../src/agent.ts", import.meta.url), "utf-8");
const botSource = readFileSync(new URL("../src/bot.ts", import.meta.url), "utf-8");
const providersSource = readFileSync(new URL("../src/providers.ts", import.meta.url), "utf-8");

test("bot applies explicit persistence targets before passive group tool restrictions", () => {
  assert.match(botSource, /resolveGroupToolPolicy/);
  assert.match(botSource, /persistenceTargets:/);
  assert.doesNotMatch(botSource, /passiveGroupTurn && !passiveGroupReadOnlyTools/);
});

test("agent retries missing persistence targets and guards completion text", () => {
  assert.match(agentSource, /buildPersistenceExecutionPrompt/);
  assert.match(agentSource, /evaluatePersistenceEvidence/);
  assert.match(agentSource, /missingTargets\.length > 0/);
  assert.match(agentSource, /formatPersistenceCompletion/);
});

test("providers report tool results and suppress duplicate Brain writes per turn", () => {
  assert.match(providersSource, /onToolResult/);
  assert.match(providersSource, /successfulBrainWriteResult/);
  assert.match(providersSource, /중복 저장 생략/);
});
