"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { search, createSessionContext } = require("../src/search");
const { _resetSynonymCache } = require("../src/utils");

// --- 픽스처 생성 헬퍼 ---

function createIntegrationBrain() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-int-"));
  const indexDir = path.join(tmpDir, "90_index");
  fs.mkdirSync(indexDir, { recursive: true });

  // tags.json (동의어 포함)
  fs.writeFileSync(path.join(indexDir, "tags.json"), JSON.stringify({
    domain: { synonyms: { frontend: "ui" } },
    intent: { synonyms: { search: "retrieval" } },
    general_synonyms: {
      "프론트엔드": ["ui", "frontend", "화면"],
      "버그": ["오류", "에러", "error", "bug"]
    }
  }));

  // records_digest.txt (8컬럼)
  const now = new Date();
  const d7 = new Date(now - 7 * 86400000).toISOString();
  const d30 = new Date(now - 30 * 86400000).toISOString();

  const digestLines = [
    "# Format: recordId | title | summary | tags | status | type | sourceType | updatedAt",
    `rec_topic_ui1 | UI 컴포넌트 가이드 | 화면 구성 요소 설명 | domain/ui | active | note | candidate | ${d7}`,
    `rec_topic_recent7d | 테스트 기억 최신 | 7일 전 기억 | domain/memory | active | note | candidate | ${d7}`,
    `rec_topic_older30d | 테스트 기억 오래됨 | 30일 전 기억 | domain/memory | active | note | candidate | ${d30}`,
    `rec_topic_confirmed | 신뢰도 테스트 확인됨 | 사용자 확인 기억 | domain/memory | active | note | user_confirmed | ${d7}`,
    `rec_topic_candidate | 신뢰도 테스트 후보 | AI 저장 기억 | domain/memory | active | note | candidate | ${d7}`,
    `rec_topic_dedup_target | 중복 테스트 대상 | 중복 패널티 확인용 | domain/memory | active | note | candidate | ${d7}`,
    `rec_topic_dedup_fresh | 중복 테스트 신규 | 신규 레코드 | domain/memory | active | note | candidate | ${d7}`,
    `rec_topic_formula | 통합 공식 검증 레코드 | 4요소 반영 확인 | domain/memory | active | note | candidate | ${d7}`,
    `rec_topic_decision1 | 타입 필터 결정사항 | 의사결정 레코드 | domain/memory | active | decision | candidate | ${d7}`,
    `rec_topic_note1 | 타입 필터 노트 | 일반 노트 | domain/memory | active | note | candidate | ${d7}`
  ].join("\n");

  fs.writeFileSync(path.join(indexDir, "records_digest.txt"), digestLines);

  // records.jsonl (빈 파일)
  fs.writeFileSync(path.join(indexDir, "records.jsonl"), "", "utf-8");

  return tmpDir;
}

function createLegacyBrain() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-legacy-"));
  const indexDir = path.join(tmpDir, "90_index");
  fs.mkdirSync(indexDir, { recursive: true });

  // 5컬럼 레거시 포맷
  const digestLines = [
    "# Format: recordId | title | summary | tags | status",
    "rec_topic_legacy1 | 레거시 테스트 기억 | 이전 포맷 기억 | domain/memory | active"
  ].join("\n");

  fs.writeFileSync(path.join(indexDir, "records_digest.txt"), digestLines);
  fs.writeFileSync(path.join(indexDir, "records.jsonl"), "", "utf-8");

  return tmpDir;
}

// --- 통합 검색 테스트 (REQ-094) ---

