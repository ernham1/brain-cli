"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  acquireLock,
  releaseLock,
  lockStatus,
  _resetLockState,
  _lockPath
} = require("../src/lock");

function createTmpBrain() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-lock-"));
  const indexDir = path.join(tmpDir, "90_index");
  fs.mkdirSync(indexDir, { recursive: true });
  return tmpDir;
}

describe("lock: acquireLock + release", () => {
  let brainRoot;

  before(() => { brainRoot = createTmpBrain(); });
  after(() => { fs.rmSync(brainRoot, { recursive: true, force: true }); });
  beforeEach(() => { _resetLockState(); });

  it("락 획득 후 .brain.lock 파일이 생성된다", () => {
    const lock = acquireLock(brainRoot);
    const lockFile = _lockPath(brainRoot);
    assert.ok(fs.existsSync(lockFile));

    const data = JSON.parse(fs.readFileSync(lockFile, "utf-8"));
    assert.equal(data.pid, process.pid);
    assert.ok(data.timestamp);
    assert.ok(data.token);

    lock.release();
    assert.ok(!fs.existsSync(lockFile));
  });

  it("이전 owner의 늦은 release가 교체된 락을 삭제하지 않는다", () => {
    const lock = acquireLock(brainRoot);
    const lockFile = _lockPath(brainRoot);
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: process.pid,
      timestamp: new Date().toISOString(),
      token: "replacement-owner"
    }), "utf-8");

    lock.release();
    assert.ok(fs.existsSync(lockFile));
    fs.unlinkSync(lockFile);
  });
  it("release 후 다시 acquire할 수 있다", () => {
    const lock1 = acquireLock(brainRoot);
    lock1.release();

    const lock2 = acquireLock(brainRoot);
    lock2.release();
  });

  it("releaseLock(brainRoot)으로도 해제할 수 있다", () => {
    acquireLock(brainRoot);
    releaseLock(brainRoot);

    const lockFile = _lockPath(brainRoot);
    assert.ok(!fs.existsSync(lockFile));
  });
});

describe("lock: 재진입 (reentrant)", () => {
  let brainRoot;

  before(() => { brainRoot = createTmpBrain(); });
  after(() => { fs.rmSync(brainRoot, { recursive: true, force: true }); });
  beforeEach(() => { _resetLockState(); });

  it("같은 프로세스에서 2번 acquire해도 데드락이 없다", () => {
    const lock1 = acquireLock(brainRoot);
    const lock2 = acquireLock(brainRoot);

    // 락 파일 존재
    assert.ok(fs.existsSync(_lockPath(brainRoot)));

    // 첫 번째 release — 아직 파일 유지
    lock2.release();
    assert.ok(fs.existsSync(_lockPath(brainRoot)));

    // 두 번째 release — 파일 삭제
    lock1.release();
    assert.ok(!fs.existsSync(_lockPath(brainRoot)));
  });

  it("3중 재진입도 정상 동작한다", () => {
    const lock1 = acquireLock(brainRoot);
    const lock2 = acquireLock(brainRoot);
    const lock3 = acquireLock(brainRoot);

    lock3.release();
    assert.ok(fs.existsSync(_lockPath(brainRoot)));

    lock2.release();
    assert.ok(fs.existsSync(_lockPath(brainRoot)));

    lock1.release();
    assert.ok(!fs.existsSync(_lockPath(brainRoot)));
  });
});

describe("lock: stale 감지", () => {
  let brainRoot;

  before(() => { brainRoot = createTmpBrain(); });
  after(() => { fs.rmSync(brainRoot, { recursive: true, force: true }); });
  beforeEach(() => { _resetLockState(); });

  it("timestamp가 오래돼도 보유 PID가 살아 있으면 락을 빼앗지 않는다", () => {
    const lockFile = _lockPath(brainRoot);
    const staleContent = JSON.stringify({
      pid: process.pid,
      timestamp: new Date(Date.now() - 120000).toISOString()
    });
    fs.writeFileSync(lockFile, staleContent, { flag: "wx" });

    assert.throws(
      () => acquireLock(brainRoot, { staleMs: 10, timeoutMs: 100, retryIntervalMs: 20 }),
      error => error.message.includes("타임아웃")
    );
    fs.unlinkSync(lockFile);
  });

  it("존재하지 않는 PID의 락은 stale로 간주된다", () => {
    const lockFile = _lockPath(brainRoot);
    const deadPid = 99999999; // 거의 확실히 없는 PID
    const content = JSON.stringify({
      pid: deadPid,
      timestamp: new Date().toISOString() // 방금 생성
    });
    fs.writeFileSync(lockFile, content, { flag: "wx" });

    const lock = acquireLock(brainRoot);
    assert.ok(fs.existsSync(lockFile));
    lock.release();
  });

  it("손상된 락 파일도 stale로 간주된다", () => {
    const lockFile = _lockPath(brainRoot);
    fs.writeFileSync(lockFile, "invalid json{{{", { flag: "wx" });

    const lock = acquireLock(brainRoot);
    assert.ok(fs.existsSync(lockFile));
    lock.release();
  });
});

describe("lock: 타임아웃", () => {
  let brainRoot;

  before(() => { brainRoot = createTmpBrain(); });
  after(() => {
    // 테스트 후 정리
    const lockFile = _lockPath(brainRoot);
    try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
    fs.rmSync(brainRoot, { recursive: true, force: true });
  });
  beforeEach(() => { _resetLockState(); });

  it("활성 락이 있으면 타임아웃 에러를 발생시킨다", () => {
    const lockFile = _lockPath(brainRoot);
    // 현재 프로세스의 살아있는 PID로 락 생성
    const content = JSON.stringify({
      pid: process.pid,
      timestamp: new Date().toISOString()
    });
    fs.writeFileSync(lockFile, content, { flag: "wx" });

    assert.throws(
      () => acquireLock(brainRoot, { timeoutMs: 200, retryIntervalMs: 50 }),
      (err) => err.message.includes("타임아웃")
    );
  });
});

describe("lock: lockStatus", () => {
  let brainRoot;

  before(() => { brainRoot = createTmpBrain(); });
  after(() => { fs.rmSync(brainRoot, { recursive: true, force: true }); });
  beforeEach(() => { _resetLockState(); });

  it("잠기지 않은 상태를 반환한다", () => {
    const status = lockStatus(brainRoot);
    assert.equal(status.locked, false);
    assert.equal(status.pid, undefined);
  });

  it("잠긴 상태를 반환한다", () => {
    const lock = acquireLock(brainRoot);

    const status = lockStatus(brainRoot);
    assert.equal(status.locked, true);
    assert.equal(status.pid, process.pid);
    assert.equal(status.stale, false);

    lock.release();
  });

  it("stale 락을 감지한다", () => {
    const lockFile = _lockPath(brainRoot);
    const content = JSON.stringify({
      pid: 99999999,
      timestamp: new Date(Date.now() - 120000).toISOString()
    });
    fs.writeFileSync(lockFile, content, "utf-8");

    const status = lockStatus(brainRoot);
    assert.equal(status.locked, true);
    assert.equal(status.stale, true);

    // 정리
    fs.unlinkSync(lockFile);
  });
});
