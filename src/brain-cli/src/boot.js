"use strict";

const fs = require("fs");
const path = require("path");
const { safeReadJson, calculateHash } = require("./utils");

/**
 * Brain 부트 시퀀스 (4단계)
 *
 * 0-a) brainPolicy.md 로드
 * 0-b) manifest.json 로드
 * 0-b') 정합성 검증 (해시 비교)
 * 0-c) 스코프 선언 / userProfile 기본 로드
 *
 * @param {string} brainRoot - Brain/ 절대 경로
 * @param {Object} options
 * @param {string} options.scopeType - 스코프 타입 (선택)
 * @param {string} options.scopeId - 스코프 ID (선택)
 * @returns {{ success: boolean, policy: string|null, manifest: Object|null, mismatches: Array, warnings: string[] }}
 */
function boot(brainRoot, options = {}) {
  const warnings = [];
  const mismatches = [];

  // 0-a) brainPolicy.md 로드
  const policyPath = path.join(brainRoot, "99_policy", "brainPolicy.md");
  if (!fs.existsSync(policyPath)) {
    return {
      success: false,
      error: "brainPolicy.md를 찾을 수 없습니다.",
      policy: null,
      manifest: null,
      mismatches: [],
      warnings: []
    };
  }
  const policy = fs.readFileSync(policyPath, "utf-8");

  // 0-b) manifest.json 로드
  const manifestPath = path.join(brainRoot, "90_index", "manifest.json");
  const manifestResult = safeReadJson(manifestPath);
  if (!manifestResult.ok) {
    return {
      success: false,
      error: "manifest.json을 로드할 수 없습니다.",
      policy,
      manifest: null,
      mismatches: [],
      warnings: []
    };
  }
  const manifest = manifestResult.data;

  // 0-b') 정합성 검증 — manifest 해시와 실제 파일 해시 비교
  if (manifest.files && Array.isArray(manifest.files)) {
    for (const entry of manifest.files) {
      const filePath = path.join(brainRoot, entry.path);
      if (!fs.existsSync(filePath)) {
        mismatches.push({
          path: entry.path,
          reason: "파일 없음",
          expected: entry.hash,
          actual: null
        });
        continue;
      }
      const actualHash = calculateHash(filePath);
      if (actualHash !== entry.hash) {
        mismatches.push({
          path: entry.path,
          reason: "해시 불일치 (수동 변경 감지)",
          expected: entry.hash,
          actual: actualHash
        });
      }
    }
  }

  if (mismatches.length > 0) {
    warnings.push(
      `수동 변경 감지: ${mismatches.length}개 파일. 인덱스 동기화가 필요합니다.`
    );
  }

  // 0-c) 스코프 선언
  const scope = {
    scopeType: options.scopeType || null,
    scopeId: options.scopeId || null
  };

  // userProfile 기본 로드 (스코프 미지정 시)
  let userProfile = null;
  if (!scope.scopeType) {
    const profilePath = path.join(brainRoot, "00_user", "userProfile.md");
    if (fs.existsSync(profilePath)) {
      userProfile = fs.readFileSync(profilePath, "utf-8");
    }
  }

  return {
    success: true,
    policy,
    manifest,
    mismatches,
    warnings,
    scope,
    userProfile
  };
}

module.exports = { boot };
