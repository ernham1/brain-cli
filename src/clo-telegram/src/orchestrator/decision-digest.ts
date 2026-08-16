import fs from "node:fs";
import path from "node:path";
import { defaultJournalDir } from "./decision-journal.js";

/**
 * 일일 결정 다이제스트: 하루치 결정 저널을 요약해 텔레그램 1건으로 만든다.
 *
 * 목적: 이사님이 결정 히스토리를 전수 열람하지 않게 한다.
 * 요약(건수) + 검토 권장(틀렸을 확률이 높은 것만 최대 8건)의 2층 구조.
 * 검토 권장 기준: LLM 판정 / 확신도 0.8 미만 트윈 결정 / 에스컬레이션 미기록 / 트윈 미실행.
 * 이미 이사님이 개입한 건(뒤집힘/확인/인간결정)은 권장 목록에서 제외한다.
 */

interface JournalRowLike {
  id: string;
  ts: string;
  project: string;
  question: string;
  mode?: "shadow" | "live";
  irreversible?: boolean;
  twin: {
    twinVersion: string;
    verdict: "approve" | "reject" | "hold" | "escalate";
    confidence?: number;
    rationale?: string;
  } | null;
  human: { decision: string; note?: string } | null;
}

export interface DecisionDigest {
  date: string;
  total: number;
  counts: {
    autoApproved: number;
    twinDecided: number;
    escalated: number;
    humanTouched: number;
  };
  reviewItems: Array<{ id: string; tag: string; summary: string; confidence?: number }>;
  /** C안(2026-07-28): 전 기간 미검토 백로그에서 날짜 시드로 뽑은 무작위 사후 감사 표본 */
  sampleItems: Array<{ id: string; summary: string }>;
  /** 미검토 잔량: important=중요 건(검토 권장 기준), total=전체 human 미기록 */
  backlog: { important: number; total: number };
  message: string;
}

const REVIEW_CONFIDENCE_THRESHOLD = 0.8;
const MAX_REVIEW_ITEMS = 8;

/** 저널 디렉토리에서 특정 KST 날짜(YYYY-MM-DD)의 행을 읽는다 (같은 id는 마지막 행 채택) */
export function readDecisionsForDate(kstDate: string, journalDir = defaultJournalDir()): JournalRowLike[] {
  const monthFile = path.join(journalDir, `${kstDate.slice(0, 7)}.jsonl`);
  let lines: string[];
  try {
    lines = fs.readFileSync(monthFile, "utf-8").split("\n").filter((line) => line.trim());
  } catch {
    return [];
  }
  const byId = new Map<string, JournalRowLike>();
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as JournalRowLike;
      if (typeof row.ts === "string" && row.ts.startsWith(kstDate)) byId.set(row.id, row);
    } catch { /* 손상 행 무시 */ }
  }
  return [...byId.values()];
}

/** 저널 디렉토리의 전 월 파일을 읽어 고유 결정(같은 id는 마지막 행)을 반환한다. C안 백로그·샘플용 */
export function readAllDecisions(journalDir = defaultJournalDir()): JournalRowLike[] {
  let files: string[];
  try {
    files = fs.readdirSync(journalDir).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort();
  } catch {
    return [];
  }
  const byId = new Map<string, JournalRowLike>();
  for (const file of files) {
    let lines: string[];
    try {
      lines = fs.readFileSync(path.join(journalDir, file), "utf-8").split("\n").filter((line) => line.trim());
    } catch {
      continue;
    }
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as JournalRowLike;
        if (typeof row.id === "string") byId.set(row.id, row);
      } catch { /* 손상 행 무시 */ }
    }
  }
  return [...byId.values()];
}

/**
 * 검토 권장(중요 건) 여부. 정본은 decision-pipeline tools/lib/journal-view.mjs의 needsReview이며
 * 이 함수는 그 기준의 사본이다 (2026-07-28 A안: 기준 변경 시 양쪽을 함께 갱신할 것).
 */
function isImportantUnreviewed(row: JournalRowLike): boolean {
  if (row.human) return false;
  if (!row.twin) return true; // 트윈 미실행
  if (row.twin.verdict === "escalate") return true;
  if (row.irreversible === true) return true;
  if (row.twin.verdict === "reject" || row.twin.verdict === "hold") return true;
  if (String(row.question ?? "").startsWith("[LOOP_END]")) return true;
  if (row.twin.twinVersion === "gate-auto") return false;
  return row.twin.confidence !== undefined && row.twin.confidence < REVIEW_CONFIDENCE_THRESHOLD;
}

