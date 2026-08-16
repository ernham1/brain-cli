/**
 * Telegraph API 유틸
 * 마크다운 테이블 → Telegraph Instant View 링크 변환
 */
import https from "node:https";

type TelegraphNode =
  | string
  | { tag: string; attrs?: Record<string, string>; children?: TelegraphNode[] };

/** 마크다운 테이블 포함 여부 감지 */
export function hasMarkdownTable(text: string): boolean {
  const lines = text.split("\n");
  let tableRowCount = 0;
  for (const line of lines) {
    if (/^\s*\|.+\|\s*$/.test(line)) {
      tableRowCount++;
      if (tableRowCount >= 2) return true;
    } else {
      tableRowCount = 0;
    }
  }
  return false;
}

/** 마크다운 → Telegraph Node 배열 변환 */
function markdownToNodes(md: string): TelegraphNode[] {
  const nodes: TelegraphNode[] = [];
  const lines = md.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 테이블 블록
    if (/^\s*\|.+\|\s*$/.test(line)) {
      const tableLines: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      nodes.push(...parseMarkdownTable(tableLines));
      continue;
    }

    // 헤딩
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 4);
      const tag = level <= 2 ? "h3" : "h4";
      nodes.push({ tag, children: [inlineMarkdown(headingMatch[2])] });
      i++;
      continue;
    }

    // 코드 블록
    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // closing ```
      nodes.push({ tag: "pre", children: [codeLines.join("\n")] });
      continue;
    }

    // 빈 줄
    if (line.trim() === "") {
      i++;
      continue;
    }

    // 일반 단락
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^\s*\|/.test(lines[i]) && !lines[i].startsWith("#") && !lines[i].startsWith("```")) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      nodes.push({ tag: "p", children: [inlineMarkdown(paraLines.join(" "))] });
    }
  }

  return nodes;
}

// Telegraph는 table 태그 미지원 → h4(헤더) + hr + p(행) 구조로 렌더링
// pre 블록 가로 오버플로우 없이 자연스러운 줄바꿈 + Telegraph 타이포그래피 활용
function parseMarkdownTable(lines: string[]): TelegraphNode[] {
  // separator row 제거 (|---|---| 형태)
  const dataLines = lines.filter(l => !/^\|[\s\-:|]+\|$/.test(l.trim()));
  if (dataLines.length === 0) return [];

  const rows = dataLines.map(line =>
    line.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim())
  );
  if (rows.length === 0) return [];

  const [headerRow, ...bodyRows] = rows;
  const nodes: TelegraphNode[] = [];

  nodes.push({ tag: "h4", children: [headerRow.join("  │  ")] });
  nodes.push({ tag: "hr" });
  for (const row of bodyRows) {
    nodes.push({ tag: "p", children: [row.join("  │  ")] });
  }

  return nodes;
}

/** 인라인 마크다운 처리 (bold/italic 무시하고 텍스트만 반환 — Telegraph 단순화) */
function inlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1");
}

function telegraphPost(path: string, body: object): Promise<unknown> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.telegra.ph",
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("Telegraph 응답 파싱 실패"));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** Telegraph 계정 생성 → access_token 반환 */
export async function createTelegraphAccount(): Promise<string> {
  const res = await telegraphPost("/createAccount", {
    short_name: "Clo",
    author_name: "클로",
  }) as { ok: boolean; result?: { access_token: string }; error?: string };

  if (!res.ok || !res.result) throw new Error(`Telegraph 계정 생성 실패: ${res.error}`);
  return res.result.access_token;
}

/** Telegraph 페이지 생성 → URL 반환 */
export async function createTelegraphPage(
  token: string,
  title: string,
  markdownContent: string,
): Promise<string> {
  const content = markdownToNodes(markdownContent);
  if (content.length === 0) throw new Error("변환할 내용 없음");

  const res = await telegraphPost("/createPage", {
    access_token: token,
    title,
    author_name: "클로",
    content,
    return_content: false,
  }) as { ok: boolean; result?: { url: string }; error?: string };

  if (!res.ok || !res.result) throw new Error(`Telegraph 페이지 생성 실패: ${res.error}`);
  return res.result.url;
}
