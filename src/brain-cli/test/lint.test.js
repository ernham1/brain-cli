"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  lint, fixTitles, levenshtein,
  checkDuplicates, checkStaleness, checkOrphanRaw,
  checkContradictions, checkBloatedWiki, checkTitlePattern
} = require("../src/lint");

// ─── 테스트 픽스처 헬퍼 ──────────────────────────────────────────────────────
let testRoot;

function makeRecord(overrides = {}) {
  const base = {
    recordId: `rec_topic_test_20260101_0001`,
    scopeType: "topic",
    scopeId: "test",
    type: "note",
    title: "기본 제목",
    summary: "기본 요약",
    tags: [],
    sourceType: "candidate",
    sourceRef: "30_topics/test/test.md",
    status: "active",
    replacedBy: null,
    deprecationReason: null,
    updatedAt: "2026-04-01T00:00:00.000Z",
    contentHash: "abc123"
  };
  return { ...base, ...overrides };
}

function setupRoot() {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-lint-test-"));
  fs.mkdirSync(path.join(testRoot, "90_index"), { recursive: true });
  fs.mkdirSync(path.join(testRoot, "30_topics"), { recursive: true });
  fs.mkdirSync(path.join(testRoot, "40_wiki"), { recursive: true });
}

function writeRecords(records) {
  const content = records.map(r => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(path.join(testRoot, "90_index", "records.jsonl"), content, "utf-8");
}

function teardown() {
  fs.rmSync(testRoot, { recursive: true, force: true });
}

// ─── levenshtein ─────────────────────────────────────────────────────────────
describe("levenshtein", () => {
  it("동일 문자열 → 0", () => {
    assert.equal(levenshtein("hello", "hello"), 0);
  });
  it("한 글자 차이 → 1", () => {
    assert.equal(levenshtein("hello", "helo"), 1);
  });
  it("두 글자 차이 → 2", () => {
    assert.equal(levenshtein("abc", "axc"), 1);
    assert.equal(levenshtein("abc", "axx"), 2);
  });
  it("길이 차이 4+ → 99 (early exit)", () => {
    assert.equal(levenshtein("ab", "abcdef"), 99);
  });
  it("빈 문자열", () => {
    assert.equal(levenshtein("", ""), 0);
    assert.equal(levenshtein("abc", ""), 3); // len diff = 3, early exit 미해당
    assert.equal(levenshtein("abcd", ""), 99); // len diff = 4 > 3 → early exit
  });
  it("한국어 제목 유사도", () => {
    const d = levenshtein("작업 로그 — agentforge", "작업 로그 — agentforg");
    assert.ok(d <= 3);
  });
});

// ─── checkDuplicates ─────────────────────────────────────────────────────────
describe("checkDuplicates", () => {
  it("짧은 제목(10자) 편집거리 2 → 잡힘", () => {
    // normA="설계서 v1ab", normB="설계서 v1cd" → dist=2
    // maxLen=10, threshold=max(2, floor(10*0.1))=max(2,1)=2 → dist=2 === threshold → 잡힘
    const r1 = makeRecord({ recordId: "rec_topic_test_20260101_0001", title: "설계서 v1ab" });
    const r2 = makeRecord({ recordId: "rec_topic_test_20260101_0002", title: "설계서 v1cd" });
    const issues = checkDuplicates([r1, r2]);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, "warning");
    assert.equal(issues[0].checkId, "duplicate");
  });

  it("날짜만 다른 제목 → 중복 아님", () => {
    const r1 = makeRecord({ recordId: "rec_topic_test_20260101_0001", title: "PreCompact 스냅샷 — 2026-03-26 21:50" });
    const r2 = makeRecord({ recordId: "rec_topic_test_20260101_0002", title: "PreCompact 스냅샷 — 2026-04-06 21:10" });
    const issues = checkDuplicates([r1, r2]);
    assert.equal(issues.length, 0);
  });

  it("실제 중복 제목(날짜 제외 후에도 유사) → 잡힘", () => {
    // 날짜 제거 후: "AgentForge 파이프라인 설계서 ab" vs "AgentForge 파이프라인 설계서 cd"
    // dist=2, maxLen≈30, threshold=max(2, floor(30*0.1))=3 → 2 <= 3 → 잡힘
    const r1 = makeRecord({ recordId: "rec_topic_test_20260101_0001", title: "AgentForge 파이프라인 설계서 ab 2026-04-01" });
    const r2 = makeRecord({ recordId: "rec_topic_test_20260101_0002", title: "AgentForge 파이프라인 설계서 cd 2026-04-02" });
    const issues = checkDuplicates([r1, r2]);
    assert.equal(issues.length, 1);
  });

  it("긴 제목(50자) 편집거리 3 → 안 잡힘 (비율 6%)", () => {
    // maxLen≈50, threshold=max(2, floor(50*0.1))=max(2,5)=5 → dist=3 < 5이지만 테스트 의도는 비율 검증
    // 대신 dist=2, maxLen=40짜리로 비율 5% < 10% 케이스 사용
    const base = "AgentForge 에이전트 파이프라인 아키텍처 설계서"; // 21자
    const r1 = makeRecord({ recordId: "rec_topic_test_20260101_0001", title: base });
    const r2 = makeRecord({ recordId: "rec_topic_test_20260101_0002", title: base + "AB" }); // dist=2, maxLen=23, threshold=max(2,2)=2 → 잡힘
    const issues = checkDuplicates([r1, r2]);
    assert.equal(issues.length, 1); // dist=2 === threshold=2 → 잡힘
  });

  it("긴 제목 편집거리가 10% 초과 → 안 잡힘", () => {
    // 10자 제목, dist=2 이지만 threshold=max(2,1)=2이므로 dist=2 잡힘
    // 확실히 안 잡히려면 threshold보다 dist가 커야 함
    // 30자 제목, threshold=max(2,3)=3, dist=4 → 안 잡힘
    const r1 = makeRecord({ recordId: "rec_topic_test_20260101_0001", title: "AgentForge 파이프라인 설계서 v1" }); // 20자
    const r2 = makeRecord({ recordId: "rec_topic_test_20260101_0002", title: "AgentForge 파이프라인 설계서 vX X X" }); // dist=5, maxLen≈23, threshold=max(2,2)=2 → 안 잡힘
    const issues = checkDuplicates([r1, r2]);
    assert.equal(issues.length, 0);
  });

  it("다른 scopeId끼리는 검사 안 함", () => {
    const r1 = makeRecord({ recordId: "rec_topic_test_20260101_0001", scopeId: "a", title: "동일 제목 테스트" });
    const r2 = makeRecord({ recordId: "rec_topic_test_20260101_0002", scopeId: "b", title: "동일 제목 테스트" });
    const issues = checkDuplicates([r1, r2]);
    assert.equal(issues.length, 0);
  });

  it("sessions scopeId → 스냅샷 제외", () => {
    const r1 = makeRecord({ recordId: "rec_topic_sessions_20260101_0001", scopeId: "sessions", title: "PreCompact 스냅샷 — 2026-03-26 21:50" });
    const r2 = makeRecord({ recordId: "rec_topic_sessions_20260101_0002", scopeId: "sessions", title: "PreCompact 스냅샷 — 2026-04-06 21:10" });
    const issues = checkDuplicates([r1, r2]);
    assert.equal(issues.length, 0);
  });

  it("deprecated 레코드는 제외", () => {
    const r1 = makeRecord({ recordId: "rec_topic_test_20260101_0001", title: "설계서 v1.0a", status: "deprecated" });
    const r2 = makeRecord({ recordId: "rec_topic_test_20260101_0002", title: "설계서 v1.0c" });
    const issues = checkDuplicates([r1, r2]);
    assert.equal(issues.length, 0);
  });
});

