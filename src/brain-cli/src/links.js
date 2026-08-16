"use strict";

const fs = require("fs");
const path = require("path");
const { readJsonl, writeJsonl, isoNow, normalizeTokens } = require("./utils");

// 링크 타입 정의
const LINK_TYPES = ["related", "replaced_by", "depends_on", "see_also"];

/**
 * links.jsonl을 읽어 링크 배열을 반환한다.
 * @param {string} brainRoot
 * @returns {Array<{fromId: string, toId: string, linkType: string, createdAt: string}>}
 */
function readLinks(brainRoot) {
  const linksPath = path.join(brainRoot, "90_index", "links.jsonl");
  return readJsonl(linksPath);
}

/**
 * 링크 배열을 links.jsonl에 저장한다.
 * @param {string} brainRoot
 * @param {Array} links
 */
function writeLinks(brainRoot, links) {
  const linksPath = path.join(brainRoot, "90_index", "links.jsonl");
  // .lnk.new 사용 — BWT가 감시하는 .tmp 확장자와 충돌 방지
  const stagePath = linksPath + ".lnk.new";
  writeJsonl(stagePath, links);
  fs.renameSync(stagePath, linksPath);
}

/**
 * 두 레코드 간 양방향 링크를 추가한다.
 * 중복 링크는 무시한다.
 * @param {string} brainRoot
 * @param {string} fromId
 * @param {string} toId
 * @param {string} linkType - "related" | "replaced_by" | "depends_on" | "see_also"
 * @returns {{ added: boolean, link: Object }}
 */
function addLink(brainRoot, fromId, toId, linkType = "related") {
  if (fromId === toId) return { added: false, link: null };
  if (!LINK_TYPES.includes(linkType)) {
    throw new Error(`Invalid linkType: ${linkType} (allowed: ${LINK_TYPES.join(", ")})`);
  }

  const { acquireLock } = require("./lock");
  const lock = acquireLock(brainRoot);
  try {
    const links = readLinks(brainRoot);

    // 중복 체크 (양방향)
    const exists = links.some(l =>
      (l.fromId === fromId && l.toId === toId) ||
      (l.fromId === toId && l.toId === fromId && l.linkType === linkType)
    );
    if (exists) return { added: false, link: null };

    const link = { fromId, toId, linkType, createdAt: isoNow() };
    links.push(link);
    writeLinks(brainRoot, links);

    return { added: true, link };
  } finally {
    lock.release();
  }
}

/**
 * 특정 레코드에 연결된 모든 링크를 조회한다.
 * @param {string} brainRoot
 * @param {string} recordId
 * @returns {Array<{linkedId: string, linkType: string, direction: string, createdAt: string}>}
 */
function getLinksFor(brainRoot, recordId) {
  const links = readLinks(brainRoot);
  const results = [];

  for (const link of links) {
    if (link.fromId === recordId) {
      results.push({
        linkedId: link.toId,
        linkType: link.linkType,
        direction: "outgoing",
        createdAt: link.createdAt
      });
    } else if (link.toId === recordId) {
      results.push({
        linkedId: link.fromId,
        linkType: link.linkType,
        direction: "incoming",
        createdAt: link.createdAt
      });
    }
  }

  return results;
}

/**
 * 레코드 ID 집합에 연결된 레코드 ID를 반환한다 (검색 부스팅용).
 * @param {string} brainRoot
 * @param {string[]} recordIds
 * @returns {Map<string, number>} linkedId → boost count
 */
function getLinkedBoosts(brainRoot, recordIds) {
  const links = readLinks(brainRoot);
  const idSet = new Set(recordIds);
  const boostMap = new Map();

  for (const link of links) {
    if (idSet.has(link.fromId) && !idSet.has(link.toId)) {
      boostMap.set(link.toId, (boostMap.get(link.toId) || 0) + 1);
    }
    if (idSet.has(link.toId) && !idSet.has(link.fromId)) {
      boostMap.set(link.fromId, (boostMap.get(link.fromId) || 0) + 1);
    }
  }

  return boostMap;
}

