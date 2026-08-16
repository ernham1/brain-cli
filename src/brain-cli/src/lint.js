"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Brain 저장소 품질 검사 — 7가지 규칙
 *
 * LintIssue: { severity, checkId, recordId?, path?, message }
 * severity: "critical" | "warning" | "info"
 */

// ─── Levenshtein (외부 라이브러리 없이) ──────────────────────────────────────
function levenshtein(a, b) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 3) return 99; // early exit — 불필요한 연산 방지
  let prev = Array.from({ length: lb + 1 }, (_, i) => i);
  let curr = new Array(lb + 1);
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[lb];
}

// ─── Check 1: 중복 레코드 ─────────────────────────────────────────────────────
/**
 * 같은 scopeId 내 active 레코드 중 title 편집거리 ≤ 3인 쌍 → warning
 */
// 날짜/시간 패턴 제거 (비교 전 정규화)
function normalizeTitleForDup(title) {
  return title
    .replace(/\d{4}-\d{2}-\d{2}[\sT]?\d{2}:\d{2}(:\d{2})?/g, "")
    .replace(/\d{4}-\d{2}-\d{2}/g, "")
    .replace(/\[?\d{2}:\d{2}\]?/g, "")
    .trim();
}

function checkDuplicates(records) {
  const issues = [];
  const activeRecords = records.filter(r => r.status === "active");

  // scopeId별 그룹핑
  const groups = {};
  for (const r of activeRecords) {
    if (!groups[r.scopeId]) groups[r.scopeId] = [];
    groups[r.scopeId].push(r);
  }

  for (const [scopeId, recs] of Object.entries(groups)) {
    // 순차적 이력 성격의 scopeId는 중복 검사 제외
    if (scopeId === "sessions" || scopeId === "work-log") continue;

    for (let i = 0; i < recs.length; i++) {
      for (let j = i + 1; j < recs.length; j++) {
        const titleA = recs[i].title || "";
        const titleB = recs[j].title || "";

        // 날짜 정규화 후 동일하면 날짜만 다른 패턴 → 스킵
        const normA = normalizeTitleForDup(titleA);
        const normB = normalizeTitleForDup(titleB);
        if (normA === normB) continue;

        // 편집거리 / 제목길이 ≤ 0.1 기준 (최소 편집거리 2 이상)
        const maxLen = Math.max(titleA.length, titleB.length);
        const dist = levenshtein(normA, normB);
        const threshold = Math.max(2, Math.floor(maxLen * 0.1));
        if (dist >= 2 && dist <= threshold) {
          issues.push({
            severity: "warning",
            checkId: "duplicate",
            recordId: recs[i].recordId,
            message: `중복 의심: "${titleA}" ↔ "${titleB}" (거리 ${dist}, scopeId: ${scopeId}, ${recs[j].recordId})`
          });
        }
      }
    }
  }
  return issues;
}

// ─── Check 2: wiki 갱신 지연 ──────────────────────────────────────────────────
/**
 * wiki 레코드의 lastWikiUpdate 이후 30일+ 경과 + 새 raw 레코드 존재 → warning
 */
function checkStaleness(records) {
  const issues = [];
  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  const wikiByScope = {};
  const rawByScopeLatest = {};

  for (const r of records) {
    if (r.status !== "active") continue;
    if (r.type === "wiki") {
      wikiByScope[r.scopeId] = r;
    } else {
      const ts = new Date(r.updatedAt || 0).getTime();
      if (!rawByScopeLatest[r.scopeId] || ts > rawByScopeLatest[r.scopeId].ts) {
        rawByScopeLatest[r.scopeId] = { ts, recordId: r.recordId };
      }
    }
  }

  for (const [scopeId, wikiRec] of Object.entries(wikiByScope)) {
    const lastUpdate = new Date(wikiRec.lastWikiUpdate || wikiRec.updatedAt || 0).getTime();
    const latest = rawByScopeLatest[scopeId];
    if (!latest) continue;
    const ageMs = now - lastUpdate;
    if (ageMs >= thirtyDaysMs && latest.ts > lastUpdate) {
      const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      issues.push({
        severity: "warning",
        checkId: "staleness",
        recordId: wikiRec.recordId,
        message: `wiki 갱신 ${ageDays}일 경과 + 새 raw 존재 (scopeId: ${scopeId}, 최신 raw: ${latest.recordId})`
      });
    }
  }
  return issues;
}

// ─── Check 3: raw 레코드 orphan ───────────────────────────────────────────────
/**
 * active raw 레코드가 있는 scopeId 중 wiki 레코드가 없는 경우 → info
 */