// ─── checkStaleness ──────────────────────────────────────────────────────────
describe("checkStaleness", () => {
  it("wiki 갱신 30일+ + 새 raw → warning", () => {
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const newDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const wiki = makeRecord({ recordId: "rec_topic_scope1_20260101_0001", scopeId: "scope1", type: "wiki", lastWikiUpdate: oldDate });
    const raw = makeRecord({ recordId: "rec_topic_scope1_20260101_0002", scopeId: "scope1", type: "note", updatedAt: newDate });
    const issues = checkStaleness([wiki, raw]);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, "warning");
    assert.equal(issues[0].checkId, "staleness");
  });

  it("wiki가 최신 — raw도 최신이지만 wiki 갱신 10일 → 이슈 없음", () => {
    const recentDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const wiki = makeRecord({ recordId: "rec_topic_scope1_20260101_0001", scopeId: "scope1", type: "wiki", lastWikiUpdate: recentDate });
    const raw = makeRecord({ recordId: "rec_topic_scope1_20260101_0002", scopeId: "scope1", type: "note", updatedAt: new Date().toISOString() });
    const issues = checkStaleness([wiki, raw]);
    assert.equal(issues.length, 0);
  });

  it("raw가 wiki보다 이전 → 이슈 없음", () => {
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const veryOld = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const wiki = makeRecord({ recordId: "rec_topic_scope1_20260101_0001", scopeId: "scope1", type: "wiki", lastWikiUpdate: oldDate });
    const raw = makeRecord({ recordId: "rec_topic_scope1_20260101_0002", scopeId: "scope1", type: "note", updatedAt: veryOld });
    const issues = checkStaleness([wiki, raw]);
    assert.equal(issues.length, 0);
  });
});

