"use strict";

const fs = require("fs");
const path = require("path");
const { ensureDir } = require("./utils");

/**
 * Brain Quality KPI 산출
 *
 * K1 — 회수 성공률: 1회 검색에서 필요 기억이 top-k에 포함된 비율 (목표 ≥80%)
 * K2 — 오탐 로드율: (refs수 - usedRefs수) / refs수 (목표 ≤30%)
 * K3 — 탐색 턴 수: 스코프 선언 → Packet 완성 턴 수 (목표 ≤3턴)
 * K4 — 오염 감지: 오염 감지 발동 횟수 (목표 0건)
 */

/**
 * K1 산출: 회수 성공률
 * @param {number} found - top-k에 포함된 필요 기억 수
 * @param {number} needed - 실제 필요했던 기억 수
 * @returns {{ value: number, display: string, target: string, pass: boolean }}
 */
function calculateK1(found, needed) {
  if (needed === 0) {
    return { value: 1, display: "0/0 (N/A)", target: "≥80%", pass: true };
  }
  const value = found / needed;
  const pct = Math.round(value * 100);
  return {
    value,
    display: `${found}/${needed} (${pct}%)`,
    target: "≥80%",
    pass: pct >= 80
  };
}

/**
 * K2 산출: 오탐 로드율
 * @param {number} totalRefs - Memory Packet에 포함된 refs 수
 * @param {number} usedRefs - 실제 사용된 refs 수
 * @returns {{ value: number, display: string, target: string, pass: boolean }}
 */
function calculateK2(totalRefs, usedRefs) {
  if (totalRefs === 0) {
    return { value: 0, display: "0/0 (N/A)", target: "≤30%", pass: true };
  }
  const unused = totalRefs - usedRefs;
  const value = unused / totalRefs;
  const pct = Math.round(value * 100);
  return {
    value,
    display: `${unused}/${totalRefs} (${pct}%)`,
    target: "≤30%",
    pass: pct <= 30
  };
}

/**
 * K3 산출: 탐색 턴 수
 * @param {number} turns - 스코프 선언부터 Packet 완성까지의 턴 수
 * @returns {{ value: number, display: string, target: string, pass: boolean }}
 */
function calculateK3(turns) {
  return {
    value: turns,
    display: `${turns}턴`,
    target: "≤3턴",
    pass: turns <= 3
  };
}

/**
 * K4 산출: 오염 감지 횟수
 * @param {number} count - 오염 감지 발동 횟수
 * @returns {{ value: number, display: string, target: string, pass: boolean }}
 */
function calculateK4(count) {
  return {
    value: count,
    display: `${count}건`,
    target: "0건",
    pass: count === 0
  };
}

/**
 * KPI 마크다운 테이블 생성
 * @param {Object} kpis - { k1, k2, k3, k4 } 각각의 산출 결과
 * @param {string} date - YYYY-MM-DD 형식
 * @returns {string} 마크다운 문자열
 */
function formatKPIMarkdown(kpis, date) {
  const lines = [
    `### KPI — ${date}`,
    `| K1 회수성공 | K2 오탐로드 | K3 탐색턴 | K4 오염 |`,
    `|---|---|---|---|`,
    `| ${kpis.k1.display} | ${kpis.k2.display} | ${kpis.k3.display} | ${kpis.k4.display} |`,
    ``
  ];
  return lines.join("\n");
}

/**
 * KPI를 로그 파일에 append
 * @param {string} brainRoot - Brain/ 절대 경로
 * @param {string} scopeType - 스코프 타입
 * @param {string} scopeId - 스코프 ID
 * @param {Object} kpis - { k1, k2, k3, k4 }
 */
function appendKPILog(brainRoot, scopeType, scopeId, kpis) {
  const date = new Date().toISOString().slice(0, 10);
  const yearMonth = date.slice(0, 7); // YYYY-MM

  // 로그 디렉토리 결정
  let logDir;
  if (scopeType === "project") {
    logDir = path.join(brainRoot, "10_projects", scopeId, "logs");
  } else {
    logDir = path.join(brainRoot, "90_index");
  }
  ensureDir(logDir);

  const logFile = path.join(logDir, `${yearMonth}.md`);
  const markdown = formatKPIMarkdown(kpis, date);

  // 파일 없으면 헤더 추가
  let content = "";
  if (fs.existsSync(logFile)) {
    content = fs.readFileSync(logFile, "utf-8");
  } else {
    content = `# KPI Log — ${yearMonth}\n\n`;
  }

  content += markdown + "\n";
  fs.writeFileSync(logFile, content, "utf-8");

  return logFile;
}

module.exports = {
  calculateK1,
  calculateK2,
  calculateK3,
  calculateK4,
  formatKPIMarkdown,
  appendKPILog
};
