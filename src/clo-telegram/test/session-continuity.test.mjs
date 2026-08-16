import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildPendingDecisionBriefSection, extractDecisionBriefReferenceNumbers, isShortExecutionConfirmation } from "../dist/agent.js";
import { SessionManager, makeSessionKey } from "../dist/session.js";

test("SessionManager preserves recent dialogue excerpt when idle reset starts a new session", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-session-continuity-"));
  try {
    const manager = new SessionManager(dir);
    const session = manager.getOrCreate(64445716);
    session.lastMessageAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    session.history = [
      { role: "user", content: "AIOS 오케스트레이터 세션 복원 구조 확인해줘" },
      { role: "assistant", content: "세션 복원은 직전 대화 일부와 완료 기준을 함께 넘겨야 합니다." },
      { role: "user", content: "그럼 신규 세션에서도 이 맥락을 가져와야겠네" },
    ];
    manager.save(session);

    const reset = manager.getOrCreate(64445716);

    assert.equal(reset.history.length, 0);
    assert.match(reset.historySummary ?? "", /세션 자동 종료/);
    assert.match(reset.historySummary ?? "", /직전 대화 일부/);
    assert.match(reset.historySummary ?? "", /AIOS 오케스트레이터/);
    assert.match(reset.historySummary ?? "", /완료 기준/);
    assert.match(reset.historySummary ?? "", /신규 세션/);

    const loaded = manager.load(makeSessionKey(64445716));
    assert.equal(loaded?.history.length, 0);
    assert.match(loaded?.historySummary ?? "", /AIOS 오케스트레이터/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionManager numbers decision briefs and preserves pending references", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-session-decision-ref-"));
  try {
    const manager = new SessionManager(dir);
    const first = manager.recordDecisionBrief(64445716, [
      "판단: 이사님 결정 필요",
      "작업: agentforge 남은 작업 계속 진행",
      "질문: 아래 작업자 보고를 완료로 인정할까요?",
      "선택지: A 완료 인정 / B 빠진 부분 재작업 / C 근거 더 요청",
    ].join("\n"), { source: "bridge_result", taskId: "task_a", sourceMessageId: 10 });
    const second = manager.recordDecisionBrief(64445716, [
      "판단: 이사님 결정 필요",
      "작업: nexus 남은 작업 계속 진행",
      "선택지: A 완료 인정 / B 빠진 부분 재작업 / C 근거 더 요청",
    ].join("\n"), { source: "bridge_result", taskId: "task_b", sourceMessageId: 11 });

    assert.match(first, /결정번호: 클로-1 \(1번\)/);
    assert.match(second, /결정번호: 클로-2 \(2번\)/);

    const loaded = manager.load(makeSessionKey(64445716));
    assert.equal(loaded?.decisionBriefSequence, 2);
    assert.equal(loaded?.pendingDecisionBriefs?.length, 2);
    assert.equal(loaded?.pendingDecisionBriefs?.[0].label, "클로-1");
    assert.equal(loaded?.pendingDecisionBriefs?.[1].taskId, "task_b");
    assert.match(loaded?.history.at(-1)?.content ?? "", /결정번호: 클로-2/);
    assert.equal(loaded?.history.at(-1)?.contextClass, "decision_brief");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pending decision briefs do not hijack short GO confirmations", () => {
  const session = {
    chatId: 64445716,
    history: [],
    createdAt: "2026-06-29T00:00:00.000Z",
    lastMessageAt: "2026-06-30T00:00:00.000Z",
    pendingDecisionBriefs: [
      {
        number: 27,
        label: "클로-27",
        source: "bridge_result",
        title: "agentforge 남은 작업 계속 진행",
        question: "이 작업자 보고를 완료로 인정할까요?",
        options: "A 완료 인정 / B 빠진 부분 재작업 / C 근거 더 요청",
        message: "결정번호: 클로-27 (27번)\n작업: agentforge 남은 작업 계속 진행",
        createdAt: "2026-06-29T00:00:00.000Z",
        status: "pending",
      },
      {
        number: 28,
        label: "클로-28",
        source: "bridge_result",
        title: "aios 남은 작업 계속 진행",
        question: "이 작업자 보고를 완료로 인정할까요?",
        options: "A 완료 인정 / B 빠진 부분 재작업 / C 근거 더 요청",
        message: "결정번호: 클로-28 (28번)\n작업: aios 남은 작업 계속 진행",
        createdAt: "2026-06-29T01:00:00.000Z",
        status: "pending",
      },
    ],
  };
  const now = new Date("2026-06-30T03:00:00.000Z").getTime();

  const goSection = buildPendingDecisionBriefSection(session, "GO", now);
  assert.match(goSection, /짧은 실행 승인/);
  assert.match(goSection, /직전 대화/);
  assert.doesNotMatch(goSection, /agentforge/);
  assert.doesNotMatch(goSection, /aios/);
  assert.doesNotMatch(goSection, /클로-27/);
  assert.doesNotMatch(goSection, /클로-28/);

  const unrelatedSection = buildPendingDecisionBriefSection(session, "CodeGPT는 왜 설치된 거야?", now);
  assert.equal(unrelatedSection, "");

  const numberedSection = buildPendingDecisionBriefSection(session, "클로-28 GO", now);
  assert.match(numberedSection, /클로-28/);
  assert.match(numberedSection, /aios 남은 작업 계속 진행/);
  assert.doesNotMatch(numberedSection, /agentforge/);

  assert.deepEqual(extractDecisionBriefReferenceNumbers("클로-28 GO"), [28]);
  assert.deepEqual(extractDecisionBriefReferenceNumbers("28번은 B로 해줘"), [28]);
  assert.equal(isShortExecutionConfirmation("GO"), true);
  assert.equal(isShortExecutionConfirmation("agentforge 남은 작업 계속 진행"), false);
});