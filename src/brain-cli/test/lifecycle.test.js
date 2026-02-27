"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  validateTransition,
  checkDeleteGate,
  detectContamination,
  checkSSOTPromotionGate,
  checkFolderAutoCreate,
  detectDeprecatedReferences
} = require("../src/lifecycle");
const { writeJsonl } = require("../src/utils");

let testRoot;

function setupBrain(records = []) {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-lifecycle-test-"));
  fs.mkdirSync(path.join(testRoot, "90_index"), { recursive: true });
  writeJsonl(path.join(testRoot, "90_index", "records.jsonl"), records);
}

function teardownBrain() {
  if (testRoot && fs.existsSync(testRoot)) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

// --- 상태 전환 ---

describe("validateTransition", () => {
  it("active → deprecated 허용", () => {
    assert.equal(validateTransition("active", "deprecated").allowed, true);
  });

  it("active → archived 허용", () => {
    assert.equal(validateTransition("active", "archived").allowed, true);
  });

  it("deprecated → active 허용 (복원)", () => {
    assert.equal(validateTransition("deprecated", "active").allowed, true);
  });

  it("deprecated → archived 금지", () => {
    const result = validateTransition("deprecated", "archived");
    assert.equal(result.allowed, false);
  });

  it("archived → active 금지", () => {
    const result = validateTransition("archived", "active");
    assert.equal(result.allowed, false);
  });

  it("알 수 없는 상태에서 전환 금지", () => {
    const result = validateTransition("unknown", "active");
    assert.equal(result.allowed, false);
  });
});

// --- 삭제 게이트 ---

describe("checkDeleteGate", () => {
  it("3조건 모두 충족 시 삭제 허용", () => {
    const record = {
      status: "deprecated",
      replacedBy: "rec_proj_a_20260101_0002",
      updatedAt: "2026-02-25T10:00:00.000Z"
    };
    const result = checkDeleteGate(record, {
      userConfirmed: true,
      currentSessionStart: "2026-02-26T00:00:00.000Z"
    });
    assert.equal(result.allowed, true);
    assert.equal(result.unmet.length, 0);
  });

  it("deprecated 상태가 아니면 거부", () => {
    const record = { status: "active", replacedBy: null };
    const result = checkDeleteGate(record, { userConfirmed: true });
    assert.equal(result.allowed, false);
    assert.ok(result.unmet[0].includes("deprecated 상태가 아닙니다"));
  });

  it("현재 세션에서 deprecated된 레코드는 거부", () => {
    const record = {
      status: "deprecated",
      replacedBy: "obsolete",
      updatedAt: "2026-02-26T12:00:00.000Z"
    };
    const result = checkDeleteGate(record, {
      userConfirmed: true,
      currentSessionStart: "2026-02-26T10:00:00.000Z"
    });
    assert.equal(result.allowed, false);
    assert.ok(result.unmet.some(u => u.includes("1세션 경과")));
  });

  it("replacedBy 없으면 거부", () => {
    const record = {
      status: "deprecated",
      replacedBy: null,
      updatedAt: "2026-02-24T10:00:00.000Z"
    };
    const result = checkDeleteGate(record, {
      userConfirmed: true,
      currentSessionStart: "2026-02-26T00:00:00.000Z"
    });
    assert.equal(result.allowed, false);
    assert.ok(result.unmet.some(u => u.includes("replacedBy")));
  });

  it("사용자 확인 없으면 거부", () => {
    const record = {
      status: "deprecated",
      replacedBy: "obsolete",
      updatedAt: "2026-02-24T10:00:00.000Z"
    };
    const result = checkDeleteGate(record, {
      userConfirmed: false,
      currentSessionStart: "2026-02-26T00:00:00.000Z"
    });
    assert.equal(result.allowed, false);
    assert.ok(result.unmet.some(u => u.includes("사용자 확인")));
  });
});

// --- 오염 감지 ---

describe("detectContamination", () => {
  after(() => teardownBrain());

  it("inference가 rule 타입으로 등록되면 오염으로 감지해야 한다", () => {
    setupBrain([
      {
        recordId: "rec_proj_a_20260226_0001",
        scopeType: "project", scopeId: "a",
        type: "rule", title: "추론 규칙",
        summary: "", tags: [], sourceType: "inference",
        sourceRef: "", status: "active",
        replacedBy: null, deprecationReason: null,
        updatedAt: "2026-02-26T10:00:00.000Z",
        contentHash: "sha256:abc"
      }
    ]);

    const result = detectContamination(testRoot);
    assert.equal(result.clean, false);
    assert.equal(result.contaminated.length, 1);
    assert.equal(result.contaminated[0].sourceType, "inference");
  });

  it("candidate가 decision 타입이면 오염", () => {
    setupBrain([
      {
        recordId: "rec_proj_a_20260226_0001",
        scopeType: "project", scopeId: "a",
        type: "decision", title: "후보 결정",
        summary: "", tags: [], sourceType: "candidate",
        sourceRef: "", status: "active",
        replacedBy: null, deprecationReason: null,
        updatedAt: "2026-02-26T10:00:00.000Z",
        contentHash: "sha256:abc"
      }
    ]);

    const result = detectContamination(testRoot);
    assert.equal(result.clean, false);
  });

  it("user_confirmed의 rule은 오염이 아니다", () => {
    setupBrain([
      {
        recordId: "rec_proj_a_20260226_0001",
        scopeType: "project", scopeId: "a",
        type: "rule", title: "확정 규칙",
        summary: "", tags: [], sourceType: "user_confirmed",
        sourceRef: "", status: "active",
        replacedBy: null, deprecationReason: null,
        updatedAt: "2026-02-26T10:00:00.000Z",
        contentHash: "sha256:abc"
      }
    ]);

    const result = detectContamination(testRoot);
    assert.equal(result.clean, true);
  });

  it("note 타입은 sourceType 상관없이 오염 아님", () => {
    setupBrain([
      {
        recordId: "rec_topic_a_20260226_0001",
        scopeType: "topic", scopeId: "a",
        type: "note", title: "추론 노트",
        summary: "", tags: [], sourceType: "inference",
        sourceRef: "", status: "active",
        replacedBy: null, deprecationReason: null,
        updatedAt: "2026-02-26T10:00:00.000Z",
        contentHash: "sha256:abc"
      }
    ]);

    const result = detectContamination(testRoot);
    assert.equal(result.clean, true);
  });
});

// --- SSOT 승격 게이트 ---

describe("checkSSOTPromotionGate", () => {
  it("user_confirmed만 승격 허용", () => {
    assert.equal(checkSSOTPromotionGate("user_confirmed").allowed, true);
  });

  it("candidate 승격 거부", () => {
    assert.equal(checkSSOTPromotionGate("candidate").allowed, false);
  });

  it("inference 승격 거부", () => {
    assert.equal(checkSSOTPromotionGate("inference").allowed, false);
  });
});

// --- 폴더 자동 생성 ---

describe("checkFolderAutoCreate", () => {
  it("30_topics/ 자동 생성 허용", () => {
    assert.equal(checkFolderAutoCreate("30_topics/new-topic/notes.md").autoAllowed, true);
  });

  it("10_projects/ 자동 생성 제한", () => {
    assert.equal(checkFolderAutoCreate("10_projects/new/file.md").autoAllowed, false);
  });

  it("00_user/ 자동 생성 제한", () => {
    assert.equal(checkFolderAutoCreate("00_user/profile.md").autoAllowed, false);
  });
});

// --- deprecated 역참조 ---

describe("detectDeprecatedReferences", () => {
  after(() => teardownBrain());

  it("active 레코드가 deprecated를 참조하면 경고", () => {
    setupBrain([
      {
        recordId: "rec_proj_a_20260226_0001",
        scopeType: "project", scopeId: "a",
        type: "note", title: "원본",
        summary: "rec_proj_a_20260226_0002를 참조함",
        tags: [], sourceType: "user_confirmed",
        sourceRef: "", status: "active",
        replacedBy: null, deprecationReason: null,
        updatedAt: "2026-02-26T10:00:00.000Z",
        contentHash: "sha256:abc"
      },
      {
        recordId: "rec_proj_a_20260226_0002",
        scopeType: "project", scopeId: "a",
        type: "note", title: "삭제됨",
        summary: "", tags: [], sourceType: "user_confirmed",
        sourceRef: "", status: "deprecated",
        replacedBy: "obsolete", deprecationReason: "테스트",
        updatedAt: "2026-02-26T10:00:00.000Z",
        contentHash: "sha256:def"
      }
    ]);

    const warnings = detectDeprecatedReferences(testRoot);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].activeRecordId, "rec_proj_a_20260226_0001");
    assert.equal(warnings[0].referencedDeprecated, "rec_proj_a_20260226_0002");
  });

  it("deprecated가 없으면 경고 없음", () => {
    setupBrain([
      {
        recordId: "rec_proj_a_20260226_0001",
        scopeType: "project", scopeId: "a",
        type: "note", title: "노트",
        summary: "", tags: [], sourceType: "user_confirmed",
        sourceRef: "", status: "active",
        replacedBy: null, deprecationReason: null,
        updatedAt: "2026-02-26T10:00:00.000Z",
        contentHash: "sha256:abc"
      }
    ]);

    const warnings = detectDeprecatedReferences(testRoot);
    assert.equal(warnings.length, 0);
  });
});
