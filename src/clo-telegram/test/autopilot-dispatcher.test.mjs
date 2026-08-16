import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DelegatedTaskStore } from "../dist/delegated-task-store.js";
import { ActionPolicy } from "../dist/autopilot/action-policy.js";
import { AutopilotStateStore } from "../dist/autopilot/autopilot-state-store.js";
import {
  InternalCommandDispatcher,
  buildAsyncResearchAutopilotPrompt,
  buildAsyncResearchWorkerSignal,
} from "../dist/autopilot/internal-command-dispatcher.js";
import { IntentRouter } from "../dist/autopilot/intent-router.js";

test("InternalCommandDispatcher returns task status without slash command", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-autopilot-dispatcher-"));
  try {
    const store = new DelegatedTaskStore(path.join(dir, "tasks.json"));
    store.create({
      taskId: "worker_1",
      chatId: 123,
      title: "Autopilot 설계 검토",
      why: "테스트",
      backend: "bandingai",
      startedAt: new Date(Date.now() - 90_000).toISOString(),
    });
    store.appendProgress("worker_1", { kind: "step", message: "자료 확인" });

    const router = new IntentRouter();
    const policy = new ActionPolicy();
    const intent = router.classify("그 작업 어떻게 됐어?");
    const action = policy.decide(intent);
    const dispatcher = new InternalCommandDispatcher({ delegatedTaskStore: store });
    const result = await dispatcher.execute({
      text: "그 작업 어떻게 됐어?",
      intent,
      action,
      context: { chatId: 123, userId: 456, isGroup: false, isMentioned: true },
    });

    assert.equal(result.handled, true);
    assert.match(result.response ?? "", /최근 위임 작업/);
    assert.match(result.response ?? "", /Autopilot 설계 검토/);
    assert.match(result.response ?? "", /자료 확인/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("InternalCommandDispatcher reports no delegated tasks", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-autopilot-dispatcher-"));
  try {
    const store = new DelegatedTaskStore(path.join(dir, "tasks.json"));
    const router = new IntentRouter();
    const policy = new ActionPolicy();
    const intent = router.classify("워커 돌고 있는 거 있어?");
    const dispatcher = new InternalCommandDispatcher({ delegatedTaskStore: store });
    const result = await dispatcher.execute({
      text: "워커 돌고 있는 거 있어?",
      intent,
      action: policy.decide(intent),
      context: { chatId: 123, isGroup: false, isMentioned: true },
    });

    assert.equal(result.handled, true);
    assert.equal(result.response, "현재 기록된 위임 작업이 없어요.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("InternalCommandDispatcher refuses task status when text is orchestration planning", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-autopilot-dispatcher-"));
  try {
    const store = new DelegatedTaskStore(path.join(dir, "tasks.json"));
    store.create({
      taskId: "worker_1",
      chatId: 123,
      title: "기존 위임 작업",
      why: "테스트",
      backend: "bandingai",
      startedAt: new Date(Date.now() - 90_000).toISOString(),
    });

    const dispatcher = new InternalCommandDispatcher({ delegatedTaskStore: store });
    const result = await dispatcher.execute({
      text: "각 작업의 완료 기준을 파악하고 작업이 완료되면 신호를 받아야 함",
      intent: {
        intent: "task_status",
        confidence: 0.95,
        safety: "safe_read",
        reason: "AI 라우터 오분류",
        entities: {},
      },
      action: {
        mode: "AUTO",
        intent: "task_status",
        reason: "AI 라우터 오분류",
        requiresConfirmation: false,
      },
      context: { chatId: 123, isGroup: false, isMentioned: true },
    });

    assert.equal(result.handled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("InternalCommandDispatcher refuses dev handoff when text only mentions Codex", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-autopilot-dispatcher-"));
  try {
    const store = new DelegatedTaskStore(path.join(dir, "tasks.json"));
    const stateStore = new AutopilotStateStore(path.join(dir, "state.json"));
    const dispatcher = new InternalCommandDispatcher({ delegatedTaskStore: store, stateStore });
    const result = await dispatcher.execute({
      text: "현재 내 PC의 활성 세션(데탑클로, 코덱스)에서 수행하고 있는 작업을 알고 있어야 함",
      intent: {
        intent: "dev_handoff",
        confidence: 0.95,
        safety: "needs_confirmation",
        reason: "AI 라우터 오분류",
        entities: {},
      },
      action: {
        mode: "ASK",
        intent: "dev_handoff",
        reason: "AI 라우터 오분류",
        requiresConfirmation: true,
      },
      context: { chatId: 123, isGroup: false, isMentioned: true },
    });

    assert.equal(result.handled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("InternalCommandDispatcher handles meeting start and end callbacks", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-autopilot-dispatcher-"));
  try {
    const store = new DelegatedTaskStore(path.join(dir, "tasks.json"));
    const router = new IntentRouter();
    const policy = new ActionPolicy();
    const calls = [];
    const dispatcher = new InternalCommandDispatcher({
      delegatedTaskStore: store,
      startMeeting: async (chatId, argsText) => {
        calls.push(["start", chatId, argsText]);
        return "회의 시작됨";
      },
      endMeeting: async (chatId, summaryMode) => {
        calls.push(["end", chatId, summaryMode]);
        return "회의 종료됨";
      },
    });

    for (const text of ["회의 시작하자", "회의 마무리하고 저장해"]) {
      const intent = router.classify(text);
      const result = await dispatcher.execute({
        text,
        intent,
        action: policy.decide(intent),
        context: { chatId: 123, isGroup: false, isMentioned: true },
      });
      assert.equal(result.handled, true);
    }

    assert.deepEqual(calls, [["start", 123, ""], ["end", 123, "fast"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("InternalCommandDispatcher handles Brain recall backed intents", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-autopilot-dispatcher-"));
  try {
    const store = new DelegatedTaskStore(path.join(dir, "tasks.json"));
    const router = new IntentRouter();
    const policy = new ActionPolicy();
    const dispatcher = new InternalCommandDispatcher({
      delegatedTaskStore: store,
      recall: (goal, topK) => `[9.1] [rec_test] ${goal} — topK=${topK}`,
    });

    const intent = router.classify("전에 HTML 산출물 가능하다고 했던 거 기억나?");
    const result = await dispatcher.execute({
      text: "전에 HTML 산출물 가능하다고 했던 거 기억나?",
      intent,
      action: policy.decide(intent),
      context: { chatId: 123, isGroup: false, isMentioned: true },
    });

    assert.equal(result.handled, true);
    assert.match(result.response ?? "", /Brain에서 확인한 기억/);
    assert.match(result.response ?? "", /rec_test/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("InternalCommandDispatcher stores ASK actions for privacy policy changes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-autopilot-dispatcher-"));
  try {
    const store = new DelegatedTaskStore(path.join(dir, "tasks.json"));
    const stateStore = new AutopilotStateStore(path.join(dir, "state.json"));
    const router = new IntentRouter();
    const policy = new ActionPolicy();
    const dispatcher = new InternalCommandDispatcher({ delegatedTaskStore: store, stateStore });

    const text = "이 방에서는 내 개인 기억 써도 돼";
    const intent = router.classify(text);
    const result = await dispatcher.execute({
      text,
      intent,
      action: policy.decide(intent),
      context: { chatId: 123, userId: 456, isGroup: true, isMentioned: true },
    });

    assert.equal(result.handled, true);
    assert.match(result.response ?? "", /확인/);
    assert.match(result.response ?? "", /개인 기억/);
    assert.equal(result.replyMarkup?.inline_keyboard[0].length, 2);
    assert.equal(stateStore.listPending(123).length, 1);
    assert.equal(stateStore.listPending(123)[0].intent, "privacy_policy_change");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("InternalCommandDispatcher resolves privacy policy approval", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-autopilot-dispatcher-"));
  try {
    const store = new DelegatedTaskStore(path.join(dir, "tasks.json"));
    const stateStore = new AutopilotStateStore(path.join(dir, "state.json"));
    const router = new IntentRouter();
    const policy = new ActionPolicy();
    const dispatcher = new InternalCommandDispatcher({ delegatedTaskStore: store, stateStore });

    const text = "이 방에서는 내 개인 기억 써도 돼";
    const intent = router.classify(text);
    await dispatcher.execute({
      text,
      intent,
      action: policy.decide(intent),
      context: { chatId: 123, userId: 456, isGroup: true, isMentioned: true },
    });
    const pendingActionId = stateStore.listPending(123)[0].pendingActionId;

    const response = await dispatcher.resolvePendingAction(pendingActionId, true, 456);

    assert.match(response, /허용/);
    assert.equal(stateStore.getPendingAction(pendingActionId)?.status, "applied");
    assert.equal(stateStore.getChatMemoryPolicy(123)?.allowPersonalMemory, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("InternalCommandDispatcher executes approved task cancellation", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-autopilot-dispatcher-"));
  try {
    const store = new DelegatedTaskStore(path.join(dir, "tasks.json"));
    const stateStore = new AutopilotStateStore(path.join(dir, "state.json"));
    const router = new IntentRouter();
    const policy = new ActionPolicy();
    let cancelledChatId = 0;
    const dispatcher = new InternalCommandDispatcher({
      delegatedTaskStore: store,
      stateStore,
      cancelTasks: (chatId) => {
        cancelledChatId = chatId;
        return "작업을 취소했어요.";
      },
    });

    const text = "작업 취소해";
    const intent = router.classify(text);
    await dispatcher.execute({
      text,
      intent,
      action: policy.decide(intent),
      context: { chatId: 123, messageId: 9, userId: 456, isGroup: false, isMentioned: true },
    });
    const pendingActionId = stateStore.listPending(123)[0].pendingActionId;

    const response = await dispatcher.resolvePendingAction(pendingActionId, true, 456);

    assert.equal(cancelledChatId, 123);
    assert.match(response, /취소/);
    assert.equal(stateStore.getPendingAction(pendingActionId)?.status, "applied");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("InternalCommandDispatcher executes explicit memory write silently", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-autopilot-dispatcher-"));
  try {
    const store = new DelegatedTaskStore(path.join(dir, "tasks.json"));
    const stateStore = new AutopilotStateStore(path.join(dir, "state.json"));
    const router = new IntentRouter();
    const policy = new ActionPolicy();
    let capturedText = "";
    const dispatcher = new InternalCommandDispatcher({
      delegatedTaskStore: store,
      stateStore,
      writeMemoryCandidate: (pendingAction) => {
        capturedText = pendingAction.text;
        return "[SKIP]";
      },
    });

    const text = "이거 기억해둬";
    const intent = router.classify(text);
    const result = await dispatcher.execute({
      text,
      intent,
      action: policy.decide(intent),
      context: { chatId: 123, messageId: 9, userId: 456, isGroup: false, isMentioned: true },
    });

    assert.equal(capturedText, text);
    assert.equal(result.handled, true);
    assert.equal(result.response, "[SKIP]");
    assert.equal(stateStore.listPending(123).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("InternalCommandDispatcher refuses AI memory write classification for file save requests", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-autopilot-dispatcher-"));
  try {
    const store = new DelegatedTaskStore(path.join(dir, "tasks.json"));
    const dispatcher = new InternalCommandDispatcher({
      delegatedTaskStore: store,
      writeMemoryCandidate: () => {
        throw new Error("memory write must not run for file save requests");
      },
    });

    const result = await dispatcher.execute({
      text: "다음 폴더내 설계서 저장 D:\\Projects\\Sentinel",
      intent: {
        intent: "memory_write_candidate",
        confidence: 0.95,
        safety: "safe_write",
        reason: "AI 라우터 오분류",
        entities: {},
      },
      action: {
        mode: "AUTO",
        intent: "memory_write_candidate",
        reason: "AI 라우터 오분류",
        requiresConfirmation: false,
      },
      context: { chatId: 123, messageId: 9, userId: 456, isGroup: false, isMentioned: true },
    });

    assert.equal(result.handled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("InternalCommandDispatcher refuses AI dev handoff classification for local path work", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-autopilot-dispatcher-"));
  try {
    const store = new DelegatedTaskStore(path.join(dir, "tasks.json"));
    const stateStore = new AutopilotStateStore(path.join(dir, "state.json"));
    const dispatcher = new InternalCommandDispatcher({
      delegatedTaskStore: store,
      stateStore,
      devHandoff: () => {
        throw new Error("local path work must not be dispatched as dev handoff");
      },
    });

    const text = "D:\\Projects\\harnessOpt 여기다가도 좀 하고";
    const result = await dispatcher.execute({
      text,
      intent: {
        intent: "dev_handoff",
        confidence: 0.95,
        safety: "needs_confirmation",
        reason: "AI 라우터 판정",
        entities: {},
      },
      action: {
        mode: "ASK",
        intent: "dev_handoff",
        reason: "AI 라우터 판정",
        requiresConfirmation: true,
      },
      context: { chatId: 123, messageId: 9, userId: 456, isGroup: false, isMentioned: true },
    });

    assert.equal(result.handled, false);
    assert.equal(stateStore.listPending(123).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("InternalCommandDispatcher executes approved dev handoff", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-autopilot-dispatcher-"));
  try {
    const store = new DelegatedTaskStore(path.join(dir, "tasks.json"));
    const stateStore = new AutopilotStateStore(path.join(dir, "state.json"));
    const router = new IntentRouter();
    const policy = new ActionPolicy();
    let sourceMessageId = 0;
    const dispatcher = new InternalCommandDispatcher({
      delegatedTaskStore: store,
      stateStore,
      devHandoff: (pendingAction) => {
        sourceMessageId = pendingAction.sourceMessageId ?? 0;
        return "전달 완료";
      },
    });

    const text = "VS Code에서 처리해줘";
    const intent = router.classify(text);
    await dispatcher.execute({
      text,
      intent,
      action: policy.decide(intent),
      context: { chatId: 123, messageId: 987, userId: 456, isGroup: false, isMentioned: true },
    });
    const pendingActionId = stateStore.listPending(123)[0].pendingActionId;

    const response = await dispatcher.resolvePendingAction(pendingActionId, true, 456);

    assert.equal(sourceMessageId, 987);
    assert.equal(response, "전달 완료");
    assert.equal(stateStore.getPendingAction(pendingActionId)?.status, "applied");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildAsyncResearchAutopilotPrompt instructs worker creation", () => {
  const prompt = buildAsyncResearchAutopilotPrompt("이건 길게 조사해줘");
  assert.match(prompt, /\[SPAWN_WORKER\]/);
  assert.match(prompt, /why:/);
  assert.match(prompt, /what:/);
  assert.match(prompt, /task:/);
  assert.match(prompt, /context:/);
});

test("buildAsyncResearchWorkerSignal includes user-facing handoff and worker block", () => {
  const signal = buildAsyncResearchWorkerSignal("오케스트레이터 구조를 길게 조사해줘");
  assert.match(signal, /백그라운드 워커로 분리/);
  assert.match(signal, /\[SPAWN_WORKER\]/);
  assert.match(signal, /what: 오케스트레이터 구조를 길게 조사해줘/);
  assert.match(signal, /context: 원문 요청: 오케스트레이터 구조를 길게 조사해줘/);
});



