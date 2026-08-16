import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DecisionJournal } from "../dist/orchestrator/decision-journal.js";
import { OrchestratorBridgeRuntime } from "../dist/orchestrator/bridge-runtime.js";
import { OrchestratorStore } from "../dist/orchestrator/store.js";
import { TwinDecider } from "../dist/orchestrator/twin-decider.js";

function createRuntimeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-orchestrator-runtime-"));
  const createdBridgeTasks = [];
  const runtime = new OrchestratorBridgeRuntime({
    store: new OrchestratorStore(path.join(dir, "orchestrator")),
    // v1 기준 흐름 검증: 트윈 비활성(지식팩 없음) + 저널 격리 (실제 ~/.claude 저널 오염 금지)
    twinDecider: new TwinDecider({ knowledgePackPath: path.join(dir, "no-pack.md") }),
    decisionJournal: new DecisionJournal(path.join(dir, "decision-journal")),
    reversalsDir: path.join(dir, "reversals"),
    bridgeTaskCreator: {
      createTask: (params) => {
        const taskId = `task_${createdBridgeTasks.length + 1}`;
        createdBridgeTasks.push({ taskId, ...params });
        return taskId;
      },
    },
  });
  return { dir, runtime, createdBridgeTasks };
}

test("OrchestratorBridgeRuntime tracks bridge dispatch and evaluates LIGHT result as draft", async () => {
  const fixture = createRuntimeFixture();
  try {
    const dispatch = fixture.runtime.trackBridgeDispatch({
      sourceChatId: 123,
      sourceMessageId: 456,
      targetCwd: "C:/Projects/Brain",
      instruction: "방향만 초안으로 정리해줘",
      targetAgent: "desktop-clo",
      projectHint: "clo-telegram",
      telecloDecision: {
        evaluationProfile: "light",
        claimLevel: "draft",
        successCriteria: ["초안 결과 작성"],
      },
    });

    assert.equal(dispatch.dispatched, true);
    assert.equal(dispatch.bridgeTaskId, "task_1");
    assert.equal(fixture.createdBridgeTasks.length, 1);

    const evaluated = await fixture.runtime.handleBridgeTaskResult({
      taskId: "task_1",
      sourceChatId: 123,
      sourceMessageId: 456,
      status: "completed",
      result: "초안 결과입니다.",
      completedAt: "2026-06-12T00:00:00.000Z",
    });

    assert.equal(evaluated?.evaluation.decision, "DRAFT");
    assert.equal(evaluated?.message, null);

    const stored = fixture.runtime.store.get(dispatch.orchestratorTaskId);
    assert.equal(stored?.status, "reported");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("OrchestratorBridgeRuntime does not block dispatch from runtime text filtering", async () => {
  const fixture = createRuntimeFixture();
  try {
    const dispatch = fixture.runtime.trackBridgeDispatch({
      sourceChatId: 123,
      sourceMessageId: 456,
      targetCwd: "C:/Projects/Brain",
      instruction: "운영 배포 삭제 보안 권한 마이그레이션까지 검토해줘",
      targetAgent: "desktop-clo",
      projectHint: "clo-telegram",
    });

    assert.equal(dispatch.dispatched, true);
    assert.equal(dispatch.bridgeTaskId, "task_1");
    assert.doesNotMatch(dispatch.message, /RED 위험 작업이라 자동 전달하지 않았습니다/);

    const stored = fixture.runtime.store.get(dispatch.orchestratorTaskId);
    assert.equal(stored?.taskType, "general");
    assert.equal(stored?.riskLevel, "yellow");
    assert.equal(stored?.claimLevel, "review_needed");
    assert.deepEqual(stored?.evaluationPlan.lockedCriteria, ["텔레클로가 위임한 원 지시 수행"]);

    const plannedEvent = fixture.runtime.store
      .listEvents(dispatch.orchestratorTaskId)
      .find((event) => event.status === "planned");
    assert.equal(plannedEvent?.details.decisionSource, "runtime-default");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("OrchestratorBridgeRuntime accepts TeleClo decision as the source of planning truth", async () => {
  const fixture = createRuntimeFixture();
  try {
    const dispatch = fixture.runtime.trackBridgeDispatch({
      sourceChatId: 123,
      sourceMessageId: 456,
      targetCwd: "C:/Projects/Brain",
      instruction: "구현하고 빌드까지 확인해줘",
      targetAgent: "desktop-clo",
      projectHint: "clo-telegram",
      telecloDecision: {
        objective: "오케스트레이터 런타임 의도 우선권 검증",
        taskType: "code",
        riskLevel: "red",
        evaluationProfile: "strict",
        claimLevel: "pass_eligible",
        successCriteria: ["빌드 통과", "관련 테스트 통과"],
        hardConstraints: ["텔레클로 판단을 런타임 정규식보다 우선"],
        exclusions: ["사전 차단 금지"],
        gates: [
          { kind: "risk", required: true, params: { source: "teleclo" } },
          { kind: "contract", required: true, params: { source: "teleclo" } },
          { kind: "evidence", required: true, params: { source: "teleclo" } },
          { kind: "build", required: true, params: { command: "npm run build" } },
          { kind: "test", required: true, params: { command: "node --test" } },
        ],
        notes: "텔레클로가 위험도와 검증 강도를 직접 결정한 케이스",
      },
    });

    assert.equal(dispatch.dispatched, true);

    const stored = fixture.runtime.store.get(dispatch.orchestratorTaskId);
    assert.equal(stored?.objective, "오케스트레이터 런타임 의도 우선권 검증");
    assert.equal(stored?.taskType, "code");
    assert.equal(stored?.riskLevel, "red");
    assert.equal(stored?.evaluationProfile, "strict");
    assert.equal(stored?.claimLevel, "pass_eligible");
    assert.deepEqual(stored?.evaluationPlan.lockedCriteria, ["빌드 통과", "관련 테스트 통과"]);
    assert.deepEqual(stored?.ownerDirectives.hardConstraints, ["텔레클로 판단을 런타임 정규식보다 우선"]);
    assert.deepEqual(stored?.scope.exclude, ["사전 차단 금지"]);
    assert.deepEqual(stored?.evaluationPlan.gates.map((gate) => gate.kind), [
      "risk",
      "contract",
      "evidence",
      "build",
      "test",
    ]);

    const plannedEvent = fixture.runtime.store
      .listEvents(dispatch.orchestratorTaskId)
      .find((event) => event.status === "planned");
    assert.equal(plannedEvent?.details.decisionSource, "teleclo");
    assert.equal(plannedEvent?.details.notes, "텔레클로가 위험도와 검증 강도를 직접 결정한 케이스");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("OrchestratorBridgeRuntime does not report PASS when required evaluator is missing", async () => {
  const fixture = createRuntimeFixture();
  try {
    const dispatch = fixture.runtime.trackBridgeDispatch({
      sourceChatId: 123,
      sourceMessageId: 456,
      targetCwd: "C:/Projects/Brain",
      instruction: "빌드 통과까지 구현하고 테스트까지 해줘",
      targetAgent: "desktop-clo",
      projectHint: "clo-telegram",
      telecloDecision: {
        taskType: "code",
        evaluationProfile: "strict",
        claimLevel: "pass_eligible",
        successCriteria: ["빌드 통과", "관련 테스트 통과"],
        gates: [
          { kind: "risk", required: true, params: {} },
          { kind: "contract", required: true, params: {} },
          { kind: "evidence", required: true, params: {} },
          { kind: "build", required: true, params: {} },
          { kind: "test", required: true, params: {} },
          { kind: "lint", required: true, params: {} },
          { kind: "rubric", required: true, params: {} },
        ],
      },
    });

    const evaluated = await fixture.runtime.handleBridgeTaskResult({
      taskId: dispatch.bridgeTaskId,
      sourceChatId: 123,
      sourceMessageId: 456,
      status: "completed",
      result: "작업자가 완료했다고 보고했습니다.",
      completedAt: "2026-06-12T00:00:00.000Z",
    });

    assert.equal(evaluated?.evaluation.decision, "ASK");
    assert.doesNotMatch(evaluated?.message ?? "", /판정: PASS/);
    assert.match(evaluated?.message ?? "", /판단: 이사님 결정 필요/);
    assert.match(evaluated?.message ?? "", /필요한 자동 검증을 실행할 수 없었습니다/);
    assert.match(evaluated?.message ?? "", /선택지: A 보고 내용으로 승인 \/ B 검증 후 다시 판단 \/ C 증거 요청/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});


test("OrchestratorBridgeRuntime sends actionable REVIEW_NEEDED briefs", async () => {
  const fixture = createRuntimeFixture();
  try {
    const dispatch = fixture.runtime.trackBridgeDispatch({
      sourceChatId: 123,
      sourceMessageId: 456,
      targetCwd: "C:/Projects/Brain",
      instruction: "완료 결과를 확인해줘",
      targetAgent: "desktop-clo",
      projectHint: "clo-telegram",
      telecloDecision: {
        objective: "nexus 남은 작업 계속 진행",
        evaluationProfile: "standard",
        claimLevel: "review_needed",
        successCriteria: ["완료 주장 전 이사님 확인"],
      },
    });

    const evaluated = await fixture.runtime.handleBridgeTaskResult({
      taskId: dispatch.bridgeTaskId,
      sourceChatId: 123,
      sourceMessageId: 456,
      status: "completed",
      result: "완료 주장 전 이사님 확인이 필요합니다. 산출물은 docs/review.md에 정리했습니다.",
      completedAt: "2026-06-24T00:00:00.000Z",
    });

    assert.equal(evaluated?.evaluation.decision, "REVIEW_NEEDED");
    assert.match(evaluated?.message ?? "", /질문: 이 보고를 완료로 인정할까요/);
    assert.match(evaluated?.message ?? "", /현재 상태: 작업자는 완료했다고 보고했습니다/);
    assert.match(evaluated?.message ?? "", /완료 기준: 완료 주장 전 이사님 확인/);
    assert.match(evaluated?.message ?? "", /선택지: A 완료 인정 \/ B 빠진 부분 재작업 \/ C 근거 더 요청/);
    assert.doesNotMatch(evaluated?.message ?? "", /gate|claimLevel|lockedCriteria|taskId|rec_/);
    assert.doesNotMatch(evaluated?.message ?? "", /기준=없음/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
test("OrchestratorBridgeRuntime reworks bookkeeping-only worker results without asking the owner", async () => {
  const fixture = createRuntimeFixture();
  try {
    const dispatch = fixture.runtime.trackBridgeDispatch({
      sourceChatId: 123,
      sourceMessageId: 456,
      targetCwd: "C:/Projects/AgentForge",
      instruction: "agentforge 남은 작업 계속 진행",
      targetAgent: "desktop-clo",
      projectHint: "agentforge",
      telecloDecision: {
        objective: "agentforge 남은 작업 계속 진행",
        evaluationProfile: "standard",
        claimLevel: "review_needed",
        successCriteria: ["cron 등록 미완료 상태 확인", "실제 조치 또는 재작업 근거 제시"],
      },
    });

    const evaluated = await fixture.runtime.handleBridgeTaskResult({
      taskId: dispatch.bridgeTaskId,
      sourceChatId: 123,
      sourceMessageId: 456,
      status: "completed",
      result: "세션 기록 완료: 모니터링 cron 자동 점검 미등록 상태를 Brain에 기록함(rec_topic_misc_20260624_0004). 현재 상태 — 수동 점검 필요.",
      completedAt: "2026-06-24T00:00:00.000Z",
    });

    assert.equal(evaluated?.evaluation.decision, "REWORK");
    assert.equal(evaluated?.message, null);
    assert.equal(fixture.createdBridgeTasks.length, 2);
    assert.match(fixture.createdBridgeTasks[1].instruction, /non_actionable_worker_result/);
    assert.match(fixture.createdBridgeTasks[1].instruction, /실제 산출물, 검증 결과, 남은 이슈/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
test("OrchestratorBridgeRuntime leaves unrelated bridge results on legacy path", async () => {
  const fixture = createRuntimeFixture();
  try {
    const evaluated = await fixture.runtime.handleBridgeTaskResult({
      taskId: "task_untracked",
      sourceChatId: 123,
      sourceMessageId: 456,
      status: "completed",
      result: "legacy result",
      completedAt: "2026-06-12T00:00:00.000Z",
    });

    assert.equal(evaluated, null);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});




test("OrchestratorBridgeRuntime continues desktop remaining tasks without Telegram noise", async () => {
  const fixture = createRuntimeFixture();
  try {
    const handled = fixture.runtime.handleDesktopSessionEnd({
      sourceChatId: 64445716,
      projectPath: "C:/Projects/Gateway",
      projectName: "gateway",
      reason: "정상 종료 hook 이벤트",
      endedAt: "2026-06-23T12:00:00.000Z",
      summary: "API 라우팅 수정 중 세션이 종료됨",
      remainingTasks: ["라우팅 테스트 추가", "빌드 재확인"],
      recentFiles: ["C:/Projects/Gateway/src/router.ts"],
    });

    assert.equal(handled.action, "continued");
    assert.equal(handled.message, null);
    assert.equal(handled.bridgeTaskId, "task_1");
    assert.equal(fixture.createdBridgeTasks.length, 1);
    assert.match(fixture.createdBridgeTasks[0].instruction, /이전 PC 세션 종료 후 남은 작업을 계속 진행/);
    assert.match(fixture.createdBridgeTasks[0].instruction, /라우팅 테스트 추가/);

    const stored = fixture.runtime.store.get(handled.orchestratorTaskId);
    assert.equal(stored?.status, "dispatched");
    assert.deepEqual(stored?.evaluationPlan.lockedCriteria, ["라우팅 테스트 추가", "빌드 재확인"]);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("OrchestratorBridgeRuntime keeps desktop session summaries internal when no decision is needed", async () => {
  const fixture = createRuntimeFixture();
  try {
    const handled = fixture.runtime.handleDesktopSessionEnd({
      sourceChatId: 64445716,
      projectPath: "C:/Projects/Gateway",
      projectName: "gateway",
      reason: "정상 종료 hook 이벤트",
      endedAt: "2026-06-23T12:00:00.000Z",
      summary: "빌드와 핵심 테스트를 완료했습니다.",
      remainingTasks: [],
    });

    assert.equal(handled.action, "completed");
    assert.equal(handled.message, null);
    assert.equal(fixture.createdBridgeTasks.length, 0);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});




