import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { filterConversationHistoryForPrompt, formatSdkAutoTerminationNotice, formatSdkResultError } from "../dist/providers.js";
import { sanitizeAgentResponse } from "../dist/agent.js";

const providersSource = readFileSync(new URL("../src/providers.ts", import.meta.url), "utf-8");
const botSource = readFileSync(new URL("../src/bot.ts", import.meta.url), "utf-8");

test("Claude provider does not expose SDK idle hang diagnostics to Telegram", () => {
  const message = formatSdkAutoTerminationNotice("SDK 6분 무응답 (활성 도구 없음)");

  assert.equal(message, "[SKIP]");
  assert.doesNotMatch(message, /SDK|활성 도구|무응답|chat\(\)|tool/i);
  assert.match(
    providersSource,
    /if \(idleHangFired\) \{\s*return formatSdkAutoTerminationNotice\(idleHangReason\);\s*\}/,
  );
  assert.doesNotMatch(providersSource, /자동 종료했어요\$\{reasonSuffix\}/);
  assert.match(botSource, /stripInternalSilenceMarkers\(stripInternalContext\(text\)\)/);
  assert.match(botSource, /if \(!cleaned\) return;/);
});
test("Claude provider does not expose generic SDK execution errors to Telegram", () => {
  const message = formatSdkResultError("error_during_execution", "internal stack trace with tool details");

  assert.equal(message, "[SKIP]");
  assert.doesNotMatch(message, /결과를 확정하지 못했습니다|내부 실행 오류|완료 보고|stack trace|tool/i);
  assert.doesNotMatch(providersSource, /결과를 확정하지 못했습니다/);
});

test("assistant role leak is removed before Telegram persistence", () => {
  const leaked = [
    "정상 답변입니다.",
    "",
    "user codeGPT는 왜 깔린거지?",
    "내가 깐 적이 없는데",
    "두 가지 답해줘",
  ].join("\n");

  assert.equal(sanitizeAgentResponse(leaked), "정상 답변입니다.");
  assert.equal(sanitizeAgentResponse("user guide를 문서에 추가했습니다."), "user guide를 문서에 추가했습니다.");
  assert.match(sanitizeAgentResponse("```text\nuser 질문에 답해줘\n```"), /user 질문에 답해줘/);
});

test("decision briefs are excluded from fresh SDK conversation history", () => {
  const history = [
    { role: "user", content: "안녕하세요" },
    { role: "assistant", content: "결정번호: 클로-7 (7번)\n작업: 별도 작업", contextClass: "decision_brief" },
    { role: "assistant", content: "일반 답변" },
    { role: "assistant", content: "결정번호: 클로-8 (8번)\n작업: 레거시 브리프" },
    { role: "assistant", content: "정상 답변\n\nuser 다음 질문도 답해줘" },
  ];

  assert.deepEqual(filterConversationHistoryForPrompt(history), [
    { role: "user", content: "안녕하세요" },
    { role: "assistant", content: "일반 답변" },
  ]);
});
