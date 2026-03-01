"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { loadSynonyms, _resetSynonymCache } = require("../src/utils");
const { _expandTokens } = require("../src/search");

// --- 테스트용 Brain 환경 생성 헬퍼 ---

function createTempBrain(tagsData) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-syn-"));
  const brainRoot = tmpDir;
  const indexDir = path.join(brainRoot, "90_index");
  fs.mkdirSync(indexDir, { recursive: true });
  if (tagsData) {
    fs.writeFileSync(path.join(indexDir, "tags.json"), JSON.stringify(tagsData, null, 2), "utf-8");
  }
  return brainRoot;
}

function cleanup(brainRoot) {
  fs.rmSync(brainRoot, { recursive: true, force: true });
}

// =======================================================================
// REQ-030: tags.json 동의어 맵 로딩 (3소스)
// =======================================================================

describe("REQ-030: loadSynonyms — 3소스 로딩", () => {
  beforeEach(() => _resetSynonymCache());

  it("domain.synonyms를 로딩한다", () => {
    const root = createTempBrain({
      domain: { synonyms: { frontend: "ui" } }
    });
    const map = loadSynonyms(root);
    assert.ok(map.get("frontend").includes("ui"));
    assert.ok(map.get("ui").includes("frontend"));
    cleanup(root);
  });

  it("intent.synonyms를 로딩한다", () => {
    const root = createTempBrain({
      intent: { synonyms: { search: "retrieval" } }
    });
    const map = loadSynonyms(root);
    assert.ok(map.get("search").includes("retrieval"));
    assert.ok(map.get("retrieval").includes("search"));
    cleanup(root);
  });

  it("general_synonyms 그룹을 로딩한다", () => {
    const root = createTempBrain({
      general_synonyms: { "버그": ["오류", "error", "bug"] }
    });
    const map = loadSynonyms(root);
    assert.ok(map.get("버그").includes("오류"));
    assert.ok(map.get("버그").includes("error"));
    assert.ok(map.get("오류").includes("버그"));
    assert.ok(map.get("error").includes("bug"));
    cleanup(root);
  });

  it("3개 소스 모두 있는 경우 통합 로딩된다", () => {
    const root = createTempBrain({
      domain: { synonyms: { frontend: "ui" } },
      intent: { synonyms: { search: "retrieval" } },
      general_synonyms: { "버그": ["error"] }
    });
    const map = loadSynonyms(root);
    assert.ok(map.has("frontend"));
    assert.ok(map.has("search"));
    assert.ok(map.has("버그"));
    cleanup(root);
  });
});

// =======================================================================
// REQ-031: 양방향 동의어 맵 구축
// =======================================================================

describe("REQ-031: 양방향 맵 구축", () => {
  beforeEach(() => _resetSynonymCache());

  it("양방향으로 조회 가능하다", () => {
    const root = createTempBrain({
      domain: { synonyms: { frontend: "ui", backend: "infra" } }
    });
    const map = loadSynonyms(root);
    assert.ok(map.get("frontend").includes("ui"));
    assert.ok(map.get("ui").includes("frontend"));
    assert.ok(map.get("backend").includes("infra"));
    assert.ok(map.get("infra").includes("backend"));
    cleanup(root);
  });

  it("general_synonyms 그룹 내 모든 멤버가 서로 동의어이다", () => {
    const root = createTempBrain({
      general_synonyms: { "버그": ["오류", "error"] }
    });
    const map = loadSynonyms(root);
    // 버그 -> 오류, error
    assert.ok(map.get("버그").includes("오류"));
    assert.ok(map.get("버그").includes("error"));
    // 오류 -> 버그, error
    assert.ok(map.get("오류").includes("버그"));
    assert.ok(map.get("오류").includes("error"));
    // error -> 버그, 오류
    assert.ok(map.get("error").includes("버그"));
    assert.ok(map.get("error").includes("오류"));
    cleanup(root);
  });

  it("자기 자신은 동의어 목록에 포함되지 않는다", () => {
    const root = createTempBrain({
      general_synonyms: { "a": ["a", "b"] }
    });
    const map = loadSynonyms(root);
    // a -> b 만 있어야 하고, a -> a 는 없어야 함
    const aList = map.get("a") || [];
    assert.ok(!aList.includes("a"));
    assert.ok(aList.includes("b"));
    cleanup(root);
  });

  it("중복 없이 등록된다", () => {
    const root = createTempBrain({
      domain: { synonyms: { frontend: "ui" } },
      general_synonyms: { "프론트엔드": ["ui", "frontend"] }
    });
    const map = loadSynonyms(root);
    const uiList = map.get("ui");
    // "frontend"가 중복 없이 1번만 등록되어야 함
    assert.equal(uiList.filter(x => x === "frontend").length, 1);
    cleanup(root);
  });
});

