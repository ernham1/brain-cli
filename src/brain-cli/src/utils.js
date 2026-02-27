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
 * 레코드에서 digest 텍스트 한 줄을 생성한다.
 * @param {Object} record
 * @returns {string} "recordId | title | summary | tags | status"
 */
function generateDigestLine(record) {
  const tags = Array.isArray(record.tags) ? record.tags.join(",") : "";
  return `${record.recordId} | ${record.title} | ${record.summary} | ${tags} | ${record.status}`;
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
  ensureDir
};
