"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { boot } = require("../src/boot");
const { calculateHashFromString } = require("../src/utils");

let testRoot;

function setupBrain(opts = {}) {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-boot-test-"));

  const dirs = ["00_user", "10_projects", "20_agents", "30_topics", "90_index", "99_policy"];
  for (const d of dirs) {
    fs.mkdirSync(path.join(testRoot, d), { recursive: true });
  }

  const policyContent = "# Brain 운영 정책\n\n## 테스트용 정책";
  fs.writeFileSync(path.join(testRoot, "99_policy", "brainPolicy.md"), policyContent, "utf-8");

  const policyHash = calculateHashFromString(policyContent);
  const manifest = {
    version: "1.0",
    brainRoot: "Brain",
    updatedAt: new Date().toISOString(),
    summary: { totalFiles: 1, byCategory: { policy: 1, user: 0, project: 0, agent: 0, topic: 0, index: 0 } },
    files: [
      {
        path: "99_policy/brainPolicy.md",
        hash: opts.wrongHash ? "sha256:0000000000000000000000000000000000000000000000000000000000000000" : policyHash,
        size: Buffer.byteLength(policyContent, "utf-8"),
        updatedAt: new Date().toISOString(),
        category: "policy"
      }
    ]
  };
  fs.writeFileSync(path.join(testRoot, "90_index", "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

  if (opts.userProfile) {
    fs.writeFileSync(path.join(testRoot, "00_user", "userProfile.md"), opts.userProfile, "utf-8");
  }
}

function teardownBrain() {
  if (testRoot && fs.existsSync(testRoot)) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

describe("boot: 정상 부트", () => {
  before(() => setupBrain());
  after(() => teardownBrain());

  it("policy와 manifest를 정상 로드해야 한다", () => {
    const result = boot(testRoot);
    assert.equal(result.success, true);
    assert.ok(result.policy.includes("Brain 운영 정책"));
    assert.ok(result.manifest);
    assert.equal(result.manifest.version, "1.0");
    assert.equal(result.mismatches.length, 0);
  });
});

describe("boot: 해시 불일치 감지", () => {
  before(() => setupBrain({ wrongHash: true }));
  after(() => teardownBrain());

  it("수동 변경을 감지하고 mismatch를 보고해야 한다", () => {
    const result = boot(testRoot);
    assert.equal(result.success, true);
    assert.equal(result.mismatches.length, 1);
    assert.equal(result.mismatches[0].path, "99_policy/brainPolicy.md");
    assert.equal(result.mismatches[0].reason, "해시 불일치 (수동 변경 감지)");
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings[0].includes("수동 변경 감지"));
  });
});

describe("boot: brainPolicy.md 없음", () => {
  before(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-boot-test-"));
    fs.mkdirSync(path.join(testRoot, "90_index"), { recursive: true });
    fs.mkdirSync(path.join(testRoot, "99_policy"), { recursive: true });
  });
  after(() => teardownBrain());

  it("실패를 반환해야 한다", () => {
    const result = boot(testRoot);
    assert.equal(result.success, false);
    assert.ok(result.error.includes("brainPolicy.md"));
  });
});

describe("boot: 스코프 선언", () => {
  before(() => setupBrain());
  after(() => teardownBrain());

  it("지정된 스코프가 올바르게 반환되어야 한다", () => {
    const result = boot(testRoot, { scopeType: "project", scopeId: "myApp" });
    assert.equal(result.success, true);
    assert.equal(result.scope.scopeType, "project");
    assert.equal(result.scope.scopeId, "myApp");
  });
});

describe("boot: userProfile 로드", () => {
  before(() => setupBrain({ userProfile: "# 사용자 프로필\n이름: 테스트" }));
  after(() => teardownBrain());

  it("스코프 미지정 시 userProfile을 자동 로드해야 한다", () => {
    const result = boot(testRoot);
    assert.equal(result.success, true);
    assert.ok(result.userProfile);
    assert.ok(result.userProfile.includes("사용자 프로필"));
  });

  it("스코프 지정 시 userProfile을 로드하지 않아야 한다", () => {
    const result = boot(testRoot, { scopeType: "project", scopeId: "x" });
    assert.equal(result.success, true);
    assert.equal(result.userProfile, null);
  });
});
