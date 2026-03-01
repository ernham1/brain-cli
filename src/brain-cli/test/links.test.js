"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  addLink, removeLink, getLinksFor, getLinkedBoosts,
  autoLink, readLinks, writeLinks, _tagOverlap, LINK_TYPES
} = require("../src/links");

// 픽스처 헬퍼
function createLinksBrain() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-links-"));
  const indexDir = path.join(tmpDir, "90_index");
  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(path.join(indexDir, "links.jsonl"), "", "utf-8");
  return tmpDir;
}

// --- 기본 CRUD ---

describe("links: addLink", () => {
  let brainRoot;

  before(() => { brainRoot = createLinksBrain(); });
  after(() => { fs.rmSync(brainRoot, { recursive: true, force: true }); });

  it("두 레코드 간 링크를 추가한다", () => {
    const result = addLink(brainRoot, "rec_a", "rec_b", "related");
    assert.equal(result.added, true);
    assert.equal(result.link.fromId, "rec_a");
    assert.equal(result.link.toId, "rec_b");
  });

  it("중복 링크는 추가하지 않는다", () => {
    const result = addLink(brainRoot, "rec_a", "rec_b", "related");
    assert.equal(result.added, false);
  });

  it("자기 참조는 추가하지 않는다", () => {
    const result = addLink(brainRoot, "rec_a", "rec_a", "related");
    assert.equal(result.added, false);
  });

  it("역방향 중복도 감지한다", () => {
    const result = addLink(brainRoot, "rec_b", "rec_a", "related");
    assert.equal(result.added, false);
  });

  it("다른 타입의 링크는 별도로 추가된다", () => {
    const result = addLink(brainRoot, "rec_a", "rec_c", "depends_on");
    assert.equal(result.added, true);
  });

  it("잘못된 linkType은 에러를 던진다", () => {
    assert.throws(() => addLink(brainRoot, "rec_x", "rec_y", "invalid_type"));
  });
});

describe("links: removeLink", () => {
  let brainRoot;

  before(() => {
    brainRoot = createLinksBrain();
    addLink(brainRoot, "rec_1", "rec_2", "related");
    addLink(brainRoot, "rec_1", "rec_3", "see_also");
  });
  after(() => { fs.rmSync(brainRoot, { recursive: true, force: true }); });

  it("존재하는 링크를 삭제한다", () => {
    const removed = removeLink(brainRoot, "rec_1", "rec_2");
    assert.equal(removed, true);
    const links = readLinks(brainRoot);
    assert.equal(links.length, 1);
  });

  it("존재하지 않는 링크 삭제는 false 반환", () => {
    const removed = removeLink(brainRoot, "rec_1", "rec_99");
    assert.equal(removed, false);
  });
});

describe("links: getLinksFor", () => {
  let brainRoot;

  before(() => {
    brainRoot = createLinksBrain();
    addLink(brainRoot, "rec_a", "rec_b", "related");
    addLink(brainRoot, "rec_a", "rec_c", "depends_on");
    addLink(brainRoot, "rec_d", "rec_a", "see_also");
  });
  after(() => { fs.rmSync(brainRoot, { recursive: true, force: true }); });

  it("outgoing + incoming 링크를 모두 반환한다", () => {
    const links = getLinksFor(brainRoot, "rec_a");
    assert.equal(links.length, 3);
    const outgoing = links.filter(l => l.direction === "outgoing");
    const incoming = links.filter(l => l.direction === "incoming");
    assert.equal(outgoing.length, 2);
    assert.equal(incoming.length, 1);
  });

  it("연결 없는 레코드는 빈 배열 반환", () => {
    const links = getLinksFor(brainRoot, "rec_nonexist");
    assert.equal(links.length, 0);
  });
});

// --- 검색 부스팅 ---