/**
 * 두 레코드 간의 태그 유사도를 계산한다.
 * @param {string[]} tagsA
 * @param {string[]} tagsB
 * @returns {number} 0.0 ~ 1.0
 */
function _tagOverlap(tagsA, tagsB) {
  if (!tagsA.length || !tagsB.length) return 0;
  const setA = new Set(tagsA.map(t => t.toLowerCase()));
  const setB = new Set(tagsB.map(t => t.toLowerCase()));
  let intersection = 0;
  for (const tag of setA) {
    if (setB.has(tag)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * recordId에서 scopeId를 추출한다.
 * 예: "rec_proj_clo-telegram_20260301_0001" → "clo-telegram"
 * @param {string} recordId
 * @returns {string}
 */
function _extractScopeId(recordId) {
  // rec_{scope}_{scopeId}_{YYYYMMDD}_{NNNN}
  const parts = recordId.split("_");
  if (parts.length < 5) return "";
  // scopeId는 3번째부터 날짜 직전까지 (scopeId에 _가 포함될 수 있음)
  return parts.slice(2, -2).join("_");
}

/**
 * 두 레코드 간 관계에 맞는 링크 타입을 추론한다.
 * - depends_on: 같은 scopeId + decision↔note/log 조합
 * - see_also: 다른 scopeId + 태그 겹침
 * - related: 기본값
 * @param {Object} newRecord - { recordId, type, tags }
 * @param {Object} existing - { recordId, type, tags }
 * @returns {string}
 */
function _inferLinkType(newRecord, existing) {
  const newScope = _extractScopeId(newRecord.recordId);
  const existScope = _extractScopeId(existing.recordId);
  const sameScopeId = newScope && existScope && newScope === existScope;

  if (sameScopeId) {
    // 같은 프로젝트 내 decision↔note/log → depends_on
    const types = new Set([newRecord.type, existing.type]);
    if (types.has("decision") && (types.has("note") || types.has("log"))) {
      return "depends_on";
    }
  } else if (newScope && existScope) {
    // 다른 scopeId + 태그 겹침 → see_also
    return "see_also";
  }

  return "related";
}

// autoLink 최대 링크 수 (레코드당)
const AUTO_LINK_MAX = 20;

// autoLink 제외 타입 (일지성 기록은 링크 불필요)
const AUTO_LINK_SKIP_TYPES = new Set(["log"]);

/**
 * 새 레코드 생성 시 기존 레코드들과 자동으로 링크를 생성한다.
 * 조건: 태그 Jaccard ≥ 0.5 또는 제목 토큰 겹침 ≥ 50%
 * log 타입 레코드는 링크 생성에서 제외한다 (work-log 폭발 방지).
 * 레코드당 최대 AUTO_LINK_MAX개까지만 생성한다.
 * @param {string} brainRoot
 * @param {Object} newRecord - 새로 생성된 레코드
 * @param {Object[]} existingDigest - 기존 digest 레코드 배열
 * @returns {number} 생성된 링크 수
 */
function autoLink(brainRoot, newRecord, existingDigest) {
  // log 타입은 autoLink 제외 — 일지성 기록 간 O(N²) 링크 폭발 방지
  if (AUTO_LINK_SKIP_TYPES.has(newRecord.type)) return 0;

  const { acquireLock } = require("./lock");
  const lock = acquireLock(brainRoot);
  try {
    let linkCount = 0;
    const newTags = newRecord.tags || [];
    const newTitleTokens = new Set(normalizeTokens(newRecord.title || ""));

    for (const existing of existingDigest) {
      if (linkCount >= AUTO_LINK_MAX) break;
      if (existing.recordId === newRecord.recordId) continue;
      if (existing.status !== "active") continue;
      if (AUTO_LINK_SKIP_TYPES.has(existing.type)) continue;

      // 태그 유사도 체크
      const tagSim = _tagOverlap(newTags, existing.tags || []);

      // 제목 토큰 겹침 체크
      const existTitleTokens = new Set(normalizeTokens(existing.title || ""));
      let titleOverlap = 0;
      if (newTitleTokens.size > 0 && existTitleTokens.size > 0) {
        let common = 0;
        for (const t of newTitleTokens) {
          if (existTitleTokens.has(t)) common++;
        }
        titleOverlap = common / Math.min(newTitleTokens.size, existTitleTokens.size);
      }

      if (tagSim >= 0.5 || titleOverlap >= 0.5) {
        const linkType = _inferLinkType(newRecord, existing);
        // addLink 내부에서 재진입 락 — 데드락 없음
        const result = addLink(brainRoot, newRecord.recordId, existing.recordId, linkType);
        if (result.added) linkCount++;
      }
    }

    return linkCount;
  } finally {
    lock.release();
  }
}

/**
 * 링크를 제거한다.
 * @param {string} brainRoot
 * @param {string} fromId
 * @param {string} toId
 * @returns {boolean} 제거 여부
 */
function removeLink(brainRoot, fromId, toId) {
  const { acquireLock } = require("./lock");
  const lock = acquireLock(brainRoot);
  try {
    const links = readLinks(brainRoot);
    const before = links.length;
    const filtered = links.filter(l =>
      !((l.fromId === fromId && l.toId === toId) ||
        (l.fromId === toId && l.toId === fromId))
    );
    if (filtered.length === before) return false;
    writeLinks(brainRoot, filtered);
    return true;
  } finally {
    lock.release();
  }
}

// 자동 compact 임계값 (bytes)
const COMPACT_THRESHOLD_BYTES = 1 * 1024 * 1024; // 1MB

/**
 * links.jsonl에서 고아 링크와 log×log 링크를 제거한다.
 * 임계값 초과 시 자동 호출되거나 수동으로 실행할 수 있다.
 * @param {string} brainRoot
 * @param {Object[]} activeRecords - records.jsonl의 활성 레코드 배열
 * @returns {{ before: number, after: number }} 정리 전후 링크 수
 */
function compactLinks(brainRoot, activeRecords) {
  const { acquireLock } = require("./lock");
  const lock = acquireLock(brainRoot);
  try {
    const activeIds = new Set(activeRecords.filter(r => r.status === "active").map(r => r.recordId));
    const logTypeIds = new Set(activeRecords.filter(r => r.type === "log").map(r => r.recordId));

    const links = readLinks(brainRoot);
    const before = links.length;

    const seen = new Set();
    const filtered = links.filter(link => {
      if (!activeIds.has(link.fromId) || !activeIds.has(link.toId)) return false;
      if (logTypeIds.has(link.fromId) && logTypeIds.has(link.toId)) return false;
      const key = [link.fromId, link.toId, link.linkType].sort().join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    writeLinks(brainRoot, filtered);
    return { before, after: filtered.length };
  } finally {
    lock.release();
  }
}

/**
 * links.jsonl 크기가 임계값을 초과하는지 확인한다.
 * @param {string} brainRoot
 * @returns {boolean}
 */
function isCompactNeeded(brainRoot) {
  try {
    const linksPath = path.join(brainRoot, "90_index", "links.jsonl");
    if (!fs.existsSync(linksPath)) return false;
    return fs.statSync(linksPath).size > COMPACT_THRESHOLD_BYTES;
  } catch {
    return false;
  }
}

module.exports = {
  LINK_TYPES,
  COMPACT_THRESHOLD_BYTES,
  readLinks,
  writeLinks,
  addLink,
  compactLinks,
  isCompactNeeded,
  getLinksFor,
  getLinkedBoosts,
  autoLink,
  removeLink,
  _tagOverlap,
  _extractScopeId,
  _inferLinkType
};
