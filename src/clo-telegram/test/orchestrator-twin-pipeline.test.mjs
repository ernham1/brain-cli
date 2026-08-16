import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { OrchestratorBridgeRuntime } from "../dist/orchestrator/bridge-runtime.js";
import { OrchestratorStore } from "../dist/orchestrator/store.js";
import { DecisionJournal } from "../dist/orchestrator/decision-journal.js";
import { TwinDecider, scanIrreversible, TWIN_VERSION } from "../dist/orchestrator/twin-decider.js";

const FIXTURE_PACK = [
  "# Global Decision Pattern (fixture)",
  "### [DP-002] 에러는 명시적으로 throw",
  "### [DP-003] 사용자 체감 먼저",
  "### [DP-004] 문서보다 동작 코드 우선",
  "### [DP-008] 되묻기보다 실행",
  "### [DP-009] 검증은 전수",
  "### [DP-010] 안 되면 빠르게 폐기",
  "### [DP-013] 삭제는 보수적으로",
  "### [DP-018] 수정 후 풀 재실행",
  "### [DP-020] 파일 이동/삭제 전 확인",
].join("\n");

function createFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-twin-pipeline-"));
  const packPath = path.join(dir, "decisions.md");
  writeFileSync(packPath, FIXTURE_PACK, "utf-8");
  const journalDir = path.join(dir, "decision-journal");
  const reversalsDir = path.join(dir, "reversals");
  const createdBridgeTasks = [];
  const runtime = new OrchestratorBridgeRuntime({
    store: new OrchestratorStore(path.join(dir, "orchestrator")),
    twinDecider: new TwinDecider({ knowledgePackPath: packPath }),
    decisionJournal: new DecisionJournal(journalDir),
    reversalsDir,
    bridgeTaskCreator: {
      createTask: (params) => {
        const taskId = `task_${createdBridgeTasks.length + 1}`;
        createdBridgeTasks.push({ taskId, ...params });
        return taskId;
      },
    },
  });
  return { dir, packPath, journalDir, reversalsDir, runtime, createdBridgeTasks };
}

function readJournalRows(journalDir) {
  try {
    return readdirSync(journalDir)
      .filter((file) => file.endsWith(".jsonl"))
      .flatMap((file) => readFileSync(path.join(journalDir, file), "utf-8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line)));
  } catch {
    return [];
  }
}

function dispatchTask(fixture, { instruction, objective, profile = "standard", claimLevel = "review_needed", criteria = ["결과 보고 포함"] } = {}) {
  return fixture.runtime.trackBridgeDispatch({
    sourceChatId: 100,
    sourceMessageId: 200,
    targetCwd: "C:/Projects/SampleProject",
    instruction,
    targetAgent: "desktop-clo",
    telecloDecision: {
      objective,
      taskType: "code",
      riskLevel: "yellow",
      evaluationProfile: profile,
      claimLevel,
      successCriteria: criteria,
    },
  });
}

async function completeTask(fixture, bridgeTaskId, resultText) {
  return await fixture.runtime.handleBridgeTaskResult({
    taskId: bridgeTaskId,
    sourceChatId: 100,
    sourceMessageId: 200,
    status: "completed",
    result: resultText,
    completedAt: new Date().toISOString(),
  });
}

// --- 검증 경로 1: PASS 자율 승인 → 히스토리 기록 + 텔레그램 조용 ---

test("PASS 경로: 자율 승인은 조용히 진행되고 결정 저널에 기록된다", async () => {
  const fixture = createFixture();
  const dispatch = dispatchTask(fixture, {
    instruction: "README 오탈자를 정리해줘",
    objective: "README 오탈자 정리",
  });

  const evaluated = await completeTask(
    fixture,
    dispatch.bridgeTaskId,
    "README.md 오탈자 3건 수정 완료. 변경 파일: README.md. 검증: markdownlint 통과 출력 첨부.",
  );

  assert.equal(evaluated.evaluation.decision, "PASS");
  assert.equal(evaluated.message, null, "PASS는 텔레그램 메시지가 없어야 함");
  assert.ok(evaluated.journalId?.startsWith("dj-"), "저널 ID가 반환되어야 함");
  assert.match(evaluated.autoApprovalLog ?? "", /자율 승인/);

  const rows = readJournalRows(fixture.journalDir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].twin.verdict, "approve");
  assert.equal(rows[0].twin.twinVersion, "gate-auto");
  assert.equal(rows[0].human, null);
  assert.equal(rows[0].project, "SampleProject");

  const stored = fixture.runtime.store.get(dispatch.orchestratorTaskId);
  assert.equal(stored.status, "reported");
});

// --- 검증 경로 2: 트윈 결정 (근거 부족 완료 보고 → 트윈 재작업, 푸시 없음) ---

test("트윈 결정 경로: 근거 부족 보고는 트윈이 재작업을 발행하고 텔레그램에 아무것도 보내지 않는다", async () => {
  const fixture = createFixture();
  // light 프로필: maxAttempts=0 → 첫 실패에서 바로 ASK → 트윈 개입
  const dispatch = dispatchTask(fixture, {
    instruction: "설정 파일 정리 작업을 진행해줘",
    objective: "설정 파일 정리",
    profile: "light",
    claimLevel: "review_needed",
  });

  // 근거 부족한 완료 보고 (Brain 기록만 있는 bookkeeping-only 결과)
  const evaluated = await completeTask(
    fixture,
    dispatch.bridgeTaskId,
    "세션 기록 완료: rec_topic_sample_20260703_0001 저장",
  );

  assert.equal(evaluated.evaluation.decision, "ASK", "light+evidence 실패는 ASK");
  assert.equal(evaluated.message, null, "트윈이 결정했으므로 텔레그램 푸시가 없어야 함");
  assert.equal(evaluated.twinVerdict, "reject");
  assert.ok(evaluated.journalId?.startsWith("dj-"));

  // 재작업이 실제로 발행됨 (원 task 1건 + 트윈 재작업 1건)
  assert.equal(fixture.createdBridgeTasks.length, 2);
  assert.match(fixture.createdBridgeTasks[1].instruction, /ORCHESTRATOR_REWORK/);
  assert.match(fixture.createdBridgeTasks[1].instruction, /트윈 요구사항/);

  // 저널에 근거(DP 인용 + 확신도)가 남는다
  const rows = readJournalRows(fixture.journalDir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].twin.verdict, "reject");
  assert.equal(rows[0].twin.twinVersion, TWIN_VERSION);
  assert.ok(rows[0].twin.dpRefs.length > 0, "DP 인용이 있어야 함");
  assert.ok(rows[0].twin.confidence >= 0.6);
  assert.ok(rows[0].twin.knowledgePackHash.length === 64, "지식팩 해시(sha256) 필수");

  const stored = fixture.runtime.store.get(dispatch.orchestratorTaskId);
  assert.equal(stored.status, "dispatched", "재작업 디스패치 상태여야 함");
});

