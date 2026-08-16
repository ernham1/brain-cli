"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { writeJsonl } = require("../src/utils");
const {
  compileWorkerMemoryProfile,
  extractWorkerEvidence,
  inferEvidenceClasses,
  inferTaskType,
  calculateConfidenceLevel
} = require("../src/worker-memory-compiler");

let testRoot;

function setupRoot() {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-worker-memory-"));
  fs.mkdirSync(path.join(testRoot, "90_index"), { recursive: true });
}

function teardownRoot() {
  fs.rmSync(testRoot, { recursive: true, force: true });
}

function writeRecords(records) {
  writeJsonl(path.join(testRoot, "90_index", "records.jsonl"), records);
}

function sampleRecords() {
  return [
    {
      recordId: "rec_proj_brain_20260601_0001",
      scopeType: "project",
      scopeId: "brain",
      type: "log",
      title: "설계서 검증 완료",
      summary: "설계서 검증 후 파일과 코드 대조, npm test 통과 증거를 남겼다.",
      tags: ["domain/design", "intent/verification"],
      sourceType: "candidate",
      sourceRef: "10_projects/brain/verify-design.md",
      status: "active",
      updatedAt: "2026-06-01T00:00:00.000Z"
    },
    {
      recordId: "rec_proj_brain_20260601_0002",
      scopeType: "project",
      scopeId: "brain",
      type: "decision",
      title: "구현 전 범위 결정",
      summary: "구현은 P0 Compiler로 제한하기로 결정했다. 이유는 TeamEngram UI가 현재 워크스페이스 밖이기 때문이다.",
      tags: ["domain/dev", "intent/decision"],
      sourceType: "user_confirmed",
      sourceRef: "10_projects/brain/p0-decision.md",
      status: "active",
      updatedAt: "2026-06-01T01:00:00.000Z"
    },
    {
      recordId: "rec_proj_brain_20260601_0003",
      scopeType: "project",
      scopeId: "brain",
      type: "rule",
      title: "작업 절차 규칙",
      summary: "작업 시작 전 recall, 현재 코드 확인, 완료 전 테스트와 lint를 실행한다.",
      tags: ["domain/dev", "intent/rule"],
      sourceType: "user_confirmed",
      sourceRef: "10_projects/brain/workflow-rule.md",
      status: "active",
      updatedAt: "2026-06-01T02:00:00.000Z"
    },
    {
      recordId: "rec_proj_brain_20260601_0004",
      scopeType: "project",
      scopeId: "brain",
      type: "log",
      title: "오류 수정 실패 재발 방지",
      summary: "빌드만 보고 완료라 한 실패를 방지하기 위해 스모크 검증을 추가했다.",
      tags: ["domain/dev", "intent/debug"],
      sourceType: "candidate",
      sourceRef: "10_projects/brain/anti-pattern.md",
      status: "active",
      updatedAt: "2026-06-01T03:00:00.000Z"
    },
    {
      recordId: "rec_proj_brain_20260601_0005",
      scopeType: "project",
      scopeId: "brain",
      type: "log",
      title: "문서 구현 지시서 작성",
      summary: "구현 지시서 문서를 작성하고 검증 기준을 추가했다.",
      tags: ["domain/design", "intent/documentation"],
      sourceType: "candidate",
      sourceRef: "10_projects/brain/implementation-doc.md",
      status: "active",
      updatedAt: "2026-06-01T04:00:00.000Z"
    }
  ];
}

