"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { readJsonl, ensureDir, isoNow } = require("./utils");
const { BWTEngine } = require("./bwt");

const WIKI_DIR = "40_wiki";
const ACTIVITY_LOG = "40_wiki/_activity.log";
const INDEX_MD = "40_wiki/_index.md";
const PROMPT_POLICY = "99_policy/wiki-compile-prompt.md";

/**
 * Wiki 컴파일 — 6단계 파이프라인
 *
 * Step 1: scopeId별 active 레코드 그룹핑 → 변경된 scopeId만 선택
 * Step 2: 해당 scopeId의 active raw 레코드 + sourceRef 파일 로드
 * Step 3: 기존 wiki 문서 로드 (40_wiki/{scopeId}/ 하위)
 * Step 4: claude -p 로 컴파일 프롬프트 실행
 * Step 5: BWT로 wiki 레코드 저장
 * Step 6: 40_wiki/_index.md 자동 재생성
 *
 * @param {string} brainRoot
 * @param {{ scope?: string, full?: boolean, dryRun?: boolean }} opts
 * @returns {{ compiled: string[], skipped: string[], errors: string[] }}
 */
function wikiCompile(brainRoot, opts = {}) {
  const { scope, full = false, dryRun = false } = opts;
  const recordsPath = path.join(brainRoot, "90_index", "records.jsonl");
  const records = readJsonl(recordsPath);

  // --- Step 1: scopeId별 그룹핑 ---
  const groups = _groupByScopeId(records, scope);
  const targetScopeIds = _selectTargets(brainRoot, groups, full);

  if (dryRun) {
    return { compiled: [], skipped: [], errors: [], dryRunTargets: targetScopeIds };
  }

  const compiled = [];
  const skipped = [];
  const errors = [];

  // --- 컴파일 프롬프트 로드 ---
  const promptTemplate = _loadPromptTemplate(brainRoot);

  for (const scopeId of targetScopeIds) {
    try {
      // --- Step 2: raw 레코드 로드 ---
      const rawRecords = groups[scopeId].filter(r => r.type !== "wiki");
      if (rawRecords.length === 0) {
        skipped.push(scopeId);
        continue;
      }

      // --- Step 3: 기존 wiki 문서 로드 ---
      const { existingWikiContent, existingWikiRecordId } = _loadExistingWiki(brainRoot, records, scopeId);

      // --- Step 4: claude -p 실행 ---
      const wikiContent = _runClaudeCompile(
        promptTemplate,
        scopeId,
        rawRecords,
        existingWikiContent
      );

      if (!wikiContent || wikiContent.trim().length === 0) {
        errors.push(`${scopeId}: claude -p 응답 없음`);
        continue;
      }

      // --- Step 5: BWT로 wiki 레코드 저장 ---
      const wikiPath = `${WIKI_DIR}/${scopeId}/wiki.md`;
      const engine = new BWTEngine(brainRoot);

      let bwtResult;
      if (existingWikiRecordId) {
        bwtResult = engine.execute({
          action: "update",
          recordId: existingWikiRecordId,
          sourceRef: wikiPath,
          content: wikiContent,
          record: {
            summary: `${scopeId} 통합 Wiki — Raw ${rawRecords.length}건 기준`,
            tags: ["domain/memory", "intent/retrieval", "layer/wiki"],
            lastWikiUpdate: isoNow()
          }
        });
      } else {
        // scopeType 결정: 첫 raw 레코드 기준
        const scopeType = rawRecords[0]?.scopeType || "topic";
        bwtResult = engine.execute({
          action: "create",
          sourceRef: wikiPath,
          content: wikiContent,
          record: {
            scopeType,
            scopeId,
            type: "wiki",
            title: `${scopeId} — Wiki`,
            summary: `${scopeId} 통합 Wiki — Raw ${rawRecords.length}건 기준`,
            tags: ["domain/memory", "intent/retrieval", "layer/wiki"],
            sourceType: "candidate"
          }
        });
      }

      if (!bwtResult.success) {
        errors.push(`${scopeId}: BWT 실패 — ${JSON.stringify(bwtResult.report.errors)}`);
        continue;
      }

      // activity log append
      _appendActivityLog(brainRoot, "COMPILE", scopeId, `Raw ${rawRecords.length}건 → wiki.md 생성/갱신`);
      compiled.push(scopeId);

    } catch (err) {
      errors.push(`${scopeId}: ${err.message}`);
    }
  }

  // --- Step 6: _index.md 재생성 ---
  if (compiled.length > 0) {
    try {
      _rebuildIndex(brainRoot, readJsonl(path.join(brainRoot, "90_index", "records.jsonl")));
    } catch (err) {
      errors.push(`_index.md 재생성 실패: ${err.message}`);
    }
  }

  return { compiled, skipped, errors };
}

