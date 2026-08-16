import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGeneratedSourceRef,
  isSafeRelativeSourceRef,
  normalizeBrainWriteIntent,
  normalizeSourceRef,
  normalizeSourceType,
} from "../dist/tools.js";

test("brain_write normalization maps unsupported sourceType aliases", () => {
  assert.equal(normalizeSourceType("internal_doc"), "candidate");
  assert.equal(normalizeSourceType("external_doc"), "external_doc");
  assert.equal(normalizeSourceType("unknown_source"), "candidate");
});

test("brain_write normalization rejects unsafe absolute sourceRef", () => {
  const normalized = normalizeSourceRef("C:\\Projects\\AgentForge\\docs\\design\\mission-data.md");
  assert.equal(normalized, "C:/Projects/AgentForge/docs/design/mission-data.md");
  assert.equal(isSafeRelativeSourceRef(normalized), false);

  const generated = buildGeneratedSourceRef(
    { scopeType: "project", scopeId: "agentforge", title: "설계서" },
    normalized,
  );
  assert.match(generated, /^10_projects\/agentforge\/\d{8}_mission-data\.md$/);
});

test("brain_write normalization accepts Brain relative sourceRef", () => {
  const normalized = normalizeSourceRef("10_projects\\agentforge\\note.md");
  assert.equal(normalized, "10_projects/agentforge/note.md");
  assert.equal(isSafeRelativeSourceRef(normalized), true);
});

test("brain_write normalization promotes legacy top-level project fields", () => {
  const normalized = normalizeBrainWriteIntent({
    type: "project",
    project: "꿀잠베개",
    title: "목이편해 꿀잠베개 사업화 로드맵",
    summary: "실용신안 확보 후 시제품과 펀딩을 진행한다.",
  });

  assert.equal(normalized.action, "create");
  assert.equal(normalized.record.scopeType, "project");
  assert.equal(normalized.record.scopeId, "꿀잠베개");
  assert.equal(normalized.record.title, "목이편해 꿀잠베개 사업화 로드맵");
  assert.equal(normalized.record.summary, "실용신안 확보 후 시제품과 펀딩을 진행한다.");
  assert.match(normalized.sourceRef, /^10_projects\/꿀잠베개\/\d{8}_/);
});
test("brain_write normalization maps common record type aliases", () => {
  const verification = normalizeBrainWriteIntent({
    action: "create",
    record: { type: "verification" },
  });
  const milestone = normalizeBrainWriteIntent({
    action: "create",
    record: { type: "milestone" },
  });

  assert.equal(verification.record.type, "log");
  assert.equal(milestone.record.type, "project_state");
});

test("brain_write normalization maps legacy action aliases without guessing updates", () => {
  const recordAction = normalizeBrainWriteIntent({ action: "record" });
  const createUpsert = normalizeBrainWriteIntent({ action: "upsert" });
  const updateUpsert = normalizeBrainWriteIntent({
    action: "upsert",
    recordId: "rec_topic_test_20260728_0001",
  });

  assert.equal(recordAction.action, "create");
  assert.equal(createUpsert.action, "create");
  assert.equal(updateUpsert.action, "update");
});