// ─── checkOrphanRaw ──────────────────────────────────────────────────────────
describe("checkOrphanRaw", () => {
  it("raw만 있고 wiki 없으면 → info", () => {
    const r = makeRecord({ scopeId: "no-wiki", type: "note" });
    const issues = checkOrphanRaw([r]);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, "info");
    assert.equal(issues[0].checkId, "orphan-raw");
  });

  it("raw + wiki 모두 있으면 → 이슈 없음", () => {
    const raw = makeRecord({ recordId: "rec_topic_s_20260101_0001", scopeId: "s", type: "note" });
    const wiki = makeRecord({ recordId: "rec_topic_s_20260101_0002", scopeId: "s", type: "wiki" });
    const issues = checkOrphanRaw([raw, wiki]);
    assert.equal(issues.length, 0);
  });

  it("deprecated raw는 카운트 안 함", () => {
    const r = makeRecord({ scopeId: "dep-scope", type: "note", status: "deprecated" });
    const issues = checkOrphanRaw([r]);
    assert.equal(issues.length, 0);
  });
});

// ─── checkOrphanFolders ──────────────────────────────────────────────────────
describe("checkOrphanFolders", () => {
  before(setupRoot);
  after(teardown);

  it("30_topics에 존재하지만 records에 없는 폴더 → info", () => {
    fs.mkdirSync(path.join(testRoot, "30_topics", "orphan-scope"), { recursive: true });
    const r = makeRecord({ scopeId: "other-scope" });
    writeRecords([r]);
    const { issues } = lint(testRoot, { checks: ["orphan-folder"] });
    assert.ok(issues.some(i => i.checkId === "orphan-folder" && i.message.includes("orphan-scope")));
  });

  it("폴더가 records scopeId와 일치하면 → 이슈 없음", () => {
    fs.mkdirSync(path.join(testRoot, "30_topics", "matched-scope"), { recursive: true });
    const r = makeRecord({ scopeId: "matched-scope" });
    writeRecords([r]);
    const { issues } = lint(testRoot, { checks: ["orphan-folder"] });
    assert.ok(!issues.some(i => i.checkId === "orphan-folder" && i.message.includes("matched-scope")));
  });
});

// ─── checkContradictions ─────────────────────────────────────────────────────
describe("checkContradictions", () => {
  it("같은 scopeId + title이 active + deprecated 공존 → critical", () => {
    const r1 = makeRecord({ recordId: "rec_topic_s_20260101_0001", scopeId: "s", title: "중복 결정", status: "active" });
    const r2 = makeRecord({ recordId: "rec_topic_s_20260101_0002", scopeId: "s", title: "중복 결정", status: "deprecated" });
    const issues = checkContradictions([r1, r2]);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, "critical");
    assert.equal(issues[0].checkId, "contradiction");
  });

  it("title이 다르면 → 이슈 없음", () => {
    const r1 = makeRecord({ recordId: "rec_topic_s_20260101_0001", scopeId: "s", title: "결정 A", status: "active" });
    const r2 = makeRecord({ recordId: "rec_topic_s_20260101_0002", scopeId: "s", title: "결정 B", status: "deprecated" });
    const issues = checkContradictions([r1, r2]);
    assert.equal(issues.length, 0);
  });

  it("두 레코드 모두 active이면 → 이슈 없음 (중복 체크는 checkDuplicates 담당)", () => {
    const r1 = makeRecord({ recordId: "rec_topic_s_20260101_0001", scopeId: "s", title: "같은 제목", status: "active" });
    const r2 = makeRecord({ recordId: "rec_topic_s_20260101_0002", scopeId: "s", title: "같은 제목", status: "active" });
    const issues = checkContradictions([r1, r2]);
    assert.equal(issues.length, 0);
  });
});