// =======================================================================
// REQ-032: 모듈 레벨 캐시
// =======================================================================

describe("REQ-032: 캐시 동작", () => {
  beforeEach(() => _resetSynonymCache());

  it("2회 호출 시 동일 객체를 반환한다 (캐시 히트)", () => {
    const root = createTempBrain({
      domain: { synonyms: { frontend: "ui" } }
    });
    const map1 = loadSynonyms(root);
    const map2 = loadSynonyms(root);
    assert.strictEqual(map1, map2); // 동일 참조
    cleanup(root);
  });

  it("_resetSynonymCache 후 재호출 시 새 맵을 반환한다", () => {
    const root = createTempBrain({
      domain: { synonyms: { frontend: "ui" } }
    });
    const map1 = loadSynonyms(root);
    _resetSynonymCache();
    const map2 = loadSynonyms(root);
    assert.notStrictEqual(map1, map2); // 다른 참조
    assert.deepStrictEqual([...map1.entries()], [...map2.entries()]);
    cleanup(root);
  });
});

// =======================================================================
// REQ-033: goalTokens 동의어 확장 (가중치 0.7)
// =======================================================================

describe("REQ-033: _expandTokens 동의어 확장", () => {
  it("원본 토큰은 weight 1.0, source 'original'이다", () => {
    const synonymMap = new Map();
    const result = _expandTokens(["hello"], synonymMap);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, "hello");
    assert.equal(result[0].weight, 1.0);
    assert.equal(result[0].source, "original");
  });

  it("동의어 토큰은 weight 0.7, source 'synonym'이다", () => {
    const synonymMap = new Map([["frontend", ["ui", "화면"]]]);
    const result = _expandTokens(["frontend"], synonymMap);
    assert.equal(result.length, 3);
    assert.equal(result[0].weight, 1.0);
    assert.equal(result[1].text, "ui");
    assert.equal(result[1].weight, 0.7);
    assert.equal(result[1].source, "synonym");
    assert.equal(result[2].text, "화면");
    assert.equal(result[2].weight, 0.7);
  });

  it("동의어가 없는 토큰은 원본만 반환된다", () => {
    const synonymMap = new Map([["frontend", ["ui"]]]);
    const result = _expandTokens(["unknown"], synonymMap);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, "unknown");
  });

  it("대소문자 무관하게 동의어가 매칭된다", () => {
    const synonymMap = new Map([["frontend", ["ui"]]]);
    const result = _expandTokens(["Frontend"], synonymMap);
    // "Frontend".toLowerCase() === "frontend" → 매칭
    assert.equal(result.length, 2);
    assert.equal(result[1].text, "ui");
  });

  it("여러 토큰을 동시에 확장한다", () => {
    const synonymMap = new Map([
      ["frontend", ["ui"]],
      ["버그", ["error", "bug"]]
    ]);
    const result = _expandTokens(["frontend", "버그"], synonymMap);
    assert.equal(result.length, 5); // 1+1 + 1+2
    assert.equal(result[0].text, "frontend");
    assert.equal(result[1].text, "ui");
    assert.equal(result[2].text, "버그");
    assert.equal(result[3].text, "error");
    assert.equal(result[4].text, "bug");
  });
});