// --- 검증 경로 3: 에스컬레이션 (비가역 작업 → 텔레그램 푸시) ---

test("에스컬레이션 경로: 파일 삭제 포함 지시는 트윈이 결정하지 않고 결정 요청서를 푸시한다", async () => {
  const fixture = createFixture();
  const dispatch = dispatchTask(fixture, {
    instruction: "임시 캐시 디렉토리를 통째로 삭제하고 정리해줘",
    objective: "캐시 디렉토리 삭제 정리",
  });

  const evaluated = await completeTask(
    fixture,
    dispatch.bridgeTaskId,
    "캐시 디렉토리 삭제 완료. 변경: cache/ 제거. 검증: ls 출력 첨부.",
  );

  assert.ok(evaluated.message, "비가역 작업은 텔레그램 결정 요청서가 있어야 함");
  assert.match(evaluated.message, /이사님 결정 필요|비가역/);
  assert.equal(evaluated.twinVerdict, "escalate");

  const rows = readJournalRows(fixture.journalDir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].twin.verdict, "escalate");
  assert.equal(rows[0].irreversible, true);
  assert.equal(rows[0].irreversibleClass, "delete");

  // 자율 확정 금지: passed가 아니라 ask → reported
  const stored = fixture.runtime.store.get(dispatch.orchestratorTaskId);
  assert.equal(stored.status, "reported");
  const events = fixture.runtime.store.listEvents(dispatch.orchestratorTaskId);
  assert.ok(events.some((e) => e.type === "status_changed" && e.status === "ask"), "ask 상태를 거쳐야 함");
  assert.ok(!events.some((e) => e.type === "status_changed" && e.status === "passed"), "passed로 자율 확정하면 안 됨");
});

// --- 검증 경로 4: 뒤집기 → 재작업 재발행 ---

test("뒤집기 경로: reversals 큐의 요청이 재작업으로 재발행된다", async () => {
  const fixture = createFixture();
  const dispatch = dispatchTask(fixture, {
    instruction: "로그 포맷을 개선해줘",
    objective: "로그 포맷 개선",
    profile: "light",
  });
  const evaluated = await completeTask(fixture, dispatch.bridgeTaskId, "세션 기록 완료: rec_topic_x_1 저장");
  assert.equal(evaluated.twinVerdict, "reject");
  const journalId = evaluated.journalId;
  const tasksBefore = fixture.createdBridgeTasks.length;

  mkdirSync(fixture.reversalsDir, { recursive: true });
  writeFileSync(
    path.join(fixture.reversalsDir, `${journalId}.json`),
    JSON.stringify({ journalId, note: "재작업 지시가 과했음. 원 보고로 충분." }),
    "utf-8",
  );

  const outcomes = fixture.runtime.processReversalRequests();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, "reissued");
  assert.equal(outcomes[0].journalId, journalId);
  assert.ok(outcomes[0].bridgeTaskId, "재작업 브릿지 task가 발행되어야 함");
  assert.equal(fixture.createdBridgeTasks.length, tasksBefore + 1);
  assert.match(fixture.createdBridgeTasks.at(-1).instruction, /결정 뒤집기/);

  // 처리된 요청은 done/으로 이동 (재처리 방지)
  const remaining = readdirSync(fixture.reversalsDir).filter((f) => f.endsWith(".json"));
  assert.equal(remaining.length, 0);
  const done = readdirSync(path.join(fixture.reversalsDir, "done"));
  assert.equal(done.length, 1);

  // 두 번째 폴링은 아무것도 처리하지 않음
  assert.equal(fixture.runtime.processReversalRequests().length, 0);
});

