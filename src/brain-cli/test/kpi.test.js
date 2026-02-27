"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  calculateK1,
  calculateK2,
  calculateK3,
  calculateK4,
  formatKPIMarkdown,
  appendKPILog
} = require("../src/kpi");

let testRoot;

before(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-kpi-test-"));
  fs.mkdirSync(path.join(testRoot, "90_index"), { recursive: true });
  fs.mkdirSync(path.join(testRoot, "10_projects", "myApp", "logs"), { recursive: true });
});

after(() => {
  if (testRoot && fs.existsSync(testRoot)) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("calculateK1: 회수 성공률", () => {
  it("4/5 = 80% → pass", () => {
    const r = calculateK1(4, 5);
    assert.equal(r.pass, true);
    assert.ok(r.display.includes("80%"));
  });

  it("3/5 = 60% → fail", () => {
    const r = calculateK1(3, 5);
    assert.equal(r.pass, false);
    assert.ok(r.display.includes("60%"));
  });

  it("0/0 = N/A → pass", () => {
    const r = calculateK1(0, 0);
    assert.equal(r.pass, true);
    assert.ok(r.display.includes("N/A"));
  });
});

describe("calculateK2: 오탐 로드율", () => {
  it("1/4 = 25% → pass (≤30%)", () => {
    const r = calculateK2(4, 3); // unused=1, total=4
    assert.equal(r.pass, true);
    assert.ok(r.display.includes("25%"));
  });

  it("3/5 = 60% → fail (>30%)", () => {
    const r = calculateK2(5, 2); // unused=3, total=5
    assert.equal(r.pass, false);
    assert.ok(r.display.includes("60%"));
  });

  it("0/0 = N/A → pass", () => {
    const r = calculateK2(0, 0);
    assert.equal(r.pass, true);
  });
});

describe("calculateK3: 탐색 턴 수", () => {
  it("2턴 → pass (≤3)", () => {
    const r = calculateK3(2);
    assert.equal(r.pass, true);
    assert.equal(r.display, "2턴");
  });

  it("5턴 → fail (>3)", () => {
    const r = calculateK3(5);
    assert.equal(r.pass, false);
    assert.equal(r.display, "5턴");
  });
});

describe("calculateK4: 오염 감지", () => {
  it("0건 → pass", () => {
    const r = calculateK4(0);
    assert.equal(r.pass, true);
    assert.equal(r.display, "0건");
  });

  it("1건 → fail", () => {
    const r = calculateK4(1);
    assert.equal(r.pass, false);
    assert.equal(r.display, "1건");
  });
});

describe("formatKPIMarkdown", () => {
  it("올바른 마크다운 테이블을 생성해야 한다", () => {
    const kpis = {
      k1: calculateK1(4, 5),
      k2: calculateK2(4, 3),
      k3: calculateK3(2),
      k4: calculateK4(0)
    };
    const md = formatKPIMarkdown(kpis, "2026-02-26");
    assert.ok(md.includes("### KPI — 2026-02-26"));
    assert.ok(md.includes("K1 회수성공"));
    assert.ok(md.includes("4/5 (80%)"));
    assert.ok(md.includes("2턴"));
    assert.ok(md.includes("0건"));
  });
});

describe("appendKPILog", () => {
  it("프로젝트 로그 파일에 KPI를 append해야 한다", () => {
    const kpis = {
      k1: calculateK1(4, 5),
      k2: calculateK2(4, 3),
      k3: calculateK3(2),
      k4: calculateK4(0)
    };
    const logFile = appendKPILog(testRoot, "project", "myApp", kpis);
    assert.ok(fs.existsSync(logFile));

    const content = fs.readFileSync(logFile, "utf-8");
    assert.ok(content.includes("# KPI Log"));
    assert.ok(content.includes("K1 회수성공"));

    // 두 번 append하면 내용이 누적되어야 한다
    appendKPILog(testRoot, "project", "myApp", kpis);
    const content2 = fs.readFileSync(logFile, "utf-8");
    const count = (content2.match(/### KPI/g) || []).length;
    assert.equal(count, 2);
  });

  it("인덱스 로그 파일에도 기록 가능해야 한다", () => {
    const kpis = {
      k1: calculateK1(5, 5),
      k2: calculateK2(3, 3),
      k3: calculateK3(1),
      k4: calculateK4(0)
    };
    const logFile = appendKPILog(testRoot, "user", "test", kpis);
    assert.ok(fs.existsSync(logFile));
  });
});