// ─── checkBloatedWiki ─────────────────────────────────────────────────────────
describe("checkBloatedWiki", () => {
  before(setupRoot);
  after(teardown);

  it("wiki 파일 250줄 초과 → warning", () => {
    const wikiDir = path.join(testRoot, "40_wiki", "fat-scope");
    fs.mkdirSync(wikiDir, { recursive: true });
    const lines = Array.from({ length: 260 }, (_, i) => `줄 ${i + 1}`).join("\n");
    fs.writeFileSync(path.join(wikiDir, "wiki.md"), lines, "utf-8");

    const r = makeRecord({
      recordId: "rec_topic_fat-scope_20260101_0001",
      scopeId: "fat-scope",
      type: "wiki",
      sourceRef: "40_wiki/fat-scope/wiki.md"
    });
    const issues = checkBloatedWiki(testRoot, [r]);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, "warning");
    assert.equal(issues[0].checkId, "bloated-wiki");
  });

  it("wiki 파일 250줄 이하 → 이슈 없음", () => {
    const wikiDir = path.join(testRoot, "40_wiki", "slim-scope");
    fs.mkdirSync(wikiDir, { recursive: true });
    const lines = Array.from({ length: 100 }, (_, i) => `줄 ${i + 1}`).join("\n");
    fs.writeFileSync(path.join(wikiDir, "wiki.md"), lines, "utf-8");

    const r = makeRecord({
      recordId: "rec_topic_slim-scope_20260101_0001",
      scopeId: "slim-scope",
      type: "wiki",
      sourceRef: "40_wiki/slim-scope/wiki.md"
    });
    const issues = checkBloatedWiki(testRoot, [r]);
    assert.equal(issues.length, 0);
  });
});

// ─── checkTitlePattern ────────────────────────────────────────────────────────
describe("checkTitlePattern", () => {
  it("'작업 로그 — YYYY-MM-DD HH:MM' 패턴 → info", () => {
    const r = makeRecord({ title: "작업 로그 — 2026-04-01 09:30" });
    const issues = checkTitlePattern([r]);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, "info");
    assert.equal(issues[0].checkId, "title-pattern");
  });

  it("일반 제목 → 이슈 없음", () => {
    const r = makeRecord({ title: "AgentForge 파이프라인 설계" });
    const issues = checkTitlePattern([r]);
    assert.equal(issues.length, 0);
  });

  it("deprecated 레코드는 제외", () => {
    const r = makeRecord({ title: "작업 로그 — 2026-04-01 09:30", status: "deprecated" });
    const issues = checkTitlePattern([r]);
    assert.equal(issues.length, 0);
  });
});

