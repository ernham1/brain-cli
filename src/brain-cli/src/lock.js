"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// 인메모리 재진입 카운트 (같은 프로세스 내 중첩 락 허용)
const _lockCounts = new Map();
const _lockTokens = new Map();

// 동기 sleep — SharedArrayBuffer + Atomics.wait
const _sharedBuf = new Int32Array(new SharedArrayBuffer(4));

/**
 * 동기적으로 ms 밀리초 대기한다.
 * @param {number} ms
 */
function _syncSleep(ms) {
  Atomics.wait(_sharedBuf, 0, 0, ms);
}

/**
 * 프로세스가 생존 중인지 확인한다.
 * Windows에서는 PID 재사용 감지를 위해 node.exe 여부도 확인한다.
 * @param {number} pid
 * @returns {boolean}
 */
function _isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // Windows PID 재사용 방어: brain-cli는 node.exe로 실행됨
  // PID가 살아있어도 node.exe가 아니면 다른 프로세스가 PID를 재사용한 것
  if (process.platform === "win32") {
    try {
      const { execSync } = require("child_process");
      const output = execSync(
        `tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
        { encoding: "utf8", windowsHide: true, timeout: 3000 }
      );
      if (!output.toLowerCase().includes("node")) return false;


    } catch {
      // tasklist/wmic 실패 시 기본 PID 체크 결과 신뢰
    }
  }
  return true;
}

/**
 * 락 파일 경로를 반환한다.
 * @param {string} brainRoot
 * @returns {string}
 */
function _lockPath(brainRoot) {
  return path.join(brainRoot, "90_index", ".brain.lock");
}

/**
 * 배타적 락을 획득한다.
 * 재진입 지원: 같은 프로세스에서 이미 잠긴 상태면 카운트만 증가한다.
 *
 * @param {string} brainRoot - Brain/ 절대 경로
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=10000] - 최대 대기 시간
 * @param {number} [options.retryIntervalMs=50] - 재시도 간격
 * @param {number} [options.staleMs=60000] - stale 판정 기준 (ms)
 * @returns {{ release: () => void }}
 * @throws {Error} 타임아웃 또는 획득 실패
 */
function acquireLock(brainRoot, options = {}) {
  const {
    timeoutMs = 10000,
    retryIntervalMs = 50,
    staleMs = 60000
  } = options;

  const key = path.resolve(brainRoot);
  const lockFile = _lockPath(brainRoot);

  // 재진입 체크: 같은 프로세스에서 이미 보유 중
  if (_lockCounts.has(key) && _lockCounts.get(key) > 0) {
    _lockCounts.set(key, _lockCounts.get(key) + 1);
    return { release: () => _releaseLockInternal(key, lockFile) };
  }

  const token = crypto.randomUUID();
  const content = JSON.stringify({
    pid: process.pid,
    timestamp: new Date().toISOString(),
    token
  });

  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      // O_CREAT | O_EXCL — 파일이 이미 존재하면 EEXIST
      fs.writeFileSync(lockFile, content, { flag: "wx" });
      _lockCounts.set(key, 1);
      _lockTokens.set(key, token);
      return { release: () => _releaseLockInternal(key, lockFile) };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;

      // 락 파일이 이미 존재 — stale 여부 확인
      if (_tryRemoveStaleLock(lockFile, staleMs)) {
        continue; // stale 제거 성공 → 재시도
      }

      if (Date.now() >= deadline) {
        let holder = "unknown";
        try {
          const raw = fs.readFileSync(lockFile, "utf-8");
          holder = raw;
        } catch { /* ignore */ }
        throw new Error(
          `Brain 락 획득 타임아웃 (${timeoutMs}ms). 현재 보유자: ${holder}`
        );
      }

      _syncSleep(retryIntervalMs);
    }
  }
}

/**
 * 락을 해제한다.
 * @param {string} brainRoot
 */
function releaseLock(brainRoot) {
  const key = path.resolve(brainRoot);
  const lockFile = _lockPath(brainRoot);
  _releaseLockInternal(key, lockFile);
}

/**
 * 내부 release 구현. 카운트 감소 후 0이면 파일 삭제.
 * @param {string} key
 * @param {string} lockFile
 */
function _releaseLockInternal(key, lockFile) {
  const count = (_lockCounts.get(key) || 1) - 1;
  if (count <= 0) {
    const token = _lockTokens.get(key);
    _lockCounts.delete(key);
    _lockTokens.delete(key);
    try {
      if (!fs.existsSync(lockFile)) return;
      const current = JSON.parse(fs.readFileSync(lockFile, "utf-8"));
      if (current.pid === process.pid && current.token === token) {
        fs.unlinkSync(lockFile);
      }
    } catch { /* 소유권을 확인할 수 없으면 다른 writer의 락을 보존 */ }
  } else {
    _lockCounts.set(key, count);
  }
}

/**
 * 락 상태를 조회한다 (진단용).
 * @param {string} brainRoot
 * @returns {{ locked: boolean, pid?: number, timestamp?: string, stale?: boolean }}
 */
function lockStatus(brainRoot) {
  const lockFile = _lockPath(brainRoot);

  if (!fs.existsSync(lockFile)) {
    return { locked: false };
  }

  try {
    const raw = fs.readFileSync(lockFile, "utf-8");
    const data = JSON.parse(raw);

    const alive = _isProcessAlive(data.pid);

    return {
      locked: true,
      pid: data.pid,
      timestamp: data.timestamp,
      stale: !alive
    };
  } catch {
    // 파싱 실패 — 손상된 락 파일
    return { locked: true, stale: true };
  }
}

/**
 * stale 락 파일을 제거한다.
 * @param {string} lockFile
 * @param {number} staleMs
 * @returns {boolean} 제거 성공 여부
 */
function _tryRemoveStaleLock(lockFile, staleMs) {
  try {
    const raw = fs.readFileSync(lockFile, "utf-8");
    const data = JSON.parse(raw);


    const alive = _isProcessAlive(data.pid);

    // A live writer may legitimately hold the lock longer than staleMs while
    // full-store validation runs. Age alone must never steal its lock.
    if (!alive) {
      fs.unlinkSync(lockFile);
      return true;
    }

    // Keep staleMs as a diagnostic/compatibility option, not an eviction rule.
    void staleMs;
  } catch (err) {
    // 파일 읽기/파싱 실패 — 손상된 락으로 간주하여 제거
    if (err.code !== "ENOENT") {
      try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
      return true;
    }
  }
  return false;
}

/**
 * 인메모리 락 카운트를 초기화한다 (테스트 전용).
 */
function _resetLockState() {
  _lockCounts.clear();
  _lockTokens.clear();
}

module.exports = {
  acquireLock,
  releaseLock,
  lockStatus,
  _resetLockState,
  _lockPath,
  _syncSleep
};
