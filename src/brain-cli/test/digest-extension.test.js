"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { _loadDigest } = require("../src/search");

// --- 헬퍼 ---

function writeTempDigest(content) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-digest-"));
  fs.writeFileSync(path.join(tmpDir, "records_digest.txt"), content, "utf-8");
  return tmpDir;
}

// --- Digest 확장 호환성 테스트 (REQ-095) ---

describe("REQ-095: Digest 확장 호환성", () => {

  // --- 테스트 1: 8컬럼 정상 파싱 ---
  it("8컬럼 포맷 — type/sourceType/updatedAt 정상 파싱", () => {
    const digestContent = [
      "# Format: recordId | title | summary | tags | status | type | sourceType | updatedAt",
      "rec_topic_test1 | 제목 | 요약 | domain/ui | active | note | user_confirmed | 2026-03-01T09:00:00"
    ].join("\n");

    const tmpDir = writeTempDigest(digestContent);
    const digestPath = path.join(tmpDir, "records_digest.txt");
    const result = _loadDigest(digestPath);

    assert.equal(result.length, 1);
    assert.equal(result[0].recordId, "rec_topic_test1");
    assert.equal(result[0].title, "제목");
    assert.equal(result[0].type, "note");
    assert.equal(result[0].sourceType, "user_confirmed");
    assert.equal(result[0].updatedAt, "2026-03-01T09:00:00");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- 테스트 2: 5컬럼 레거시 기본값 ---
  it("5컬럼 레거시 포맷 — 기본값 적용 (type=null, sourceType='candidate', updatedAt=null)", () => {
    const digestContent = [
      "# Format: recordId | title | summary | tags | status",
      "rec_topic_legacy | 레거시 제목 | 레거시 요약 | domain/memory | active"
    ].join("\n");

    const tmpDir = writeTempDigest(digestContent);
    const digestPath = path.join(tmpDir, "records_digest.txt");
    const result = _loadDigest(digestPath);

    assert.equal(result.length, 1);
    assert.equal(result[0].recordId, "rec_topic_legacy");
    assert.equal(result[0].title, "레거시 제목");
    assert.equal(result[0].type, null, "5컬럼 → type=null");
    assert.equal(result[0].sourceType, "candidate", "5컬럼 → sourceType='candidate'");
    assert.equal(result[0].updatedAt, null, "5컬럼 → updatedAt=null");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- 테스트 3: 혼합 포맷 ---
  it("5컬럼/8컬럼 혼합 — 모두 정상 파싱", () => {
    const digestContent = [
      "# Format: recordId | title | summary | tags | status | type | sourceType | updatedAt",
      "rec_topic_new | 신규 | 요약 | domain/ui | active | decision | user_confirmed | 2026-03-01T09:00:00",
      "rec_topic_old | 구형 | 요약 | domain/memory | active"
    ].join("\n");

    const tmpDir = writeTempDigest(digestContent);
    const digestPath = path.join(tmpDir, "records_digest.txt");
    const result = _loadDigest(digestPath);

    assert.equal(result.length, 2);
    // 8컬럼 레코드
    assert.equal(result[0].type, "decision");
    assert.equal(result[0].sourceType, "user_confirmed");
    assert.equal(result[0].updatedAt, "2026-03-01T09:00:00");
    // 5컬럼 레코드
    assert.equal(result[1].type, null);
    assert.equal(result[1].sourceType, "candidate");
    assert.equal(result[1].updatedAt, null);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- 테스트 4: 빈 확장 필드 ---
  it("8컬럼이지만 확장 필드가 빈 문자열 — null/기본값 처리", () => {
    const digestContent = [
      "# Format: recordId | title | summary | tags | status | type | sourceType | updatedAt",
      "rec_topic_empty | 제목 | 요약 | domain/ui | active |  |  | "
    ].join("\n");

    const tmpDir = writeTempDigest(digestContent);
    const digestPath = path.join(tmpDir, "records_digest.txt");
    const result = _loadDigest(digestPath);

    assert.equal(result.length, 1);
    assert.equal(result[0].type, null, "빈 문자열 → null");
    assert.equal(result[0].sourceType, "candidate", "빈 문자열 → 'candidate' 기본값");
    assert.equal(result[0].updatedAt, null, "빈 문자열 → null");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