// --- Step 1 헬퍼: scopeId별 그룹핑 ---
function _groupByScopeId(records, filterScope) {
  const groups = {};
  for (const r of records) {
    if (r.status !== "active") continue;
    if (filterScope && r.scopeId !== filterScope) continue;
    if (!groups[r.scopeId]) groups[r.scopeId] = [];
    groups[r.scopeId].push(r);
  }
  return groups;
}

// --- Step 1 헬퍼: 컴파일 대상 scopeId 선택 ---
function _selectTargets(brainRoot, groups, full) {
  const scopeIds = Object.keys(groups);

  if (full) return scopeIds;

  // 증분: 기존 wiki 레코드의 lastWikiUpdate 이후 raw 레코드가 있는 scopeId만
  const targets = [];
  for (const scopeId of scopeIds) {
    const recs = groups[scopeId];
    const wikiRec = recs.find(r => r.type === "wiki");
    if (!wikiRec) {
      // wiki 없으면 raw가 1건 이상이면 컴파일 대상
      const hasRaw = recs.some(r => r.type !== "wiki");
      if (hasRaw) targets.push(scopeId);
      continue;
    }
    // wiki 있으면 마지막 갱신 이후 새 raw가 있는지 확인
    const lastUpdate = wikiRec.lastWikiUpdate || wikiRec.updatedAt || "1970-01-01T00:00:00.000Z";
    const hasNewRaw = recs.some(r => r.type !== "wiki" && r.updatedAt > lastUpdate);
    if (hasNewRaw) targets.push(scopeId);
  }
  return targets;
}

// --- Step 3 헬퍼: 기존 wiki 문서 로드 ---
function _loadExistingWiki(brainRoot, records, scopeId) {
  const wikiRec = records.find(r => r.scopeId === scopeId && r.type === "wiki" && r.status === "active");
  const wikiSourceRef = wikiRec?.sourceRef || `${WIKI_DIR}/${scopeId}/wiki.md`;
  const wikiFilePath = path.join(brainRoot, wikiSourceRef);
  let existingWikiContent = "";
  try {
    if (fs.existsSync(wikiFilePath)) {
      existingWikiContent = fs.readFileSync(wikiFilePath, "utf-8");
    }
  } catch { /* 파일 없으면 빈 문자열 */ }

  return { existingWikiContent, existingWikiRecordId: wikiRec?.recordId || null };
}