function checkOrphanRaw(records) {
  const issues = [];
  const scopeHasWiki = new Set();
  const scopeHasRaw = {};

  for (const r of records) {
    if (r.status !== "active") continue;
    if (r.type === "wiki") {
      scopeHasWiki.add(r.scopeId);
    } else {
      if (!scopeHasRaw[r.scopeId]) scopeHasRaw[r.scopeId] = [];
      scopeHasRaw[r.scopeId].push(r.recordId);
    }
  }

  for (const [scopeId, rawIds] of Object.entries(scopeHasRaw)) {
    if (!scopeHasWiki.has(scopeId)) {
      issues.push({
        severity: "info",
        checkId: "orphan-raw",
        message: `wiki 없는 scopeId: ${scopeId} (raw ${rawIds.length}건 — 첫 recordId: ${rawIds[0]})`
      });
    }
  }
  return issues;
}

// ─── Check 4: orphan 폴더 ─────────────────────────────────────────────────────
/**
 * 30_topics/ 디렉토리 중 records.jsonl 에 대응하는 레코드가 없는 폴더 → info
 */
function checkOrphanFolders(brainRoot, records) {
  const issues = [];
  const topicsDir = path.join(brainRoot, "30_topics");
  if (!fs.existsSync(topicsDir)) return issues;

  const activeScopeIds = new Set(
    records.filter(r => r.status === "active").map(r => r.scopeId)
  );

  let entries;
  try {
    entries = fs.readdirSync(topicsDir, { withFileTypes: true });
  } catch {
    return issues;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!activeScopeIds.has(entry.name)) {
      issues.push({
        severity: "info",
        checkId: "orphan-folder",
        path: path.join("30_topics", entry.name),
        message: `레코드 없는 폴더: 30_topics/${entry.name}`
      });
    }
  }
  return issues;
}

// ─── Check 5: 모순 레코드 ─────────────────────────────────────────────────────
/**
 * 같은 scopeId + title이 active와 deprecated/archived 동시 존재 → critical
 */
function checkContradictions(records) {
  const issues = [];

  // key: `${scopeId}::${title}` → { active: recordId, deprecated: recordId }
  const seen = {};
  for (const r of records) {
    if (!r.title) continue;
    const key = `${r.scopeId}::${r.title}`;
    if (!seen[key]) seen[key] = {};
    if (r.status === "active") {
      seen[key].active = r.recordId;
    } else if (r.status === "deprecated" || r.status === "archived") {
      seen[key].inactive = r.recordId;
    }
  }

  for (const [key, { active, inactive }] of Object.entries(seen)) {
    if (active && inactive) {
      const [scopeId, title] = key.split("::");
      issues.push({
        severity: "critical",
        checkId: "contradiction",
        recordId: active,
        message: `동일 title active+deprecated 공존: "${title}" (active: ${active}, inactive: ${inactive}, scopeId: ${scopeId})`
      });
    }
  }
  return issues;
}

// ─── Check 6: wiki 파일 비대화 ────────────────────────────────────────────────
/**
 * 40_wiki/{scopeId}/wiki.md 파일이 250줄 초과 → warning
 */
function checkBloatedWiki(brainRoot, records) {
  const issues = [];
  const wikiRecords = records.filter(r => r.type === "wiki" && r.status === "active");

  for (const r of wikiRecords) {
    const filePath = path.join(brainRoot, r.sourceRef || `40_wiki/${r.scopeId}/wiki.md`);
    if (!fs.existsSync(filePath)) continue;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lineCount = content.split("\n").length;
      if (lineCount > 250) {
        issues.push({
          severity: "warning",
          checkId: "bloated-wiki",
          recordId: r.recordId,
          path: r.sourceRef,
          message: `wiki ${lineCount}줄 초과 (scopeId: ${r.scopeId}, 경로: ${r.sourceRef})`
        });
      }
    } catch { /* 파일 읽기 실패는 무시 */ }
  }
  return issues;
}

// ─── Check 7: work-log 제목 패턴 ─────────────────────────────────────────────
/**
 * "작업 로그 — YYYY-MM-DD HH:MM" 형식 제목 active 레코드 → info
 */
const WORK_LOG_TITLE_REGEX = /^작업 로그 — \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

function checkTitlePattern(records) {
  const issues = [];
  for (const r of records) {
    if (r.status !== "active") continue;
    if (WORK_LOG_TITLE_REGEX.test(r.title || "")) {
      issues.push({
        severity: "info",
        checkId: "title-pattern",
        recordId: r.recordId,
        message: `제목 재생성 대상: "${r.title}" (scopeId: ${r.scopeId})`
      });
    }
  }
  return issues;
}

// ─── --fix-titles: 제목 재생성 + 30일 archiving ──────────────────────────────
/**
 * work-log 제목 패턴 레코드를 내용 기반으로 재생성하고,
 * 30일+ 된 레코드는 archived로 변경.
 *
 * 전략:
 * 1. records.jsonl .bak 백업
 * 2. 각 대상 레코드:
 *    - summary가 있으면 summary 첫 50자를 제목으로
 *    - 없으면 "작업 로그 — {scopeId} {날짜}" 형태로
 *    - updatedAt 기준 30일+ 경과 시 status → archived
 * 3. 변경된 records.jsonl 쓰기
 *
 * @returns {{ fixed: number, archived: number }}
 */