/** 날짜 문자열 시드 결정론 난수 (같은 날 재생성 시 같은 샘플 · mulberry32) */
function seededRandom(seedText: string): () => number {
  let seed = 0;
  for (const ch of seedText) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * C안: 전 기간 미검토 백로그에서 무작위 사후 감사 표본 n건.
 * 블라인드 검토 가능 건(shadow + 트윈 approve/reject/hold 선기록 + human 미기록)을 우선한다
 * (kappa 일치율 표본 축적에 최적 · 판정 내용은 메시지에 싣지 않아 blind 오염 없음).
 */
export function pickDailySample(allRows: JournalRowLike[], kstDate: string, n = 5): JournalRowLike[] {
  const unreviewed = allRows.filter((row) => !row.human);
  const blindable = unreviewed.filter(
    (row) => row.mode === "shadow" && !!row.twin && ["approve", "reject", "hold"].includes(row.twin.verdict),
  );
  const pool = (blindable.length >= n ? blindable : unreviewed).slice().sort((a, b) => a.id.localeCompare(b.id));
  const rand = seededRandom(`dp-sample-${kstDate}`);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

/**
 * 일일 다이제스트 생성. allRows(전 기간)를 주면 C안의 무작위 샘플 5건과 미검토 잔량이 붙는다.
 * 2026-07-28 A안 축소: 당일 검토 권장은 중요 건만 (블라인드 대기 전량·LLM 판정 전량 나열 폐지).
 * shadow 건은 판정·확신도를 메시지에 싣지 않는다 (blind 표본 오염 금지 · 측정 규칙 1).
 */
export function buildDailyDecisionDigest(
  rows: JournalRowLike[],
  kstDate: string,
  allRows?: JournalRowLike[],
): DecisionDigest {
  const counts = {
    autoApproved: 0,
    twinDecided: 0,
    escalated: 0,
    humanTouched: 0,
  };
  const reviewItems: DecisionDigest["reviewItems"] = [];

  for (const row of rows) {
    const twin = row.twin;
    if (row.human) counts.humanTouched += 1;

    if (!twin) {
      counts.escalated += 1;
      if (!row.human) {
        reviewItems.push({ id: row.id, tag: "트윈 미실행", summary: shorten(row.question) });
      }
      continue;
    }
    if (twin.verdict === "escalate") {
      counts.escalated += 1;
      if (!row.human) {
        reviewItems.push({ id: row.id, tag: "에스컬레이션 미기록", summary: shorten(row.question) });
      }
      continue;
    }
    if (twin.twinVersion === "gate-auto") {
      counts.autoApproved += 1;
      if (!row.human && row.irreversible === true) {
        reviewItems.push({ id: row.id, tag: "비가역 미검토", summary: shorten(row.question) });
      }
      continue;
    }

    counts.twinDecided += 1;
    if (row.human) continue; // 이미 뒤집기/확인하심

    if (row.irreversible === true) {
      reviewItems.push({ id: row.id, tag: "비가역 미검토", summary: shorten(row.question) });
      continue;
    }
    if (String(row.question ?? "").startsWith("[LOOP_END]")) {
      reviewItems.push({ id: row.id, tag: "루프 종료 자율 승인", summary: shorten(row.question) });
      continue;
    }
    const judgedImportant = twin.verdict === "reject" || twin.verdict === "hold"
      || (twin.confidence !== undefined && twin.confidence < REVIEW_CONFIDENCE_THRESHOLD);
    if (!judgedImportant) continue;
    if (row.mode === "shadow") {
      // 판정 방향·확신도를 숨긴다: 이 건은 GUI 블라인드 검토로 유도 (blind 오염 금지)
      reviewItems.push({ id: row.id, tag: "검토 필요(사유 비공개)", summary: shorten(row.question) });
    } else {
      reviewItems.push({
        id: row.id,
        tag: `트윈 ${twin.verdict}`,
        summary: shorten(row.question),
        ...(twin.confidence !== undefined ? { confidence: twin.confidence } : {}),
      });
    }
  }

  // 확신도 낮은 순 → 태그 순으로 정렬, 상한 적용
  reviewItems.sort((a, b) => (a.confidence ?? 0) - (b.confidence ?? 0));
  const cappedItems = reviewItems.slice(0, MAX_REVIEW_ITEMS);
  const dropped = reviewItems.length - cappedItems.length;

  const sampleItems: DecisionDigest["sampleItems"] = [];
  const backlog = { important: 0, total: 0 };
  if (allRows && allRows.length > 0) {
    for (const row of allRows) {
      if (!row.human) {
        backlog.total += 1;
        if (isImportantUnreviewed(row)) backlog.important += 1;
      }
    }
    for (const row of pickDailySample(allRows, kstDate)) {
      sampleItems.push({ id: row.id, summary: shorten(row.question) });
    }
  }

  const lines = [
    `[결정 다이제스트] ${kstDate}`,
    `오늘 결정 ${rows.length}건: 자율승인 ${counts.autoApproved} · 트윈 결정 ${counts.twinDecided} · 에스컬레이션 ${counts.escalated}`
    + (counts.humanTouched > 0 ? ` · 이사님 개입 ${counts.humanTouched}` : ""),
  ];
  if (cappedItems.length === 0) {
    lines.push("검토 권장: 없음. 전부 게이트/트윈 기준 안에서 처리됐습니다.");
  } else {
    lines.push(`검토 권장 ${reviewItems.length}건 (중요 건만):`);
    cappedItems.forEach((item, index) => {
      const conf = item.confidence !== undefined ? ` ${item.confidence}` : "";
      lines.push(`${index + 1}. [${item.tag}${conf}] ${item.summary}`);
    });
    if (dropped > 0) lines.push(`… 외 ${dropped}건은 GUI에서 확인`);
  }
  if (sampleItems.length > 0) {
    lines.push(`오늘의 무작위 검토 ${sampleItems.length}건 (전 기간 미검토에서 추첨 · 5분 사후 감사):`);
    sampleItems.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.summary} (${item.id})`);
    });
  }
  if (backlog.total > 0) {
    lines.push(`미검토 잔량: 중요 ${backlog.important}건 · 전체 ${backlog.total}건`);
  }
  lines.push("열람/뒤집기: http://127.0.0.1:4877 (검토 추천 뷰)");

  return {
    date: kstDate,
    total: rows.length,
    counts,
    reviewItems: cappedItems,
    sampleItems,
    backlog,
    message: lines.join("\n"),
  };
}

function shorten(text: string): string {
  const normalized = text.replace(/^\[[A-Z_]+\]\s*/, "").replace(/\s+/g, " ").trim();
  return normalized.length > 56 ? `${normalized.slice(0, 53)}...` : normalized;
}
