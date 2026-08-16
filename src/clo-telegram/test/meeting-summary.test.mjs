import test from "node:test";
import assert from "node:assert/strict";
import { buildFallbackSummary } from "../dist/modes/summarize.js";

test("buildFallbackSummary returns useful content when local LLM is unavailable", () => {
  const transcript = [
    "[10:01] OBTS RFP를 다음 주까지 준비해야 합니다. AI 자동화 방향을 반영합니다.",
    "[10:05] SDS 과제는 제안서 템플릿을 받아 기술 검토와 초안 작성을 진행합니다.",
    "[10:10] 유도무기 체계는 다음 주 1차 납품 검수가 예정되어 있습니다.",
  ].join("\n");

  const summary = buildFallbackSummary(transcript, undefined, "connection timeout");

  assert.match(summary, /원문 기반 자동 요약/);
  assert.match(summary, /OBTS RFP/);
  assert.match(summary, /액션 아이템/);
  assert.doesNotMatch(summary, /^요약 실패/);
});
