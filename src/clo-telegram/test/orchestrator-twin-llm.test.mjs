import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { OrchestratorBridgeRuntime } from "../dist/orchestrator/bridge-runtime.js";
import { OrchestratorStore } from "../dist/orchestrator/store.js";
import { DecisionJournal } from "../dist/orchestrator/decision-journal.js";
import { TwinDecider } from "../dist/orchestrator/twin-decider.js";
import { parseOpinion } from "../dist/orchestrator/twin-llm.js";

const FIXTURE_PACK = [
  "# Global Decision Pattern (fixture)",
  "### [DP-002] 에러는 명시적으로 throw",
  "### [DP-004] 문서보다 동작 코드 우선",
  "### [DP-010] 안 되면 빠르게 폐기",
].join("\n");

function createFixture({ llmConsult } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-twin-llm-"));
  const packPath = path.join(dir, "decisions.md");
  writeFileSync(packPath, FIXTURE_PACK, "utf-8");
  const journalDir = path.join(dir, "decision-journal");
  const createdBridgeTasks = [];
  const runtime = new OrchestratorBridgeRuntime({
    store: new OrchestratorStore(path.join(dir, "orchestrator")),
    twinDecider: new TwinDecider({ knowledgePackPath: packPath, ...(llmConsult ? { llmConsult } : {}) }),
    decisionJournal: new DecisionJournal(journalDir),
    reversalsDir: path.join(dir, "reversals"),
    bridgeTaskCreator: {
      createTask: (params) => {
        const taskId = `task_${createdBridgeTasks.length + 1}`;
        createdBridgeTasks.push({ taskId, ...params });
        return taskId;
      },
    },
  });
  return { dir, journalDir, runtime, createdBridgeTasks };
}

/** light 프로필 + bookkeeping 결과 2회 → 두 번째는 R-RETRY-EXHAUSTED (LLM 문의 대상) */
async function driveToExhausted(fixture) {
  const dispatch = fixture.runtime.trackBridgeDispatch({
    sourceChatId: 1,
    sourceMessageId: 0,
    targetCwd: "C:/Projects/LlmCase",
    instruction: "로그 정리 작업",
    targetAgent: "desktop-clo",
    telecloDecision: {
      objective: "로그 정리",
      taskType: "code",
      riskLevel: "yellow",
      evaluationProfile: "light",
      claimLevel: "review_needed",
      successCriteria: ["정리 결과 보고"],
    },
  });
  const first = await fixture.runtime.handleBridgeTaskResult({
    taskId: dispatch.bridgeTaskId,
    sourceChatId: 1,
    sourceMessageId: 0,
    status: "completed",
    result: "세션 기록 완료: rec_topic_llm_1 저장",
    completedAt: new Date().toISOString(),
  });
  assert.equal(first.twinVerdict, "reject", "1차는 규칙 트윈 재작업이어야 함");
  const reworkTaskId = fixture.createdBridgeTasks.at(-1).taskId;
  const second = await fixture.runtime.handleBridgeTaskResult({
    taskId: reworkTaskId,
    sourceChatId: 1,
    sourceMessageId: 0,
    status: "completed",
    result: "세션 기록 완료: rec_topic_llm_2 저장",
    completedAt: new Date().toISOString(),
  });
  return { dispatch, second };
}

test("LLM 트윈: 반복 실패(EXHAUSTED) 케이스에서 reject 의견이 재작업으로 채택된다 (twin-v2-llm)", async () => {
  const consulted = [];
  const fixture = createFixture({
    llmConsult: {
      consult: async (llmCase) => {
        consulted.push(llmCase);
        return {
          verdict: "reject",
          rationale: "보고가 여전히 기록성뿐이다. 접근을 바꿔 한 번 더.",
          dpRefs: ["DP-010"],
          confidence: 0.85,
          reworkDemands: ["직전과 다른 접근으로 로그 정리를 수행하고 실행 로그를 첨부할 것"],
        };
      },
    },
  });
  const { second } = await driveToExhausted(fixture);

  assert.equal(consulted.length, 1, "LLM은 정확히 1회 문의되어야 함");
  assert.deepEqual(consulted[0].allowedVerdicts, ["reject", "escalate"], "EXHAUSTED는 approve 금지");
  assert.ok(consulted[0].packContent.includes("[DP-010]"), "지식팩 전문이 input에 포함되어야 함");
  assert.equal(second.message, null, "LLM이 결정했으므로 푸시 없음");
  assert.equal(second.twinVerdict, "reject");
  assert.equal(fixture.createdBridgeTasks.length, 3, "LLM 재작업이 발행되어야 함");
  assert.match(fixture.createdBridgeTasks.at(-1).instruction, /직전과 다른 접근/);
});

