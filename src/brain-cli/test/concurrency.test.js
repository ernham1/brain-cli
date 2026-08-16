"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile, execSync } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const { init } = require("../src/init");
const { readJsonl } = require("../src/utils");
const { readLinks } = require("../src/links");

/**
 * 완전한 Brain 환경을 초기화한다 (BWT가 validate를 통과하도록).
 */
function createFullBrain() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-conc-"));
  const result = init(tmpDir);
  return result.brainRoot;
}

/**
 * brain-cli write를 별도 프로세스로 실행한다.
 * @param {string} brainRoot
 * @param {Object} intent
 * @returns {{ success: boolean, stdout: string, stderr: string }}
 */
function execWrite(brainRoot, intent) {
  const cliPath = path.join(__dirname, "..", "src", "index.js");
  const intentJson = JSON.stringify(intent).replace(/"/g, '\\"');
  const cmd = `node "${cliPath}" write "${intentJson}" --root "${brainRoot}"`;
  try {
    const stdout = execSync(cmd, { timeout: 15000, encoding: "utf-8" });
    return { success: true, stdout, stderr: "" };
  } catch (err) {
    return { success: false, stdout: err.stdout || "", stderr: err.stderr || "" };
  }
}

async function execWriteConcurrent(brainRoot, intent, suffix) {
  const cliPath = path.join(__dirname, "..", "src", "index.js");
  const intentPath = path.join(brainRoot, `intent-${suffix}.json`);
  fs.writeFileSync(intentPath, JSON.stringify(intent), "utf-8");
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, "write", intentPath, "--root", brainRoot],
      { timeout: 15000, encoding: "utf-8", windowsHide: true }
    );
    return { success: true, stdout, stderr };
  } catch (error) {
    return { success: false, stdout: error.stdout || "", stderr: error.stderr || error.message };
  } finally {
    try { fs.unlinkSync(intentPath); } catch { /* ignore */ }
  }
}

describe("concurrency: 동시 BWT create", () => {
  let brainRoot;

  before(() => { brainRoot = createFullBrain(); });
  after(() => { fs.rmSync(brainRoot, { recursive: true, force: true }); });

  it("2개 프로세스가 동시에 create해도 둘 다 성공한다", async () => {
    const intent1 = JSON.stringify({
      action: "create",
      sourceRef: "30_topics/conc-test/doc1.md",
      content: "동시성 테스트 문서 1",
      record: {
        scopeType: "topic", scopeId: "conc-test",
        type: "note", title: "동시성 테스트 1",
        summary: "첫 번째 동시 쓰기", sourceType: "candidate",
        tags: ["domain/memory", "intent/retrieval"]
      }
    });

    const intent2 = JSON.stringify({
      action: "create",
      sourceRef: "30_topics/conc-test/doc2.md",
      content: "동시성 테스트 문서 2",
      record: {
        scopeType: "topic", scopeId: "conc-test",
        type: "note", title: "동시성 테스트 2",
        summary: "두 번째 동시 쓰기", sourceType: "candidate",
        tags: ["domain/memory", "intent/retrieval"]
      }
    });

    const [result1, result2] = await Promise.all([
      execWriteConcurrent(brainRoot, JSON.parse(intent1), "one"),
      execWriteConcurrent(brainRoot, JSON.parse(intent2), "two"),
    ]);

    assert.ok(result1.success, `첫 번째 쓰기 실패: ${result1.stderr}`);
    assert.ok(result2.success, `두 번째 쓰기 실패: ${result2.stderr}`);

    // records.jsonl에 두 건 모두 존재하는지 확인
    const records = readJsonl(path.join(brainRoot, "90_index", "records.jsonl"));
    const concRecords = records.filter(r => r.title && r.title.startsWith("동시성 테스트"));
    assert.equal(concRecords.length, 2);
    assert.notEqual(concRecords[0].recordId, concRecords[1].recordId);
  });
});

describe("concurrency: 동시 addLink", () => {
  let brainRoot;

  before(() => { brainRoot = createFullBrain(); });
  after(() => { fs.rmSync(brainRoot, { recursive: true, force: true }); });

  it("2번 addLink 호출 후 links.jsonl에 2건이 있다", () => {
    const { addLink } = require("../src/links");
    const { _resetLockState } = require("../src/lock");

    _resetLockState();

    // 순차 호출이지만 각각 락을 잡고 해제하는 것을 검증
    const r1 = addLink(brainRoot, "rec_a", "rec_b", "related");
    const r2 = addLink(brainRoot, "rec_c", "rec_d", "related");

    assert.ok(r1.added);
    assert.ok(r2.added);

    const links = readLinks(brainRoot);
    assert.equal(links.length, 2);
  });
});

describe("concurrency: stale 락 복구", () => {
  let brainRoot;

  before(() => { brainRoot = createFullBrain(); });
  after(() => { fs.rmSync(brainRoot, { recursive: true, force: true }); });

  it("stale 락이 있어도 BWT가 정상 진행된다", () => {
    const { _lockPath, _resetLockState } = require("../src/lock");

    _resetLockState();

    // 죽은 PID로 stale 락 생성
    const lockFile = _lockPath(brainRoot);
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: 99999999,
      timestamp: new Date().toISOString()
    }), { flag: "wx" });

    // BWT 실행 — stale 감지 후 정상 진행해야 함
    const result = execWrite(brainRoot, {
      action: "create",
      sourceRef: "30_topics/stale-test/doc.md",
      content: "stale 락 복구 테스트",
      record: {
        scopeType: "topic", scopeId: "stale-test",
        type: "note", title: "stale 복구 테스트",
        summary: "stale 락 후 정상 쓰기", sourceType: "candidate",
        tags: ["domain/memory", "intent/retrieval"]
      }
    });

    assert.ok(result.success, `stale 락 후 쓰기 실패: ${result.stderr}`);

    // 락 파일이 정리되었는지 확인
    assert.ok(!fs.existsSync(lockFile), "락 파일이 남아있음");
  });
});

describe("concurrency: BWT 재진입 (autoLink 내부)", () => {
  let brainRoot;

  before(() => { brainRoot = createFullBrain(); });
  after(() => { fs.rmSync(brainRoot, { recursive: true, force: true }); });

  it("BWT create 시 autoLink이 재진입 락으로 정상 동작한다", () => {
    const { _resetLockState } = require("../src/lock");
    _resetLockState();

    // 먼저 태그가 겹치는 레코드를 생성
    const result1 = execWrite(brainRoot, {
      action: "create",
      sourceRef: "30_topics/reentrant/base.md",
      content: "재진입 테스트 기본 문서",
      record: {
        scopeType: "topic", scopeId: "reentrant",
        type: "note", title: "재진입 테스트 기본",
        summary: "autoLink 대상", sourceType: "candidate",
        tags: ["domain/memory", "intent/retrieval"]
      }
    });
    assert.ok(result1.success, `기본 레코드 생성 실패: ${result1.stderr}`);

    // 같은 태그로 두 번째 레코드 생성 → autoLink 발동 → 재진입 락
    const result2 = execWrite(brainRoot, {
      action: "create",
      sourceRef: "30_topics/reentrant/linked.md",
      content: "재진입 테스트 연결 문서",
      record: {
        scopeType: "topic", scopeId: "reentrant",
        type: "note", title: "재진입 테스트 연결",
        summary: "autoLink 발동 대상", sourceType: "candidate",
        tags: ["domain/memory", "intent/retrieval"]
      }
    });
    assert.ok(result2.success, `연결 레코드 생성 실패: ${result2.stderr}`);
  });
});
