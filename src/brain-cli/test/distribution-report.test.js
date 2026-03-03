"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { generateDistributionReport } = require("../src/validate");

describe("generateDistributionReport", () => {
  const now = new Date().toISOString();
  const oldDate = "2025-01-01T00:00:00.000Z";

  const records = [
    { recordId: "r1", scopeType: "project", scopeId: "app-a", status: "active", updatedAt: now, title: "최근 기록" },
    { recordId: "r2", scopeType: "project", scopeId: "app-a", status: "active", updatedAt: now, title: "최근 기록 2" },
    { recordId: "r3", scopeType: "project", scopeId: "app-b", status: "active", updatedAt: now, title: "다른 앱" },
    { recordId: "r4", scopeType: "topic", scopeId: "reflections", status: "active", updatedAt: oldDate, title: "오래된 기록" },
    { recordId: "r5", scopeType: "project", scopeId: "app-a", status: "deprecated", updatedAt: oldDate, title: "폐기됨" },
  ];

  it("scopeType별 카운트를 계산한다", () => {
    const report = generateDistributionReport(records);
    assert.equal(report.byScopeType.project, 4);
    assert.equal(report.byScopeType.topic, 1);
  });

  it("scopeId별 카운트를 내림차순으로 정렬한다", () => {
    const report = generateDistributionReport(records);
    assert.equal(report.byScopeId[0].scopeId, "app-a");
    assert.equal(report.byScopeId[0].count, 3);
    assert.equal(report.byScopeId[1].scopeId, "app-b");
    assert.equal(report.byScopeId[1].count, 1);
  });

  it("30일 이상 미갱신 active 레코드를 감지한다", () => {
    const report = generateDistributionReport(records);
    assert.equal(report.staleRecords.length, 1);
    assert.equal(report.staleRecords[0].recordId, "r4");
  });

  it("deprecated 레코드는 stale에 포함하지 않는다", () => {
    const report = generateDistributionReport(records);
    assert.ok(!report.staleRecords.some(r => r.recordId === "r5"));
  });

  it("빈 레코드 배열도 처리한다", () => {
    const report = generateDistributionReport([]);
    assert.deepEqual(report.byScopeType, {});
    assert.deepEqual(report.byScopeId, []);
    assert.deepEqual(report.staleRecords, []);
  });
});
