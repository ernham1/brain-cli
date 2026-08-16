import assert from "node:assert/strict";
import test from "node:test";

import {
  detectPersistenceTargets,
  evaluatePersistenceEvidence,
  formatPersistenceCompletion,
  resolveGroupToolPolicy,
} from "../dist/persistence-contract.js";

test("group persistence request detects both Brain and Obsidian targets", () => {
  assert.deepEqual(
    detectPersistenceTargets("이 내용 브레인이나 옵시디언에 기억해줄 수 있겠니?"),
    ["brain", "obsidian"],
  );
  assert.deepEqual(detectPersistenceTargets("브레인과 옵시디언에 저장해줘"), ["brain", "obsidian"]);
  assert.deepEqual(detectPersistenceTargets("이거 기억해둬"), ["brain"]);
  assert.deepEqual(detectPersistenceTargets("옵시디언 저장이 안 되는 것 같은데 확인해줘"), []);
});

test("passive group persistence request receives full write tools", () => {
  const persistence = resolveGroupToolPolicy(
    "이 내용 브레인과 옵시디언에 저장해줘",
    { isGroup: true, isProjectRoom: false, isMentioned: false },
  );
  assert.deepEqual(persistence.persistenceTargets, ["brain", "obsidian"]);
  assert.equal(persistence.disableTools, false);
  assert.equal(persistence.readOnlyTools, false);
  assert.equal(persistence.maxTurns, 20);

  const lookup = resolveGroupToolPolicy(
    "LS ELECTRIC 주가 전망 확인해줘",
    { isGroup: true, isProjectRoom: false, isMentioned: false },
  );
  assert.equal(lookup.disableTools, false);
  assert.equal(lookup.readOnlyTools, true);

  const passive = resolveGroupToolPolicy(
    "오늘 저녁 뭐 먹을까",
    { isGroup: true, isProjectRoom: false, isMentioned: false },
  );
  assert.equal(passive.disableTools, true);
  assert.equal(passive.maxTurns, 3);
});

test("persistence evidence requires successful Brain and Obsidian tool results", () => {
  const evidence = evaluatePersistenceEvidence(
    ["brain", "obsidian"],
    [
      {
        toolName: "mcp__brain-tools__brain_write",
        input: {},
        result: "저장 완료: rec_proj_pillow_20260711_0001",
        isError: false,
      },
      {
        toolName: "Write",
        input: { file_path: "G:/내 드라이브/메모/OBSIDIAN_Memo/AI학습/꿀잠베개.md" },
        result: "File created successfully",
        isError: false,
      },
    ],
    "G:/내 드라이브/메모/OBSIDIAN_Memo",
  );

  assert.equal(evidence.completed, true);
  assert.deepEqual(evidence.missingTargets, []);
  assert.deepEqual(evidence.brainRecordIds, ["rec_proj_pillow_20260711_0001"]);
  assert.deepEqual(evidence.obsidianPaths, ["G:/내 드라이브/메모/OBSIDIAN_Memo/AI학습/꿀잠베개.md"]);
  assert.match(formatPersistenceCompletion("저장했어요.", evidence), /저장 확인:/);
  assert.match(formatPersistenceCompletion("저장했어요.", evidence), /rec_proj_pillow_20260711_0001/);
  assert.match(formatPersistenceCompletion("저장했어요.", evidence), /꿀잠베개\.md/);
});

test("persistence completion replaces unsupported success claims", () => {
  const evidence = evaluatePersistenceEvidence(
    ["brain", "obsidian"],
    [{
      toolName: "mcp__brain-tools__brain_write",
      input: {},
      result: "저장 완료: rec_proj_pillow_20260711_0001",
      isError: false,
    }],
    "G:/내 드라이브/메모/OBSIDIAN_Memo",
  );

  const guarded = formatPersistenceCompletion("Brain과 Obsidian에 저장 완료했어요.", evidence);
  assert.doesNotMatch(guarded, /Brain과 Obsidian에 저장 완료/);
  assert.match(guarded, /일부만 저장됐습니다/);
  assert.match(guarded, /Obsidian 저장 실패/);
});