describe("Worker Memory Compiler", () => {
  beforeEach(setupRoot);
  afterEach(teardownRoot);

  it("Brain records에서 Worker Memory Profile을 생성한다", () => {
    writeRecords(sampleRecords());

    const profile = compileWorkerMemoryProfile(testRoot, {
      workerId: "codex",
      teamId: "neuralflux",
      scopeId: "brain",
      generatedAt: "2026-06-02T00:00:00.000Z"
    });

    assert.equal(profile.workerId, "codex");
    assert.equal(profile.profileVersion, "1.0");
    assert.ok(profile.evidence.length >= 10);
    assert.ok(profile.taskPatterns.length > 0);
    assert.ok(profile.workflowTemplates.length > 0);
    assert.ok(profile.qualityGates.length > 0);
    assert.ok(["L2", "L3", "L4"].includes(profile.confidenceLevel));
  });

  it("profile aggregate 항목은 sourceRef가 있는 evidence만 사용한다", () => {
    const records = sampleRecords();
    records.push({
      recordId: "rec_proj_brain_20260601_0006",
      scopeType: "project",
      scopeId: "brain",
      type: "log",
      title: "sourceRef 없는 테스트 기록",
      summary: "검증 테스트 기록이지만 sourceRef가 없다.",
      tags: ["domain/dev"],
      sourceType: "candidate",
      sourceRef: "",
      status: "active",
      updatedAt: "2026-06-01T05:00:00.000Z"
    });
    writeRecords(records);

    const profile = compileWorkerMemoryProfile(testRoot, {
      workerId: "codex",
      scopeId: "brain"
    });

    assert.ok(profile.openRisks.some(risk => risk.includes("sourceRef 없는 evidence")));
    for (const group of [
      profile.taskPatterns,
      profile.decisionPatterns,
      profile.workflowTemplates,
      profile.antiPatterns,
      profile.qualityGates
    ]) {
      for (const item of group) {
        assert.ok(item.sourceRefs.length > 0);
      }
    }
  });

  it("scopeId와 record type 기준으로 대상 기록을 제한한다", () => {
    const records = sampleRecords();
    records.push({
      recordId: "rec_proj_other_20260601_0001",
      scopeType: "project",
      scopeId: "other",
      type: "log",
      title: "다른 프로젝트 구현",
      summary: "다른 프로젝트 테스트 통과",
      tags: [],
      sourceType: "candidate",
      sourceRef: "10_projects/other/log.md",
      status: "active",
      updatedAt: "2026-06-01T00:00:00.000Z"
    });
    records.push({
      recordId: "rec_proj_brain_20260601_0007",
      scopeType: "project",
      scopeId: "brain",
      type: "note",
      title: "note 제외",
      summary: "note 타입은 P0 대상이 아니다.",
      tags: [],
      sourceType: "candidate",
      sourceRef: "10_projects/brain/note.md",
      status: "active",
      updatedAt: "2026-06-01T00:00:00.000Z"
    });
    writeRecords(records);

    const profile = compileWorkerMemoryProfile(testRoot, {
      workerId: "codex",
      scopeId: "brain"
    });

    assert.equal(profile.evidence.some(item => item.recordId === "rec_proj_other_20260601_0001"), false);
    assert.equal(profile.evidence.some(item => item.recordId === "rec_proj_brain_20260601_0007"), false);
  });

  it("기록에서 evidence class와 taskType을 결정한다", () => {
    const record = sampleRecords()[0];
    const classes = inferEvidenceClasses(record);
    const evidence = extractWorkerEvidence(record);

    assert.ok(classes.includes("quality_gate"));
    assert.equal(inferTaskType(record), "design_verification");
    assert.ok(evidence.every(item => item.sourceRef === record.sourceRef));
  });

  it("confidenceLevel을 evidence 양과 품질 기준으로 산정한다", () => {
    assert.equal(calculateConfidenceLevel({ usableEvidenceCount: 0 }), "L0");
    assert.equal(calculateConfidenceLevel({ usableEvidenceCount: 4 }), "L1");
    assert.equal(calculateConfidenceLevel({ usableEvidenceCount: 6, workflowTemplateCount: 1 }), "L2");
    assert.equal(calculateConfidenceLevel({ usableEvidenceCount: 10, workflowTemplateCount: 1, qualityGateCount: 1 }), "L3");
    assert.equal(calculateConfidenceLevel({ usableEvidenceCount: 12, workflowTemplateCount: 1, qualityGateCount: 3, confirmedEvidenceCount: 10 }), "L4");
  });
});
