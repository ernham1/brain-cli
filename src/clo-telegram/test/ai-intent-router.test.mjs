import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_INTENT_ROUTER_SYSTEM_PROMPT,
  buildAiIntentRouterPrompt,
  generalChatDecision,
  parseAiIntentRouterResponse,
} from "../dist/autopilot/ai-intent-router.js";

test("parseAiIntentRouterResponse accepts strict JSON decisions", () => {
  const decision = parseAiIntentRouterResponse(JSON.stringify({
    intent: "dev_handoff",
    confidence: 0.91,
    reason: "코덱스 전달 요청",
    entities: { target: "codex" },
  }));

  assert.equal(decision?.intent, "dev_handoff");
  assert.equal(decision?.safety, "needs_confirmation");
  assert.equal(decision?.entities.target, "codex");
});

test("parseAiIntentRouterResponse extracts fenced JSON and rejects unknown intents", () => {
  const fenced = parseAiIntentRouterResponse("```json\n{\"intent\":\"general_chat\",\"confidence\":0.4,\"reason\":\"일반 문서 작성\"}\n```");
  assert.equal(fenced?.intent, "general_chat");
  assert.equal(fenced?.safety, "pass_to_llm");

  const invalid = parseAiIntentRouterResponse("{\"intent\":\"save_document\",\"confidence\":0.9}");
  assert.equal(invalid, null);
});

test("buildAiIntentRouterPrompt preserves heuristic as hint, not command", () => {
  const prompt = buildAiIntentRouterPrompt({
    text: "비교 분석 문서를 작성해서 저장해줘",
    isGroup: false,
    isMentioned: true,
    heuristicDecision: generalChatDecision("테스트"),
  });

  assert.match(prompt, /heuristicDecision/);
  assert.match(prompt, /비교 분석 문서를 작성해서 저장해줘/);
  assert.match(prompt, /validIntents/);
});

test("AI router prompt limits task_status to explicit status inquiries", () => {
  const prompt = buildAiIntentRouterPrompt({
    text: "각 작업의 완료 기준을 파악하고 있어야 함",
    isGroup: false,
    isMentioned: true,
    heuristicDecision: generalChatDecision("테스트"),
  });

  assert.match(prompt, /task_status/);
  assert.match(AI_INTENT_ROUTER_SYSTEM_PROMPT, /명시적으로 물을 때만/);
  assert.match(AI_INTENT_ROUTER_SYSTEM_PROMPT, /오케스트레이션 설계/);
  assert.match(AI_INTENT_ROUTER_SYSTEM_PROMPT, /단순히 언급/);
});
