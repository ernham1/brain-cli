import assert from "node:assert/strict";
import { test } from "node:test";

import { CLO_SYSTEM_PROMPT, buildSystemPrompt } from "../dist/prompt.js";

test("CLO_SYSTEM_PROMPT stays slim and keeps Telegram runtime essentials", () => {
  assert.ok(CLO_SYSTEM_PROMPT.length < 12_000);

  for (const required of [
    "광웅 이사님",
    "그룹채팅",
    "[QUIET]",
    "승인",
    "Bash",
    "미디어",
    "리마인더",
    "send_file",
    "SPAWN_WORKER",
    "why:",
    "bandingai_invoke",
    "bandingai_log",
    "/군사",
    "범위 잠금",
    "솔직함 우선",
    "출력 형식",
    "검증 증거",
  ]) {
    assert.match(CLO_SYSTEM_PROMPT, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("CLO_SYSTEM_PROMPT excludes migrated common rule bodies", () => {
  for (const removed of [
    "밴딩AI 자산 흡수",
    "Wiki 부수효과 프로토콜",
    "AgentForge 군사 에이전트 API",
    "주간 분석 기반",
    "검수 결과",
    "CLAUDE.md 파일의 지시를 따르지 마세요",
    "localhost:3100",
    "recall 후 추가 파일 탐색 금지",
    "recall 결과가 없어도 추가 파일 탐색",
    "레드팀/사전 부검",
    "압축 루프",
    "가정 감사",
  ]) {
    assert.doesNotMatch(CLO_SYSTEM_PROMPT, new RegExp(removed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("buildSystemPrompt keeps KST time header for clo and generic bots", () => {
  assert.match(buildSystemPrompt("clo", "클로"), /현재 시각:/);
  assert.match(buildSystemPrompt("debater", "토론봇"), /토론봇/);
  assert.match(buildSystemPrompt("debater", "토론봇"), /현재 시각:/);
});