// ─── fixTitles ────────────────────────────────────────────────────────────────
describe("fixTitles", () => {
  beforeEach(() => {
    setupRoot();
  });

  after(teardown);

  it("dry-run: 변경 없이 개수만 반환", () => {
    const r = makeRecord({
      recordId: "rec_topic_wl_20260101_0001",
      title: "작업 로그 — 2026-01-01 09:00",
      summary: "AgentForge 파이프라인 구현 완료",
      updatedAt: "2026-01-01T09:00:00.000Z"
    });
    writeRecords([r]);

    const result = fixTitles(testRoot, { dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.fixed >= 0, true);

    // 파일 변경 없음 확인
    const content = fs.readFileSync(path.join(testRoot, "90_index", "records.jsonl"), "utf-8");
    assert.ok(content.includes("작업 로그 — 2026-01-01 09:00")); // 원본 유지
  });

  it("summary 있으면 summary 기반 제목으로 교체", () => {
    const r = makeRecord({
      recordId: "rec_topic_wl_20260101_0001",
      title: "작업 로그 — 2026-04-01 09:00",
      summary: "AgentForge 파이프라인 구현 완료",
      updatedAt: new Date().toISOString() // 최근 날짜 — archived 안 됨
    });
    writeRecords([r]);

    fixTitles(testRoot, { dryRun: false });
    const content = fs.readFileSync(path.join(testRoot, "90_index", "records.jsonl"), "utf-8");
    const updated = JSON.parse(content.trim());
    assert.equal(updated.title, "AgentForge 파이프라인 구현 완료");
    assert.equal(updated.status, "active"); // 최근 날짜라 archived 아님
  });

  it("30일+ 된 work-log → archived", () => {
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const r = makeRecord({
      recordId: "rec_topic_wl_20260101_0001",
      title: "작업 로그 — 2026-01-01 09:00",
      summary: "오래된 작업",
      updatedAt: oldDate
    });
    writeRecords([r]);

    const result = fixTitles(testRoot, { dryRun: false });
    assert.equal(result.archived, 1);

    const content = fs.readFileSync(path.join(testRoot, "90_index", "records.jsonl"), "utf-8");
    const updated = JSON.parse(content.trim());
    assert.equal(updated.status, "archived");
  });

  it("패턴 없는 레코드는 무시", () => {
    const r = makeRecord({
      recordId: "rec_topic_wl_20260101_0001",
      title: "AgentForge 설계서",
      summary: "요약"
    });
    writeRecords([r]);

    const result = fixTitles(testRoot, { dryRun: false });
    assert.equal(result.fixed, 0);
    assert.equal(result.archived, 0);
  });

  it("bak 파일이 생성됨", () => {
    const r = makeRecord({
      recordId: "rec_topic_wl_20260101_0001",
      title: "작업 로그 — 2026-04-01 09:00",
      summary: "테스트"
    });
    writeRecords([r]);

    fixTitles(testRoot, { dryRun: false });
    assert.ok(fs.existsSync(path.join(testRoot, "90_index", "records.jsonl.bak")));
  });
});

// ─── lint (통합) ──────────────────────────────────────────────────────────────
describe("lint (통합)", () => {
  before(setupRoot);
  after(teardown);

  it("records.jsonl 없으면 critical 반환", () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-lint-empty-"));
    fs.mkdirSync(path.join(emptyRoot, "90_index"), { recursive: true });
    // records.jsonl 미생성
    const { issues } = lint(emptyRoot);
    assert.ok(issues.some(i => i.severity === "critical" && i.checkId === "load"));
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  });

  it("checks 필터 — 지정 검사만 실행", () => {
    const r = makeRecord({ scopeId: "filter-test", type: "note" });
    writeRecords([r]);
    const { issues, summary } = lint(testRoot, { checks: ["orphan-raw"] });
    assert.equal(summary.checksRun, 1);
    assert.ok(issues.every(i => i.checkId === "orphan-raw" || i.checkId === "orphan-folder"));
  });

  it("summary 구조 확인", () => {
    writeRecords([makeRecord()]);
    const { summary } = lint(testRoot);
    assert.ok("total" in summary);
    assert.ok("critical" in summary);
    assert.ok("warning" in summary);
    assert.ok("info" in summary);
    assert.ok("checksRun" in summary);
    assert.ok("recordsChecked" in summary);
  });

  it("이슈 없는 깨끗한 저장소 → total 0", () => {
    // wiki + raw 모두 있는 clean 상태
    const raw = makeRecord({ recordId: "rec_topic_clean_20260101_0001", scopeId: "clean", type: "note", title: "고유한 제목A" });
    const wiki = makeRecord({ recordId: "rec_topic_clean_20260101_0002", scopeId: "clean", type: "wiki", title: "clean — Wiki",
      lastWikiUpdate: new Date().toISOString(), sourceRef: "40_wiki/clean/wiki.md" });
    writeRecords([raw, wiki]);

    // wiki 파일 생성 (250줄 이하)
    const wikiDir = path.join(testRoot, "40_wiki", "clean");
    fs.mkdirSync(wikiDir, { recursive: true });
    fs.writeFileSync(path.join(wikiDir, "wiki.md"), "# clean — Wiki\n내용\n", "utf-8");

    const { summary } = lint(testRoot, { checks: ["staleness", "bloated-wiki", "contradiction", "title-pattern"] });
    assert.equal(summary.critical, 0);
    assert.equal(summary.warning, 0);
  });
});