function fixTitles(brainRoot, options = {}) {
  const { dryRun = false } = options;
  const recordsPath = path.join(brainRoot, "90_index", "records.jsonl");
  const bakPath = recordsPath + ".bak";

  const raw = fs.readFileSync(recordsPath, "utf-8");
  const records = raw.trim().split("\n").filter(Boolean).map(l => JSON.parse(l));

  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  let fixed = 0, archived = 0;
  const updated = records.map(r => {
    if (!WORK_LOG_TITLE_REGEX.test(r.title || "")) return r;
    if (r.status !== "active") return r;

    const rec = { ...r };
    let changed = false;
    const originalUpdatedAt = r.updatedAt; // age 계산은 원본 날짜 기준

    // 제목 재생성
    let newTitle;
    if (rec.summary && rec.summary.trim().length > 0) {
      newTitle = rec.summary.trim().slice(0, 60);
    } else {
      const dateStr = (rec.updatedAt || "").slice(0, 10) || rec.title.match(/\d{4}-\d{2}-\d{2}/)?.[0] || "";
      newTitle = `작업 로그 — ${rec.scopeId}${dateStr ? " " + dateStr : ""}`;
    }

    if (newTitle !== rec.title) {
      rec.title = newTitle;
      fixed++;
      changed = true;
    }

    // 30일+ archiving (원본 updatedAt 기준)
    const age = now - new Date(originalUpdatedAt || 0).getTime();
    if (age >= thirtyDaysMs) {
      rec.status = "archived";
      archived++;
      changed = true;
    }

    if (changed) {
      rec.updatedAt = new Date().toISOString();
    }

    return changed ? rec : r;
  });

  if (dryRun) {
    return { fixed, archived, dryRun: true };
  }

  // .bak 백업 후 쓰기
  fs.copyFileSync(recordsPath, bakPath);
  const newContent = updated.map(r => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(recordsPath, newContent, "utf-8");

  return { fixed, archived };
}

// ─── 메인 lint 함수 ───────────────────────────────────────────────────────────
const CHECK_IDS = ["duplicate", "staleness", "orphan-raw", "orphan-folder", "contradiction", "bloated-wiki", "title-pattern"];

/**
 * Brain 저장소 전체 품질 검사 실행
 *
 * @param {string} brainRoot  ~/Brain 경로
 * @param {{ checks?: string[], json?: boolean }} options
 * @returns {{ issues: LintIssue[], summary: object }}
 */
function lint(brainRoot, options = {}) {
  const { checks } = options;
  const enabledChecks = checks
    ? checks.map(c => c.trim()).filter(c => CHECK_IDS.includes(c))
    : CHECK_IDS;

  const recordsPath = path.join(brainRoot, "90_index", "records.jsonl");
  if (!fs.existsSync(recordsPath)) {
    return { issues: [{ severity: "critical", checkId: "load", message: "records.jsonl 없음" }], summary: {} };
  }

  let records;
  try {
    const raw = fs.readFileSync(recordsPath, "utf-8");
    records = raw.trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  } catch (e) {
    return { issues: [{ severity: "critical", checkId: "load", message: `records.jsonl 파싱 오류: ${e.message}` }], summary: {} };
  }

  const issues = [];

  if (enabledChecks.includes("duplicate"))      issues.push(...checkDuplicates(records));
  if (enabledChecks.includes("staleness"))      issues.push(...checkStaleness(records));
  if (enabledChecks.includes("orphan-raw"))     issues.push(...checkOrphanRaw(records));
  if (enabledChecks.includes("orphan-folder"))  issues.push(...checkOrphanFolders(brainRoot, records));
  if (enabledChecks.includes("contradiction"))  issues.push(...checkContradictions(records));
  if (enabledChecks.includes("bloated-wiki"))   issues.push(...checkBloatedWiki(brainRoot, records));
  if (enabledChecks.includes("title-pattern"))  issues.push(...checkTitlePattern(records));

  const summary = {
    total: issues.length,
    critical: issues.filter(i => i.severity === "critical").length,
    warning: issues.filter(i => i.severity === "warning").length,
    info: issues.filter(i => i.severity === "info").length,
    checksRun: enabledChecks.length,
    recordsChecked: records.length
  };

  return { issues, summary };
}

module.exports = { lint, fixTitles, levenshtein, CHECK_IDS,
  checkDuplicates, checkStaleness, checkOrphanRaw, checkOrphanFolders,
  checkContradictions, checkBloatedWiki, checkTitlePattern };