// =======================================================================
// REQ-034: tags.json 미존재 시 Graceful Fallback
// =======================================================================

describe("REQ-034: fallback 동작", () => {
  beforeEach(() => _resetSynonymCache());

  it("tags.json 미존재 시 빈 Map을 반환한다", () => {
    const root = createTempBrain(null); // tags.json 미생성
    const map = loadSynonyms(root);
    assert.ok(map instanceof Map);
    assert.equal(map.size, 0);
    cleanup(root);
  });

  it("빈 맵으로 _expandTokens 호출 시 원본만 반환된다", () => {
    const emptyMap = new Map();
    const result = _expandTokens(["frontend", "버그"], emptyMap);
    assert.equal(result.length, 2);
    assert.ok(result.every(r => r.source === "original"));
  });

  it("synonyms 키가 없어도 에러 없이 동작한다", () => {
    const root = createTempBrain({ version: "1.0" }); // synonyms 없음
    const map = loadSynonyms(root);
    assert.ok(map instanceof Map);
    assert.equal(map.size, 0);
    cleanup(root);
  });
});

// =======================================================================
// REQ-035: general_synonyms 32그룹 확인 (실제 tags.json)
// =======================================================================

describe("REQ-035: general_synonyms 그룹 수", () => {
  beforeEach(() => _resetSynonymCache());

  it("실제 Brain tags.json에 general_synonyms가 30개 이상이다", () => {
    // 실제 Brain 경로 사용
    const brainRoot = path.resolve(__dirname, "../../../Brain");
    const tagsPath = path.join(brainRoot, "90_index", "tags.json");
    if (!fs.existsSync(tagsPath)) {
      // CI 환경 등에서 Brain 폴더 없으면 스킵
      return;
    }
    const tags = JSON.parse(fs.readFileSync(tagsPath, "utf-8"));
    const groupCount = Object.keys(tags.general_synonyms || {}).length;
    assert.ok(groupCount >= 30, `그룹 수 ${groupCount}개 — 30개 이상 필요`);
  });
});

// =======================================================================
// REQ-036: 2-depth 확장 금지
// =======================================================================

describe("REQ-036: 2-depth 확장 금지", () => {
  it("동의어의 동의어는 확장되지 않는다", () => {
    // "프론트엔드" -> ["ui", "화면"]
    // "ui" -> ["프론트엔드", "화면"] ← 이것이 2-depth 확장 안 됨을 확인
    const synonymMap = new Map([
      ["프론트엔드", ["ui", "화면"]],
      ["ui", ["프론트엔드", "화면"]]
    ]);

    const result = _expandTokens(["프론트엔드"], synonymMap);
    // 원본 1 + 동의어 2 = 3개만 있어야 함
    assert.equal(result.length, 3);
    // "ui"의 동의어("화면", "프론트엔드")가 추가로 확장되지 않아야 함
    const synTokens = result.filter(r => r.source === "synonym");
    assert.equal(synTokens.length, 2);
  });

  it("expanded 배열 크기가 원본 + 직접 동의어 수를 초과하지 않는다", () => {
    const synonymMap = new Map([
      ["a", ["b", "c"]],
      ["b", ["a", "c", "d"]],
      ["c", ["a", "b"]],
      ["d", ["b"]]
    ]);

    const result = _expandTokens(["a"], synonymMap);
    // "a" 원본 1개 + "a"의 직접 동의어 2개 ("b", "c") = 3개
    assert.equal(result.length, 3);
    // "b"의 동의어 "d"가 포함되지 않아야 함
    assert.ok(!result.some(r => r.text === "d"));
  });
});