// --- 트윈 단위 판정 ---

test("트윈 단위: 지식팩 부재 시 null 반환(에스컬레이션 폴백), 저널에는 twin:null 기록", async () => {
  const fixture = createFixture();
  const decider = new TwinDecider({ knowledgePackPath: path.join(fixture.dir, "missing.md") });
  const runtime = new OrchestratorBridgeRuntime({
    store: new OrchestratorStore(path.join(fixture.dir, "orchestrator2")),
    twinDecider: decider,
    decisionJournal: new DecisionJournal(path.join(fixture.dir, "journal2")),
    bridgeTaskCreator: { createTask: () => "task_x" },
  });
  const dispatch = runtime.trackBridgeDispatch({
    sourceChatId: 1,
    sourceMessageId: 2,
    targetCwd: "C:/Projects/SampleProject",
    instruction: "간단 정리 작업",
    telecloDecision: { evaluationProfile: "light", claimLevel: "review_needed", successCriteria: ["정리"] },
  });
  const evaluated = await runtime.handleBridgeTaskResult({
    taskId: dispatch.bridgeTaskId,
    sourceChatId: 1,
    sourceMessageId: 2,
    status: "completed",
    result: "세션 기록 완료: rec_topic_y_1 저장",
    completedAt: new Date().toISOString(),
  });
  assert.ok(evaluated.message, "트윈 실행 불가면 결정 요청서 푸시로 폴백해야 함");
  const rows = readJournalRows(path.join(fixture.dir, "journal2"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].twin, null, "트윈 미실행은 명시적 null (DP-012)");
});

test("트윈 단위: 이사님 확인이 명시된 기준은 에스컬레이션한다", async () => {
  const fixture = createFixture();
  const dispatch = dispatchTask(fixture, {
    instruction: "배너 문구 시안을 정리해줘",
    objective: "배너 문구 시안",
    profile: "light",
    criteria: ["시안 3종 작성", "이사님 확인 후 확정"],
  });
  const evaluated = await completeTask(fixture, dispatch.bridgeTaskId, "시안 3종 작성 완료. 파일: banner-drafts.md");
  assert.ok(evaluated.message, "이사님 확인 명시 시 푸시되어야 함");
  assert.equal(evaluated.twinVerdict, "escalate");
});

test("scanIrreversible: 배포/삭제 신호를 분류하고 일반 지시는 통과시킨다", async () => {
  const base = {
    instruction: "",
    objective: "",
    ownerDirectives: { rawInstruction: "" },
  };
  assert.equal(
    scanIrreversible({ ...base, instruction: "스테이징에 배포해줘" }).irreversibleClass,
    "deploy",
  );
  assert.equal(
    scanIrreversible({ ...base, instruction: "오래된 백업 파일을 삭제해줘" }).irreversibleClass,
    "delete",
  );
  assert.equal(scanIrreversible({ ...base, instruction: "리드미 오탈자 수정" }), null);
});

// --- 멱등 가드: 재시작 후 stale 결과 재처리 방지 ---

test("중복 결과 가드: 이미 종결된 attempt의 결과는 무시된다 (저널/전이/푸시 반복 금지)", async () => {
  const fixture = createFixture();
  const dispatch = dispatchTask(fixture, {
    instruction: "리드미 오탈자 수정",
    objective: "리드미 오탈자 수정",
  });
  const first = await completeTask(
    fixture,
    dispatch.bridgeTaskId,
    "오탈자 수정 완료. 변경 파일: README.md. 검증: lint 통과 로그 첨부.",
  );
  assert.equal(first.evaluation.decision, "PASS");
  assert.equal(readJournalRows(fixture.journalDir).length, 1);

  // 동일 결과 재주입 (봇 재시작 후 stale 파일 재처리 상황)
  const duplicate = await completeTask(
    fixture,
    dispatch.bridgeTaskId,
    "오탈자 수정 완료. 변경 파일: README.md. 검증: lint 통과 로그 첨부.",
  );
  assert.equal(duplicate, null, "중복 결과는 null로 무시되어야 함");
  assert.equal(readJournalRows(fixture.journalDir).length, 1, "저널 행이 늘어나면 안 됨");
  assert.equal(fixture.runtime.store.get(dispatch.orchestratorTaskId).status, "reported");
});
