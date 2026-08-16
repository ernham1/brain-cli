import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const agentSource = readFileSync(new URL("../src/agent.ts", import.meta.url), "utf-8");
const schedulerSource = readFileSync(new URL("../src/scheduler.ts", import.meta.url), "utf-8");
const proactiveSource = readFileSync(new URL("../src/proactive.ts", import.meta.url), "utf-8");

test("proactive chat does not resume the normal conversation session", () => {
  const proactiveChatBlock = agentSource.slice(
    agentSource.indexOf("async proactiveChat"),
    agentSource.indexOf("async reminderChat"),
  );

  assert.match(proactiveChatBlock, /proactiveSessionKey = `proactive_\$\{chatId\}`/);
  assert.match(proactiveChatBlock, /resetSession\?\.\(chatId, proactiveSessionKey\)/);
  assert.match(proactiveChatBlock, /this\.provider\.chat\(\s*\[\]/);
  assert.doesNotMatch(proactiveChatBlock, /this\.provider\.chat\(\s*session\.history/);
});

test("proactive scheduler skips recently active conversations", () => {
  assert.match(schedulerSource, /PROACTIVE_RECENT_CONVERSATION_SUPPRESS_MS/);
  assert.match(schedulerSource, /최근 대화가 있어 발송 건너뜀/);
  assert.match(schedulerSource, /Date\.now\(\) - lastMessageTime < PROACTIVE_RECENT_CONVERSATION_SUPPRESS_MS/);
});

test("proactive prompt forbids replaying previous task answers", () => {
  assert.match(proactiveSource, /이전 사용자 질문에 대한 답변/);
  assert.match(proactiveSource, /파일 경로, 작업 완료 결과, 확인 요청을 다시 보내지 마세요/);
  assert.match(proactiveSource, /\[SKIP\]/);
});
