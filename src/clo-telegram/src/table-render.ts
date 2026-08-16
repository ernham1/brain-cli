/**
 * 마크다운 테이블 → PNG 이미지 렌더링 (Playwright + Chromium)
 * Telegram <pre> ASCII art 대신 깔끔한 이미지로 전송
 */
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import fs from "node:fs";

// 이미 설치된 Chromium 중 가장 최신 버전 선택
const CHROMIUM_PATH = (() => {
  const base = process.env.LOCALAPPDATA ?? "C:\\Users\\ernham\\AppData\\Local";
  const candidates = [
    `${base}\\ms-playwright\\chromium-1217\\chrome-win64\\chrome.exe`,
    `${base}\\ms-playwright\\chromium-1208\\chrome-win64\\chrome.exe`,
    `${base}\\ms-playwright\\chromium-1187\\chrome-win\\chrome.exe`,
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
})();

/** PM2 프로세스 수명 동안 브라우저 인스턴스 재사용 */
let _browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (_browser?.isConnected()) return _browser;
  _browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  return _browser;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseMarkdownRows(table: string): string[][] {
  return table
    .split("\n")
    .filter(l => /^\s*\|/.test(l) && !/^\s*\|[\s\-:|]+\|\s*$/.test(l.trim()))
    .map(l => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim()));
}

function buildHtml(rows: string[][]): string {
  const [header, ...body] = rows;
  const th = header.map(h => `<th>${escHtml(h)}</th>`).join("");
  const tr = body.map(row =>
    `<tr>${row.map(c => `<td>${escHtml(c)}</td>`).join("")}</tr>`
  ).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #17212b;
    padding: 14px 18px;
    display: inline-block;
    min-width: 240px;
    max-width: 900px;
    font-family: 'Malgun Gothic', 'Segoe UI', 'Noto Sans KR', sans-serif;
  }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  thead tr { background: #232f3d; }
  th {
    padding: 9px 16px;
    text-align: left;
    color: #aebac9;
    font-weight: 600;
    border-bottom: 1px solid #111b24;
    white-space: nowrap;
  }
  td {
    padding: 8px 16px;
    color: #d4dde7;
    border-bottom: 1px solid #1c2733;
    white-space: nowrap;
  }
  tbody tr:nth-child(odd)  { background: #17212b; }
  tbody tr:nth-child(even) { background: #1a2535; }
  tbody tr:last-child td   { border-bottom: none; }
</style></head>
<body>
  <table>
    <thead><tr>${th}</tr></thead>
    <tbody>${tr}</tbody>
  </table>
</body></html>`;
}

/** 마크다운 테이블 문자열 → PNG Buffer */
export async function renderTablePng(markdownTable: string): Promise<Buffer> {
  const rows = parseMarkdownRows(markdownTable);
  if (rows.length === 0) throw new Error("빈 테이블");

  const html = buildHtml(rows);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.setContent(html, { waitUntil: "load" });
    // body가 inline-block이라 실제 콘텐츠 크기로 캡처
    const element = await page.$("body");
    if (!element) throw new Error("body element not found");
    const buf = await element.screenshot({ type: "png" });
    return Buffer.from(buf);
  } finally {
    await page.close();
  }
}

/** 마크다운 테이블 포함 여부 감지 */
export function hasMarkdownTable(text: string): boolean {
  const lines = text.split("\n");
  let count = 0;
  for (const line of lines) {
    if (/^\s*\|.+\|\s*$/.test(line)) {
      if (++count >= 2) return true;
    } else {
      count = 0;
    }
  }
  return false;
}

/**
 * 텍스트에서 테이블 블록을 추출하고 나머지 텍스트를 반환
 * tables: 추출된 테이블 문자열 배열
 * cleaned: 테이블 제거 후 나머지 텍스트
 */
export function extractTables(text: string): { cleaned: string; tables: string[] } {
  const tables: string[] = [];
  const cleaned = text
    .replace(/((?:[ \t]*\|[^\n]+\|[ \t]*(?:\n|$))+)/g, (match) => {
      tables.push(match.trim());
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleaned, tables };
}

/** 브라우저 명시적 종료 (프로세스 종료 시) */
export async function closeBrowser(): Promise<void> {
  if (_browser?.isConnected()) {
    await _browser.close();
    _browser = null;
  }
}