// --- Step 4 헬퍼: claude -p 실행 ---
function _runClaudeCompile(promptTemplate, scopeId, rawRecords, existingWikiContent, runProcess = spawnSync) {
  const today = new Date().toISOString().slice(0, 10);
  const rawSummary = rawRecords.slice(0, 30).map(r =>
    `[${r.recordId}] (${r.type}) ${r.title} — ${r.summary || ""}`
  ).join("\n");

  const prompt = promptTemplate
    .replace(/\{\{SCOPE_ID\}\}/g, scopeId)
    .replace(/\{\{RAW_COUNT\}\}/g, String(rawRecords.length))
    .replace(/\{\{RAW_RECORDS\}\}/g, rawSummary)
    .replace(/\{\{EXISTING_WIKI\}\}/g, existingWikiContent || "(없음 — 신규 작성)")
    .replace(/\{\{TODAY\}\}/g, today);

  const command = process.platform === "win32" ? "claude.cmd" : "claude";
  const result = runProcess(command, ["-p"], {
    input: prompt,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
    timeout: 120000,
    windowsHide: true,
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = String(result.stderr || "").trim() || `exit ${result.status}`;
    throw new Error(`claude -p 실패: ${message}`);
  }
  return String(result.stdout || "").trim();
}

// --- 프롬프트 템플릿 로드 ---
function _loadPromptTemplate(brainRoot) {
  const promptPath = path.join(brainRoot, PROMPT_POLICY);
  if (fs.existsSync(promptPath)) {
    const raw = fs.readFileSync(promptPath, "utf-8");
    // "## 프롬프트 본문" 이후 부분만 추출
    const marker = "## 프롬프트 본문";
    const idx = raw.indexOf(marker);
    if (idx !== -1) {
      return raw.slice(idx + marker.length).trim();
    }
    return raw;
  }
  // 내장 기본 프롬프트 (정책 파일 없을 때 폴백)
  return _defaultPrompt();
}

function _defaultPrompt() {
  return `당신은 Brain Wiki 컴파일러입니다. 아래 Raw 레코드들을 분석하여 '{{SCOPE_ID}}' 주제의 Wiki 문서를 작성하세요.

Raw 레코드 ({{RAW_COUNT}}건):
{{RAW_RECORDS}}

기존 Wiki:
{{EXISTING_WIKI}}

출력 형식:
# {{SCOPE_ID}} — Wiki
> 최종 갱신: {{TODAY}} | Raw 참조: {{RAW_COUNT}}건

## 현재 상태
## 핵심 정보
## 최근 변경 (최근 5건)
## 미해결 이슈
## 관련 링크

규칙: 250줄 이내, 순수 마크다운만 출력.`;
}

// --- _index.md 재생성 ---
function _rebuildIndex(brainRoot, records) {
  const wikiRecords = records.filter(r => r.type === "wiki" && r.status === "active");
  const rawGroups = _groupByScopeId(records);

  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    "# Brain Wiki 마스터 카탈로그",
    `> 자동 생성 — brain-cli wiki compile 실행 시 갱신 | 최종: ${today}`,
    "",
    "| scopeId | wiki 문서 | raw 건수 | 최종 갱신 |",
    "|---------|-----------|---------|---------|"
  ];

  for (const wr of wikiRecords.sort((a, b) => a.scopeId.localeCompare(b.scopeId))) {
    const rawCount = (rawGroups[wr.scopeId] || []).filter(r => r.type !== "wiki").length;
    const updatedAt = (wr.lastWikiUpdate || wr.updatedAt || "").slice(0, 10);
    lines.push(`| ${wr.scopeId} | [wiki.md](${wr.sourceRef}) | ${rawCount} | ${updatedAt} |`);
  }

  if (wikiRecords.length === 0) {
    lines.push("| (아직 없음) | — | — | — |");
  }

  const indexPath = path.join(brainRoot, INDEX_MD);
  ensureDir(path.dirname(indexPath));
  fs.writeFileSync(indexPath, lines.join("\n") + "\n", "utf-8");
}

// --- activity log append ---
function _appendActivityLog(brainRoot, action, scopeId, desc) {
  const logPath = path.join(brainRoot, ACTIVITY_LOG);
  ensureDir(path.dirname(logPath));
  const line = `[${isoNow()}] [${action}] [${scopeId}] ${desc}\n`;
  fs.appendFileSync(logPath, line, "utf-8");
}

module.exports = { wikiCompile, _rebuildIndex, _groupByScopeId, _loadExistingWiki, _runClaudeCompile };