describe("links: getLinkedBoosts", () => {
  let brainRoot;

  before(() => {
    brainRoot = createLinksBrain();
    addLink(brainRoot, "rec_top1", "rec_linked1", "related");
    addLink(brainRoot, "rec_top2", "rec_linked1", "related");
    addLink(brainRoot, "rec_top1", "rec_linked2", "see_also");
  });
  after(() => { fs.rmSync(brainRoot, { recursive: true, force: true }); });

  it("상위 결과에 연결된 레코드의 부스트 카운트를 반환한다", () => {
    const boosts = getLinkedBoosts(brainRoot, ["rec_top1", "rec_top2"]);
    assert.equal(boosts.get("rec_linked1"), 2);  // 두 곳에서 연결
    assert.equal(boosts.get("rec_linked2"), 1);   // 한 곳에서 연결
  });

  it("이미 상위 결과에 있는 레코드는 부스트하지 않는다", () => {
    const boosts = getLinkedBoosts(brainRoot, ["rec_top1", "rec_top2"]);
    assert.equal(boosts.has("rec_top1"), false);
    assert.equal(boosts.has("rec_top2"), false);
  });
});

// --- 자동 링크 ---

describe("links: autoLink", () => {
  let brainRoot;

  before(() => { brainRoot = createLinksBrain(); });
  after(() => { fs.rmSync(brainRoot, { recursive: true, force: true }); });

  it("태그 유사도 ≥ 0.5인 레코드와 자동 링크한다", () => {
    const newRecord = {
      recordId: "rec_new1",
      title: "새 UI 가이드",
      tags: ["domain/ui", "intent/reference"],
      status: "active"
    };
    const existingDigest = [
      { recordId: "rec_old1", title: "기존 UI 규칙", tags: ["domain/ui", "intent/reference"], status: "active" },
      { recordId: "rec_old2", title: "서버 배포", tags: ["domain/infra", "intent/debug"], status: "active" }
    ];

    const count = autoLink(brainRoot, newRecord, existingDigest);
    assert.equal(count, 1);  // rec_old1만 매칭 (태그 100% 일치)

    const links = getLinksFor(brainRoot, "rec_new1");
    assert.equal(links.length, 1);
    assert.equal(links[0].linkedId, "rec_old1");
  });

  it("제목 토큰 겹침 ≥ 50%인 레코드와 자동 링크한다", () => {
    const newRecord = {
      recordId: "rec_title1",
      title: "로그인 버그 수정 기록",
      tags: ["domain/auth"],
      status: "active"
    };
    const existingDigest = [
      { recordId: "rec_title_match", title: "로그인 버그 원인 분석", tags: ["domain/devops"], status: "active" },
      { recordId: "rec_title_nomatch", title: "배포 파이프라인 설정", tags: ["domain/devops"], status: "active" }
    ];

    const count = autoLink(brainRoot, newRecord, existingDigest);
    assert.equal(count, 1);
    const links = getLinksFor(brainRoot, "rec_title1");
    assert.ok(links.some(l => l.linkedId === "rec_title_match"));
  });

  it("deprecated 레코드와는 자동 링크하지 않는다", () => {
    const newRecord = {
      recordId: "rec_nodep",
      title: "테스트 제목",
      tags: ["domain/ui", "intent/reference"],
      status: "active"
    };
    const existingDigest = [
      { recordId: "rec_dep1", title: "테스트 제목 동일", tags: ["domain/ui", "intent/reference"], status: "deprecated" }
    ];

    const count = autoLink(brainRoot, newRecord, existingDigest);
    assert.equal(count, 0);
  });
});

// --- 태그 유사도 ---

describe("links: _tagOverlap", () => {
  it("동일 태그 → 1.0", () => {
    assert.equal(_tagOverlap(["a", "b"], ["a", "b"]), 1.0);
  });

  it("절반 겹침 → ~0.33", () => {
    const result = _tagOverlap(["a", "b"], ["a", "c"]);
    assert.ok(Math.abs(result - 1 / 3) < 0.01);
  });

  it("빈 배열 → 0", () => {
    assert.equal(_tagOverlap([], ["a"]), 0);
    assert.equal(_tagOverlap(["a"], []), 0);
  });
});

// --- LINK_TYPES ---

describe("links: LINK_TYPES", () => {
  it("4개 타입이 정의되어 있다", () => {
    assert.equal(LINK_TYPES.length, 4);
    assert.ok(LINK_TYPES.includes("related"));
    assert.ok(LINK_TYPES.includes("replaced_by"));
    assert.ok(LINK_TYPES.includes("depends_on"));
    assert.ok(LINK_TYPES.includes("see_also"));
  });
});
