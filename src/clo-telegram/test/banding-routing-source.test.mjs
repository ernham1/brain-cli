import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const sessionSource = readFileSync(new URL("../src/session.ts", import.meta.url), "utf-8");
const agentSource = readFileSync(new URL("../src/agent.ts", import.meta.url), "utf-8");
const sharedStateSource = readFileSync(new URL("../src/banding-routing-state.ts", import.meta.url), "utf-8");
const botSource = readFileSync(new URL("../src/bot.ts", import.meta.url), "utf-8");
const promptSource = readFileSync(new URL("../src/prompt.ts", import.meta.url), "utf-8");

test("BandingAI routing state is persisted on session data", () => {
  assert.match(sessionSource, /bandingAiRouting\?: \{/);
  assert.match(sessionSource, /forced: boolean/);
  assert.match(sessionSource, /updatedAt: string/);
});

test("/밴딩 command toggles forced routing and cancels active workers on off", () => {
  assert.match(botSource, /bot\.command\("밴딩"/);
  assert.match(botSource, /setBandingAiRouting\(ctx\.chat\.id, userId, true, userId\)/);
  assert.match(botSource, /setBandingAiRouting\(ctx\.chat\.id, userId, false, userId\)/);
  assert.match(botSource, /cancelActiveWorkers\(ctx\.chat\.id\)/);
});

test("forced routing prompt is injected only when session routing is on", () => {
  assert.match(agentSource, /session\.bandingAiRouting\?\.forced === true/);
  assert.match(agentSource, /startedWithForcedBandingAiRouting/);
  assert.match(agentSource, /BandingAI 위임 결과는 \/밴딩 off 전환 이후 도착해서 보고하지 않았습니다/);
  assert.match(agentSource, /buildBandingAiForcedRoutingSection/);
  assert.match(agentSource, /orchestrator-agent/);
  assert.match(agentSource, /writer 또는 deliverer/);
});

test("base prompt documents MCP-only BandingAI routing policy", () => {
  assert.match(promptSource, /텔레클로 MCP 경로에만 적용/);
  assert.match(promptSource, /\/밴딩 on/);
  assert.match(promptSource, /orchestrator-agent/);
  assert.match(promptSource, /writer 또는 deliverer/);
});


test("shared BandingAI routing state lives in Brain active state", () => {
  assert.match(sharedStateSource, /41_active/);
  assert.match(sharedStateSource, /bandingai-routing\.json/);
  assert.match(agentSource, /readSharedBandingAiRoutingState/);
  assert.match(agentSource, /writeSharedBandingAiRoutingState/);
  assert.match(agentSource, /writeSharedBandingAiRoutingState\(forced/);
});

