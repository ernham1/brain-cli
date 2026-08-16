import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildDailyDecisionDigest, readDecisionsForDate } from "../dist/orchestrator/decision-digest.js";

function row(id, twin, human = null, question = "[PASS] 샘플 작업 · summary") {
  return {
    id,
    ts: `2026-07-04T10:0${id.slice(-1)}:00+09:00`,
    session: "teleclo-orchestrator",
    project: "sample",
    decisionType: "dev",
    question,
    irreversible: false,
    irreversibleClass: null,
    mode: "live",
    blind: false,
    twin,
    human,
  };
}

const gateAuto = { twinVersion: "gate-auto", knowledgePackHash: "n/a", verdict: "approve", latencyMs: 0 };
const twinReject = { twinVersion: "twin-v1", knowledgePackHash: "h", verdict: "reject", confidence: 0.7, latencyMs: 3 };
const twinHigh = { twinVersion: "twin-v1", knowledgePackHash: "h", verdict: "approve", confidence: 0.85, latencyMs: 3 };
const llmReject = { twinVersion: "twin-v2-llm", knowledgePackHash: "h", verdict: "reject", confidence: 0.8, latencyMs: 900 };
const escalate = { twinVersion: "twin-v1", knowledgePackHash: "h", verdict: "escalate", confidence: 1, latencyMs: 2 };

test("다이제스트: 건수 요약과 중요 검토 권장만 뽑는다", () => {
  const rows = [
    row("dj-20260704-1000-aa01", gateAuto),                      // 자율승인: 검토 제외
    row("dj-20260704-1000-aa02", gateAuto),
    row("dj-20260704-1000-aa03", twinReject),                    // 저확신 0.7: 권장
    row("dj-20260704-1000-aa04", twinHigh),                      // 0.85: 제외
    row("dj-20260704-1000-aa05", llmReject),                     // LLM 판정: 권장
    row("dj-20260704-1000-aa06", escalate),                      // 에스컬레이션 미기록: 권장
    row("dj-20260704-1000-aa07", escalate, { decision: "approve", decidedAt: "2026-07-04T11:00:00+09:00" }), // 기록됨: 제외
    row("dj-20260704-1000-aa08", null),                          // 트윈 미실행: 권장
  ];
  const digest = buildDailyDecisionDigest(rows, "2026-07-04");

  assert.equal(digest.total, 8);
  assert.equal(digest.counts.autoApproved, 2);
  assert.equal(digest.counts.twinDecided, 3);
  assert.equal(digest.counts.escalated, 3);
  assert.equal(digest.counts.humanTouched, 1);
  assert.equal(digest.reviewItems.length, 4);
  const tags = digest.reviewItems.map((item) => item.tag);
  assert.equal(tags.filter((tag) => tag === "트윈 reject").length, 2);

  assert.ok(tags.some((t) => t.includes("에스컬레이션 미기록")));
  assert.ok(tags.some((t) => t.includes("트윈 미실행")));
  assert.match(digest.message, /오늘 결정 8건/);
  assert.match(digest.message, /검토 권장 4건/);
  assert.match(digest.message, /4877/);
  assert.ok(digest.message.length < 4000, "텔레그램 한도 내여야 함");
});

test("다이제스트: 검토 권장이 없으면 그렇게 말한다", () => {
  const digest = buildDailyDecisionDigest([row("dj-20260704-1000-bb01", gateAuto)], "2026-07-04");
  assert.match(digest.message, /검토 권장: 없음/);
});

test("다이제스트: shadow 블라인드 대기 행은 무작위 표본에서 판정·확신도를 노출하지 않는다", () => {
  const batchJudged = {
    twinVersion: "twin-v2-llm-batch",
    knowledgePackHash: "h",
    verdict: "approve",
    confidence: 0.85,
    latencyMs: 24000,
  };
  const blindPending = { ...row("dj-20260704-1000-dd01", batchJudged), mode: "shadow", blind: true };
  const reviewed = {
    ...row("dj-20260704-1000-dd02", batchJudged, { decision: "approve", decidedAt: "2026-07-04T12:00:00+09:00" }),
    mode: "shadow",
    blind: true,
  };
  const digest = buildDailyDecisionDigest([blindPending, reviewed], "2026-07-04", [blindPending, reviewed]);
  assert.ok(!digest.reviewItems.some((entry) => entry.id === blindPending.id), "중요하지 않은 블라인드 대기는 당일 권장에서 제외");
  assert.ok(digest.sampleItems.some((entry) => entry.id === blindPending.id), "미검토 블라인드 행은 무작위 표본에 포함");

  assert.ok(!digest.message.includes("approve"), "메시지에 판정 미노출");
  assert.ok(!digest.message.includes("0.85"), "메시지에 확신도 미노출");
  assert.ok(!digest.sampleItems.some((entry) => entry.id === reviewed.id), "이미 검토된 shadow 행은 표본 제외");
});

test("readDecisionsForDate: 해당 날짜 행만, 같은 id는 마지막 행 채택", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-digest-"));
  mkdirSync(dir, { recursive: true });
  const target = row("dj-20260704-1000-cc01", twinReject);
  const updated = { ...target, human: { decision: "approve", decidedAt: "2026-07-04T12:00:00+09:00" } };
  const otherDay = { ...row("dj-20260703-1000-cc02", gateAuto), ts: "2026-07-03T10:00:00+09:00" };
  writeFileSync(
    path.join(dir, "2026-07.jsonl"),
    [target, otherDay, updated].map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf-8",
  );
  const rows = readDecisionsForDate("2026-07-04", dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].human?.decision, "approve", "마지막 행(인간 결정 반영)이어야 함");
  assert.equal(readDecisionsForDate("2026-07-01", dir).length, 0);
});
