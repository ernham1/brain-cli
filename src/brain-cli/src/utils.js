"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { SCOPE_ABBREV } = require("./schemas");

/**
 * 파일의 SHA256 해시를 계산한다.
 * @param {string} filePath
 * @returns {string} "sha256:abc123..."
 */
function calculateHash(filePath) {
  const content = fs.readFileSync(filePath);
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  return `sha256:${hash}`;
}

/**
 * 문자열의 SHA256 해시를 계산한다.
 * @param {string} content
 * @returns {string} "sha256:abc123..."
 */
function calculateHashFromString(content) {
  const hash = crypto.createHash("sha256").update(content, "utf-8").digest("hex");
  return `sha256:${hash}`;
}

/**
 * recordId를 생성한다.
 * @param {string} scopeType - project | agent | user | topic
 * @param {string} scopeId - 대상 ID
 * @param {Object[]} existingRecords - 기존 레코드 배열 (순번 결정용)
 * @returns {string} "rec_proj_brain_20260226_0001"
 */
function generateRecordId(scopeType, scopeId, existingRecords) {
  const abbrev = SCOPE_ABBREV[scopeType];
  if (!abbrev) throw new Error(`Unknown scopeType: ${scopeType}`);

  const now = new Date();
  const dateStr = now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0");

  const prefix = `rec_${abbrev}_${scopeId}_${dateStr}_`;

  // 같은 날짜의 기존 레코드 수를 세서 순번 결정
  let maxSeq = 0;
  for (const rec of existingRecords) {
    if (rec.recordId && rec.recordId.startsWith(prefix)) {
      const seq = parseInt(rec.recordId.slice(prefix.length), 10);
      if (seq > maxSeq) maxSeq = seq;
    }
  }

  const nextSeq = String(maxSeq + 1).padStart(4, "0");
  return `${prefix}${nextSeq}`;
}

/**
 * JSONL 파일을 읽어 객체 배열로 반환한다.
 * @param {string} filePath
 * @returns {Object[]}
 */
function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];

  const records = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`JSONL 파싱 오류 (line ${i + 1}): ${err.message}`);
    }
  }
  return records;
}

/**
 * 객체 배열을 JSONL 형식으로 파일에 쓴다.
 * @param {string} filePath
 * @param {Object[]} records
 */
function writeJsonl(filePath, records) {
  const lines = records.map(r => JSON.stringify(r));
  fs.writeFileSync(filePath, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf-8");
}

/**
 * JSON 파일을 안전하게 읽는다.
 * @param {string} filePath
 * @returns {{ ok: boolean, data: any, error?: Error }}
 */
function safeReadJson(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return { ok: true, data: JSON.parse(content) };
  } catch (err) {
    return { ok: false, data: null, error: err };
  }
}

/**
 * 현재 디렉토리부터 상위로 올라가며 Brain/ 폴더를 탐색한다.
 * @param {string} startDir
 * @returns {string|null} Brain 루트 경로 또는 null
 */
function findBrainRoot(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, "Brain");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      // 90_index/ 폴더가 있는지 추가 확인
      if (fs.existsSync(path.join(candidate, "90_index"))) {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 레코드에서 digest 텍스트 한 줄을 생성한다 (8컬럼).
 * @param {Object} record
 * @returns {string} "recordId | title | summary | tags | status | type | sourceType | updatedAt"
 */
function generateDigestLine(record) {
  const tags = Array.isArray(record.tags) ? record.tags.join(",") : "";
  const type = record.type || "";
  const sourceType = record.sourceType || "candidate";
  const updatedAt = record.updatedAt || "";
  return `${record.recordId} | ${record.title} | ${record.summary} | ${tags} | ${record.status} | ${type} | ${sourceType} | ${updatedAt}`;
}

// --- 한글 스테밍 (REQ-200~206) ---

// REQ-202: 어미 제거 목록 (longest-match-first 순서로 정렬)
const VERB_SUFFIXES = [
  "해볼까", "이에요", "합니다", "습니다", "됩니다",
  "해줘", "해줄", "해주", "할까", "할게", "하면", "하고", "하는", "하지",
  "해봐", "했던", "해야", "인지", "인가", "인데", "이야",
  "해요", "하죠", "할래",
  "줘야", "줘봐", "줘서",
  "줘", "봐"
];

// 불규칙 활용 어간 매핑 (stem 후처리)
const IRREGULAR_STEM_MAP = {
  "고쳐": "고치",   // ㅎ불규칙: 고치다→고쳐
  "골라": "고르",   // 르불규칙: 고르다→골라
  "지어": "짓",     // ㅅ불규칙: 짓다→지어
  "도와": "돕",     // ㅂ불규칙: 돕다→도와
  "들어": "듣",     // ㄷ불규칙: 듣다→들어
  "물어": "묻",     // ㄷ불규칙: 묻다→물어
  "불러": "부르",   // 르불규칙: 부르다→불러
  "몰라": "모르",   // 르불규칙: 모르다→몰라
  "나아": "낫",     // ㅅ불규칙: 낫다→나아
  "걸어": "걷",     // ㄷ불규칙: 걷다→걸어
  "쉬워": "쉽",     // ㅂ불규칙: 쉽다→쉬워
  "어려워": "어렵"  // ㅂ불규칙: 어렵다→어려워
};

// REQ-201: 조사 제거 목록 (longest-match-first 순서로 정렬)
const JOSA_SUFFIXES = [
  "에서", "으로", "에게", "한테", "처럼", "만큼", "보다", "까지", "부터", "마다",
  "은", "는", "이", "가", "을", "를", "에", "의", "로", "도", "만", "뿐", "과"
];

// REQ-205: 한글 포함 여부 검사 정규식
const HANGUL_RE = /[\uAC00-\uD7A3]/;

/**
 * REQ-200: 한글 토큰에서 조사/어미 접미사를 제거하여 어근을 반환한다.
 * REQ-203: longest-match-first 전략 (배열이 길이순 정렬)
 * REQ-204: 어근이 빈 문자열이면 원본 반환
 * REQ-205: 한글 미포함 토큰은 바이패스
 * @param {string} token
 * @returns {string}
 */
function stemKorean(token) {
  if (!HANGUL_RE.test(token)) return token;

  let result = token;

  // 어미 제거 (먼저 — 어미가 조사보다 뒤에 붙음)
  for (const suffix of VERB_SUFFIXES) {
    if (result.endsWith(suffix) && result.length > suffix.length) {
      result = result.slice(0, -suffix.length);
      break;
    }
  }

  // 조사 제거
  for (const josa of JOSA_SUFFIXES) {
    if (result.endsWith(josa) && result.length > josa.length) {
      result = result.slice(0, -josa.length);
      break;
    }
  }

  // 불규칙 활용 어간 매핑 (REQ-225)
  if (IRREGULAR_STEM_MAP[result]) {
    result = IRREGULAR_STEM_MAP[result];
  }

  return result;
}

/**
 * REQ-206: 텍스트를 정규화된 토큰 배열로 변환한다.
 * split → filter(len>1) → stemKorean → toLowerCase
 * @param {string} text
 * @returns {string[]}
 */
function normalizeTokens(text) {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length > 1)
    .map(t => stemKorean(t));
}

