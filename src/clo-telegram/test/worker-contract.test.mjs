import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearPersistedWorkerStatuses,
  evaluateWorkerCompletion,
  extractRequiredArtifactPaths,
  parseWorkerSignal,
  stripWorkerControlBlocks,
} from "../dist/worker-contract.js";

test("parseWorkerSignal preserves bracketed multiline task sections", () => {
  const response = [
    "백그라운드에서 진행하겠습니다.",
    "[SPAWN_WORKER]",
    "why: 대화를 막지 않기 위해 별도 실행",
    "what: A/B 본실험",
    "task:",
    "[최우선 지시] C:/tmp/worker-contract/status.md를 반드시 저장하라.",
    "",
    "[배경] 파일럿의 편향을 제거한다.",
    "",
    "[실험 매트릭스] 작업 3종 x 6회",
    "context: 직전 파일럿 결과를 참고한다.",
    "[/SPAWN_WORKER]",
  ].join("\n");

  const parsed = parseWorkerSignal(response);

  assert.ok(parsed);
  assert.match(parsed.taskInstr, /\[최우선 지시\]/);
  assert.match(parsed.taskInstr, /\[배경\]/);
  assert.match(parsed.taskInstr, /\[실험 매트릭스\]/);
  assert.equal(parsed.context, "직전 파일럿 결과를 참고한다.");
  assert.equal(parsed.userFacingText, "백그라운드에서 진행하겠습니다.");
});

test("stripWorkerControlBlocks removes SPAWN_WORKER payload from recent history", () => {
  const text = "착수합니다.\n[SPAWN_WORKER]\nwhy: x\nwhat: y\ntask: z\n[/SPAWN_WORKER]";
  assert.equal(stripWorkerControlBlocks(text), "착수합니다.");
});

test("extractRequiredArtifactPaths only captures output paths from completion lines", () => {
  const task = [
    "C:/tmp/worker-contract/status.md에 STARTED를 쓰고 반드시 저장하라.",
    "최종 결과는 'C:/tmp/worker-contract/result.md'에 작성한다.",
    "참고 bin: C:/Users/ernham/AppData/Roaming/npm/codex.cmd",
    "참고 cwd: C:/Users/ernham/.codex",
  ].join("\n");

  assert.deepEqual(extractRequiredArtifactPaths(task), [
    path.normalize("C:/tmp/worker-contract/status.md"),
    path.normalize("C:/tmp/worker-contract/result.md"),
  ]);
});

test("evaluateWorkerCompletion rejects missing contract and explicit incomplete results", () => {
  const task = "분석 결과를 작성하라.";
  const missingContract = evaluateWorkerCompletion(task, "분석을 완료했습니다.");
  assert.equal(missingContract.accepted, false);
  assert.match(missingContract.reason, /완료 계약/);

  const contradictory = evaluateWorkerCompletion(task, [
    "본실험 상태 - 산출물 0개, 미완료",
    "[WORKER_RESULT]",
    "status: completed",
    "summary: 완료",
    "evidence:",
    "- 폴더 확인",
    "[/WORKER_RESULT]",
  ].join("\n"));
  assert.equal(contradictory.accepted, false);
  assert.match(contradictory.reason, /미완료/);
});

test("evaluateWorkerCompletion requires non-empty declared artifacts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-worker-contract-"));
  try {
    const resultPath = path.join(dir, "result.md");
    const task = "최종 결과를 '" + resultPath + "'에 반드시 저장하라.";
    const result = [
      "작업 완료",
      "[WORKER_RESULT]",
      "status: completed",
      "summary: 결과 작성 완료",
      "evidence:",
      "- " + resultPath,
      "[/WORKER_RESULT]",
    ].join("\n");

    const missing = evaluateWorkerCompletion(task, result);
    assert.equal(missing.accepted, false);
    assert.deepEqual(missing.missingArtifactPaths, [path.normalize(resultPath)]);

    writeFileSync(resultPath, "verified output", "utf-8");
    const complete = evaluateWorkerCompletion(task, result);
    assert.equal(complete.accepted, true);
    assert.equal(complete.cleanResult, "작업 완료");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearPersistedWorkerStatuses removes restart leftovers", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-worker-status-"));
  try {
    const filePath = path.join(dir, "worker-status.json");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ "123": { worker_old: { what: "old" } } }), "utf-8");

    assert.equal(clearPersistedWorkerStatuses(filePath), 1);
    assert.deepEqual(JSON.parse(readFileSync(filePath, "utf-8")), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