test("LLM 트윈: 저확신/허용외/DP미인용 의견은 채택하지 않고 에스컬레이션을 유지한다", async () => {
  const cases = [
    { verdict: "reject", rationale: "확신 없음", dpRefs: ["DP-010"], confidence: 0.5, reworkDemands: ["x"] },
    { verdict: "approve", rationale: "허용 외 판정", dpRefs: ["DP-010"], confidence: 0.9 },
    { verdict: "reject", rationale: "DP 미인용", dpRefs: [], confidence: 0.9, reworkDemands: ["x"] },
  ];
  for (const opinion of cases) {
    const fixture = createFixture({ llmConsult: { consult: async () => opinion } });
    const { second } = await driveToExhausted(fixture);
    assert.ok(second.message, `의견 ${JSON.stringify(opinion)}은 기각되고 푸시로 폴백해야 함`);
    assert.equal(second.twinVerdict, "escalate");
    assert.equal(fixture.createdBridgeTasks.length, 2, "추가 재작업이 없어야 함");
  }
});

test("LLM 트윈: consult 실패(null/예외)와 비가역 가드는 LLM과 무관하게 안전하다", async () => {
  // consult가 죽어도 에스컬레이션 유지
  const failing = createFixture({ llmConsult: { consult: async () => { throw new Error("llm down"); } } });
  const { second } = await driveToExhausted(failing);
  assert.ok(second.message, "consult 예외 시 결정 요청서 푸시로 폴백");

  // 비가역은 LLM에 문의 자체가 없어야 함
  const consulted = [];
  const guard = createFixture({
    llmConsult: { consult: async (llmCase) => { consulted.push(llmCase); return { verdict: "approve", rationale: "x", dpRefs: ["DP-010"], confidence: 0.99 }; } },
  });
  const dispatch = guard.runtime.trackBridgeDispatch({
    sourceChatId: 1,
    sourceMessageId: 0,
    targetCwd: "C:/Projects/LlmCase",
    instruction: "오래된 백업 파일 삭제 정리",
    targetAgent: "desktop-clo",
    telecloDecision: {
      objective: "백업 삭제",
      taskType: "code",
      riskLevel: "yellow",
      evaluationProfile: "standard",
      claimLevel: "review_needed",
      successCriteria: ["결과 보고"],
    },
  });
  const evaluated = await guard.runtime.handleBridgeTaskResult({
    taskId: dispatch.bridgeTaskId,
    sourceChatId: 1,
    sourceMessageId: 0,
    status: "completed",
    result: "삭제 완료. 로그 첨부.",
    completedAt: new Date().toISOString(),
  });
  assert.equal(consulted.length, 0, "비가역 가드는 LLM에 문의하지 않아야 함");
  assert.equal(evaluated.twinVerdict, "escalate");
  assert.ok(evaluated.message);
});

test("parseOpinion: 코드펜스 잡음 허용, 계약 위반은 null", () => {
  const llmCase = {
    allowedVerdicts: ["reject", "escalate"],
    packDpIds: ["DP-002", "DP-010"],
  };
  const ok = parseOpinion(
    '설명입니다.\n```json\n{"verdict":"reject","rationale":"근거","dpRefs":["DP-010","DP-999"],"confidence":0.8,"reworkDemands":["요구 1"]}\n```',
    llmCase,
  );
  assert.equal(ok.verdict, "reject");
  assert.deepEqual(ok.dpRefs, ["DP-010"], "지식팩 밖 DP는 걸러져야 함");
  assert.deepEqual(ok.reworkDemands, ["요구 1"]);

  assert.equal(parseOpinion("판정: 승인합니다", llmCase), null, "JSON 없음");
  assert.equal(parseOpinion('{"verdict":"approve","rationale":"x","confidence":0.9}', llmCase), null, "허용 외 판정");
  assert.equal(parseOpinion('{"verdict":"reject","rationale":"","confidence":0.9}', llmCase), null, "근거 없음");
  assert.equal(parseOpinion('{"verdict":"reject","rationale":"x","confidence":1.5}', llmCase), null, "확신도 범위 밖");
});