// --- 동의어 맵 (REQ-030~034) ---

let _synonymCache = null;

/**
 * [termA, termB] 쌍 배열로부터 양방향 맵을 구축한다.
 * @param {Array<[string, string]>} pairs
 * @returns {Map<string, string[]>}
 */
function _buildBidirectionalMap(pairs) {
  const map = new Map();

  for (const [a, b] of pairs) {
    if (a === b) continue;

    if (!map.has(a)) map.set(a, []);
    const listA = map.get(a);
    if (!listA.includes(b)) listA.push(b);

    if (!map.has(b)) map.set(b, []);
    const listB = map.get(b);
    if (!listB.includes(a)) listB.push(a);
  }

  return map;
}

/**
 * tags.json에서 동의어 맵을 로딩한다.
 * 3개 소스: domain.synonyms, intent.synonyms, general_synonyms
 * @param {string} brainRoot - Brain 루트 경로
 * @returns {Map<string, string[]>} 양방향 동의어 맵
 */
function loadSynonyms(brainRoot) {
  if (_synonymCache) return _synonymCache;

  const tagsPath = path.join(brainRoot, "90_index", "tags.json");
  const result = safeReadJson(tagsPath);
  if (!result.ok) {
    _synonymCache = new Map();
    return _synonymCache;
  }

  const tags = result.data;
  const pairs = [];

  // 1) domain.synonyms: { "frontend": "ui", ... }
  if (tags.domain && tags.domain.synonyms) {
    for (const [alias, canonical] of Object.entries(tags.domain.synonyms)) {
      pairs.push([alias.toLowerCase(), canonical.toLowerCase()]);
    }
  }

  // 2) intent.synonyms: { "search": "retrieval", ... }
  if (tags.intent && tags.intent.synonyms) {
    for (const [alias, canonical] of Object.entries(tags.intent.synonyms)) {
      pairs.push([alias.toLowerCase(), canonical.toLowerCase()]);
    }
  }

  // 3) general_synonyms: { "그룹키": ["동의어1", "동의어2", ...], ... }
  if (tags.general_synonyms) {
    for (const [groupKey, members] of Object.entries(tags.general_synonyms)) {
      if (!Array.isArray(members)) continue;
      const allTerms = [groupKey.toLowerCase(), ...members.map(m => m.toLowerCase())];
      for (let i = 0; i < allTerms.length; i++) {
        for (let j = i + 1; j < allTerms.length; j++) {
          pairs.push([allTerms[i], allTerms[j]]);
        }
      }
    }
  }

  _synonymCache = _buildBidirectionalMap(pairs);
  return _synonymCache;
}

/**
 * 동의어 캐시를 초기화한다 (테스트 전용).
 */
function _resetSynonymCache() {
  _synonymCache = null;
}

/**
 * ISO 8601 타임스탬프를 생성한다.
 * @returns {string}
 */
function isoNow() {
  return new Date().toISOString();
}

/**
 * 디렉토리를 재귀적으로 생성한다 (없으면).
 * @param {string} dirPath
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 기본 Brain 루트 경로를 반환한다.
 * 우선순위: BRAIN_ROOT 환경변수 → ~/Brain/ → cwd 탐색
 * @returns {string|null}
 */
function getDefaultBrainRoot() {
  // 1. 환경변수
  if (process.env.BRAIN_ROOT) {
    const envRoot = path.resolve(process.env.BRAIN_ROOT);
    if (fs.existsSync(path.join(envRoot, "90_index"))) return envRoot;
  }

  // 2. 홈 디렉토리 ~/Brain/
  const os = require("os");
  const homeRoot = path.join(os.homedir(), "Brain");
  if (fs.existsSync(path.join(homeRoot, "90_index"))) return homeRoot;

  // 3. cwd 기반 탐색
  return findBrainRoot(process.cwd());
}

module.exports = {
  calculateHash,
  calculateHashFromString,
  generateRecordId,
  readJsonl,
  writeJsonl,
  safeReadJson,
  findBrainRoot,
  getDefaultBrainRoot,
  generateDigestLine,
  isoNow,
  ensureDir,
  loadSynonyms,
  _resetSynonymCache,
  stemKorean,
  normalizeTokens
};
