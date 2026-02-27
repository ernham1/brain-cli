"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { init } = require("../src/init");
const { validate } = require("../src/validate");
const { BWTEngine } = require("../src/bwt");
const { boot } = require("../src/boot");
const { search } = require("../src/search");
const { readJsonl, safeReadJson } = require("../src/utils");

let testDir;

before(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-init-test-"));
});

after(() => {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

// === V1: init 실행 → 필수 파일 5종 생성 ===
describe("V1: brain-cli init", () => {
  it("Brain/ 디렉토리 + 6개 폴더 + 5종 인덱스를 생성해야 한다", () => {
    const result = init(testDir);
    assert.equal(result.success, true);

    const brainRoot = result.brainRoot;

    // 6개 폴더
    assert.ok(fs.existsSync(path.join(brainRoot, "00_user")));
    assert.ok(fs.existsSync(path.join(brainRoot, "10_projects")));
    assert.ok(fs.existsSync(path.join(brainRoot, "20_agents")));
    assert.ok(fs.existsSync(path.join(brainRoot, "30_topics")));
    assert.ok(fs.existsSync(path.join(brainRoot, "90_index")));
    assert.ok(fs.existsSync(path.join(brainRoot, "99_policy")));

    // 5종 인덱스 파일
    assert.ok(fs.existsSync(path.join(brainRoot, "90_index", "records.jsonl")));
    assert.ok(fs.existsSync(path.join(brainRoot, "90_index", "tags.json")));
    assert.ok(fs.existsSync(path.join(brainRoot, "90_index", "folderRegistry.json")));
    assert.ok(fs.existsSync(path.join(brainRoot, "90_index", "manifest.json")));
    assert.ok(fs.existsSync(path.join(brainRoot, "90_index", "records_digest.txt")));

    // brainPolicy.md
    assert.ok(fs.existsSync(path.join(brainRoot, "99_policy", "brainPolicy.md")));
  });

  it("멱등: 두 번 실행해도 기존 파일을 덮어쓰지 않아야 한다", () => {
    const result2 = init(testDir);
    assert.equal(result2.success, true);
    assert.ok(result2.skipped.length > 0);
    assert.equal(result2.created.filter(f => f.endsWith(".json") || f.endsWith(".jsonl") || f.endsWith(".md") || f.endsWith(".txt")).length, 0);
  });
});

// === V2: BWT 정상 → 문서 + 인덱스 갱신 + .bak 정리 ===
describe("V2: BWT 정상 실행", () => {
  it("create → 파일/인덱스 갱신 + .bak 정리", () => {
    const brainRoot = path.join(testDir, "Brain");
    const engine = new BWTEngine(brainRoot);

    const result = engine.execute({
      action: "create",
      sourceRef: "30_topics/v2-test/notes.md",
      content: "# V2 테스트\nBWT 검증용 문서",
      record: {
        scopeType: "topic",
        scopeId: "v2-test",
        type: "note",
        title: "V2 검증 노트",
        summary: "BWT V2 체크리스트 검증",
        tags: ["domain/memory", "intent/debug"],
        sourceType: "candidate"
      }
    });

    assert.equal(result.success, true);

    // 문서 생성
    assert.ok(fs.existsSync(path.join(brainRoot, "30_topics", "v2-test", "notes.md")));

    // records.jsonl 갱신
    const records = readJsonl(path.join(brainRoot, "90_index", "records.jsonl"));
    assert.ok(records.length >= 1);

    // .bak 없음
    const indexFiles = fs.readdirSync(path.join(brainRoot, "90_index"));
    assert.equal(indexFiles.filter(f => f.endsWith(".bak")).length, 0);
  });
});

// === V3: BWT 실패 시나리오 → .bak 복구 ===
describe("V3: BWT 실패 시 .bak 복구", () => {
  it("존재하지 않는 recordId update 시 원본 보존", () => {
    const brainRoot = path.join(testDir, "Brain");
    const recordsBefore = readJsonl(path.join(brainRoot, "90_index", "records.jsonl"));

    const engine = new BWTEngine(brainRoot);
    const result = engine.execute({
      action: "update",
      recordId: "rec_topic_nonexistent_20260101_9999",
      content: "실패 테스트"
    });

    assert.equal(result.success, false);

    // 원본 보존
    const recordsAfter = readJsonl(path.join(brainRoot, "90_index", "records.jsonl"));
    assert.deepEqual(recordsAfter.length, recordsBefore.length);
  });
});

// === V4: validate 통과 후 .bak/.tmp 잔류 없음 ===
describe("V4: validate 통과 + 잔류 없음", () => {
  it("validate PASS + .bak/.tmp 없음", () => {
    const brainRoot = path.join(testDir, "Brain");
    const result = validate(brainRoot);

    assert.equal(result.passed, true);

    const indexFiles = fs.readdirSync(path.join(brainRoot, "90_index"));
    assert.equal(indexFiles.filter(f => f.endsWith(".tmp")).length, 0);
    assert.equal(indexFiles.filter(f => f.endsWith(".bak")).length, 0);
  });
});

// === V5: digest 검색 → 후보 → sourceRef 로드 ===
describe("V5: digest 검색", () => {
  it("digest에서 검색 → 후보 반환 → sourceRef 로드 가능", () => {
    const brainRoot = path.join(testDir, "Brain");

    // 검색
    const result = search(brainRoot, {
      scopeType: "topic",
      currentGoal: "V2 검증"
    });

    assert.ok(result.candidates.length >= 1);

    // sourceRef 로드 (records.jsonl에서 상세 조회)
    const records = readJsonl(path.join(brainRoot, "90_index", "records.jsonl"));
    const found = records.find(r => r.recordId === result.candidates[0].recordId);
    assert.ok(found);
    assert.ok(found.sourceRef);

    // 실제 파일 존재 확인
    const docPath = path.join(brainRoot, found.sourceRef);
    assert.ok(fs.existsSync(docPath));
  });
});

// === V6: 부트 충돌 감지 ===
describe("V6: 부트 시 외부 수정 감지", () => {
  it("파일 수동 수정 후 부트하면 불일치 감지", () => {
    const brainRoot = path.join(testDir, "Brain");

    // 문서 수동 변경
    const docPath = path.join(brainRoot, "30_topics", "v2-test", "notes.md");
    fs.writeFileSync(docPath, "# 수동 변경됨\n외부에서 수정됨", "utf-8");

    const result = boot(brainRoot);
    assert.equal(result.success, true);

    // manifest에 등록된 파일이 수동 변경됨 → 불일치 감지 가능
    // (단, 30_topics/v2-test/notes.md는 BWT가 manifest에 등록했으므로)
    const manifest = safeReadJson(path.join(brainRoot, "90_index", "manifest.json"));
    if (manifest.ok) {
      const entry = manifest.data.files.find(f => f.path === "30_topics/v2-test/notes.md");
      if (entry) {
        assert.ok(result.mismatches.length > 0, "수동 변경 감지 실패");
      }
    }
  });
});

// === V7: deprecated 역참조 경고 ===
describe("V7: deprecated 역참조 탐지", () => {
  it("deprecated 레코드를 참조하는 active 레코드 경고", () => {
    // V7은 별도 Brain으로 격리 (V6 부작용 방지)
    const v7Dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-v7-test-"));
    const v7Result = init(v7Dir);
    const v7Root = v7Result.brainRoot;

    // 참조 대상 생성
    const engine1 = new BWTEngine(v7Root);
    const target = engine1.execute({
      action: "create",
      sourceRef: "30_topics/v7-target/notes.md",
      content: "타겟 문서",
      record: {
        scopeType: "topic",
        scopeId: "v7-target",
        type: "note",
        title: "V7 타겟",
        summary: "deprecated될 예정",
        tags: ["domain/memory"],
        sourceType: "candidate"
      }
    });
    assert.equal(target.success, true);

    // 타겟을 참조하는 레코드 생성
    const engine2 = new BWTEngine(v7Root);
    const referrer = engine2.execute({
      action: "create",
      sourceRef: "30_topics/v7-ref/notes.md",
      content: "참조 문서",
      record: {
        scopeType: "topic",
        scopeId: "v7-ref",
        type: "note",
        title: "V7 참조자",
        summary: `${target.recordId}를 참조합니다`,
        tags: ["domain/memory"],
        sourceType: "candidate"
      }
    });
    assert.equal(referrer.success, true);

    // 타겟을 deprecate
    const engine3 = new BWTEngine(v7Root);
    const depResult = engine3.execute({
      action: "deprecate",
      recordId: target.recordId,
      replacedBy: "obsolete",
      deprecationReason: "V7 테스트"
    });
    assert.equal(depResult.success, true);

    // full validate로 역참조 경고 확인
    const valResult = validate(v7Root, { full: true });
    const depWarnings = valResult.warnings.filter(w => w.includes("deprecated"));
    assert.ok(depWarnings.length > 0, "deprecated 역참조 경고가 출력되어야 합니다");

    // 정리
    fs.rmSync(v7Dir, { recursive: true, force: true });
  });
});