describe("REQ-094: 통합 검색 테스트", () => {
  let brainRoot;

  before(() => {
    _resetSynonymCache();
    brainRoot = createIntegrationBrain();
  });

  after(() => {
    fs.rmSync(brainRoot, { recursive: true, force: true });
  });

  // --- 테스트 1: 동의어 매칭 ---
  it("동의어 매칭 — '프론트엔드' 검색 시 'ui' 태그 레코드도 반환", () => {
    const result = search(brainRoot, {
      scopeType: "topic",
      currentGoal: "프론트엔드",
      topK: 10
    });
    assert.ok(
      result.candidates.some(c => c.tags.includes("domain/ui")),
      "'domain/ui' 태그 레코드가 동의어 확장으로 매칭됨"
    );
  });

  // --- 테스트 2: 최신성 우선 ---
  it("최신성 우선 — 7일 기억이 30일 기억보다 상위 랭크", () => {
    const result = search(brainRoot, {
      scopeType: "topic",
      currentGoal: "테스트 기억",
      topK: 10
    });
    const recent = result.candidates.findIndex(
      c => c.recordId === "rec_topic_recent7d"
    );
    const older = result.candidates.findIndex(
      c => c.recordId === "rec_topic_older30d"
    );
    assert.ok(recent >= 0 && older >= 0, "두 레코드 모두 결과에 포함");
    assert.ok(recent < older,
      `7일 기억(idx=${recent})이 30일 기억(idx=${older})보다 상위`);
  });

  // --- 테스트 3: 신뢰도 우선 ---
  it("신뢰도 우선 — user_confirmed가 candidate보다 상위 랭크", () => {
    const result = search(brainRoot, {
      scopeType: "topic",
      currentGoal: "신뢰도 테스트",
      topK: 10
    });
    const confirmed = result.candidates.findIndex(
      c => c.recordId === "rec_topic_confirmed"
    );
    const candidate = result.candidates.findIndex(
      c => c.recordId === "rec_topic_candidate"
    );
    assert.ok(confirmed >= 0 && candidate >= 0, "두 레코드 모두 결과에 포함");
    assert.ok(confirmed < candidate,
      `user_confirmed(idx=${confirmed})가 candidate(idx=${candidate})보다 상위`);
  });

  // --- 테스트 4: 중복 패널티 ---
  it("중복 패널티 — 동일 기억 재검색 시 점수 감산", () => {
    const ctx = createSessionContext();
    ctx.exposedIds.add("rec_topic_dedup_target");

    const result = search(brainRoot, {
      scopeType: "topic",
      currentGoal: "중복 테스트",
      topK: 10
    }, ctx);

    const target = result.candidates.find(
      c => c.recordId === "rec_topic_dedup_target"
    );
    const fresh = result.candidates.find(
      c => c.recordId === "rec_topic_dedup_fresh"
    );
    assert.ok(target && fresh, "두 레코드 모두 결과에 포함");
    assert.ok(target.score < fresh.score,
      `재노출(${target.score}) < 신규(${fresh.score})`);
  });

  // --- 테스트 5: 통합 공식 4요소 반영 ---
  it("통합 공식 — finalScore = relevance x time x trust x dedup 모두 반영", () => {
    const result = search(brainRoot, {
      scopeType: "topic",
      currentGoal: "통합 공식 검증",
      topK: 10
    });
    assert.ok(result.candidates.length > 0, "결과 존재");
    const topCandidate = result.candidates[0];
    assert.ok(typeof topCandidate.score === "number", "score는 숫자");
    assert.ok(topCandidate.score > 0, "score > 0");
  });

  // --- 테스트 6: 하위 호환 (5컬럼 레거시 digest) ---
  it("하위 호환 — 5컬럼 레거시 digest도 정상 파싱 + 기본값 적용", () => {
    _resetSynonymCache();
    const legacyRoot = createLegacyBrain();

    const result = search(legacyRoot, {
      scopeType: "topic",
      currentGoal: "레거시 테스트",
      topK: 10
    });
    assert.ok(result.candidates.length > 0, "레거시 digest에서도 결과 반환");

    const first = result.candidates[0];
    assert.equal(first.sourceType, "candidate", "레거시 기본 sourceType");
    assert.equal(first.type, null, "레거시 기본 type=null");
    assert.equal(first.updatedAt, null, "레거시 기본 updatedAt=null");

    fs.rmSync(legacyRoot, { recursive: true, force: true });
    _resetSynonymCache();
  });

  // --- 테스트 7: 타입 필터 ---
  it("타입 필터 — type='decision'이면 decision 레코드만 반환", () => {
    const result = search(brainRoot, {
      scopeType: "topic",
      type: "decision",
      topK: 10
    });
    for (const c of result.candidates) {
      assert.equal(c.type, "decision",
        `recordId=${c.recordId}의 type이 'decision'이어야 함`);
    }
    assert.ok(result.candidates.length > 0, "decision 결과 1건 이상");
  });
});
