"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { Worker } = require("node:worker_threads");

const execFileAsync = promisify(execFile);
const cliPath = path.join(__dirname, "../src/index.js");
const { init } = require("../src/init");
const { readJsonl } = require("../src/utils");

function createIntent(action) {
  if (action === "update") {
    return {
      action,
      recordId: "rec_test_20260723_0001",
      content: "갱신 내용",
      record: {
        title: "갱신 테스트",
        type: "log",
        tags: ["domain/dev", "intent/retrieval"],
        sourceType: "candidate",
        summary: "갱신 요약",
        scopeType: "project",
        scopeId: "test"
      }
    };
  }

  return {
    action,
    sourceRef: "10_projects/test/20260723-write-server.md",
    scopeType: "project",
    scopeId: "test",
    content: "생성 내용",
    record: {
      title: "생성 테스트",
      type: "log",
      tags: ["domain/dev", "intent/retrieval"],
      sourceType: "candidate",
      summary: "생성 요약",
      scopeType: "project",
      scopeId: "test"
    }
  };
}

async function runImplicitServerWrite(action) {
  const requests = [];
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "brain-write-server-"));
  const server = http.createServer((request, response) => {
    let rawBody = "";
    request.setEncoding("utf8");
    request.on("data", chunk => {
      rawBody += chunk;
    });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, body: rawBody });
      response.writeHead(200, { "Content-Type": "application/json" });
      if (request.url === "/api/health") {
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      response.end(JSON.stringify({
        success: true,
        recordId: "rec_test_20260723_0001",
        report: { action, recordId: "rec_test_20260723_0001", warnings: [] }
      }));
    });
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  try {
    const intent = createIntent(action);
    const result = await execFileAsync(process.execPath, [
      cliPath,
      "write",
      JSON.stringify(intent)
    ], {
      cwd: isolatedHome,
      env: {
        ...process.env,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        BRAIN_ROOT: path.join(isolatedHome, "missing-brain"),
        BRAIN_SERVER_URL: `http://127.0.0.1:${address.port}`
      },
      timeout: 8000,
      windowsHide: true
    });
    return { ...result, requests, intent };
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
}

for (const action of ["create", "update"]) {
  test(`write ${action} without a path uses the local Brain Server`, async () => {
    const { stdout, stderr, requests, intent } = await runImplicitServerWrite(action);

    assert.equal(stderr, "");
    assert.deepEqual(requests.map(request => request.url), ["/api/write"]);
    assert.deepEqual(JSON.parse(requests[0].body), intent);
    assert.match(stdout, /SUCCESS:/);
    assert.match(stdout, /rec_test_20260723_0001/);
  });
}
test("Brain Server write response does not await embedding", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "../../brain-server/index.js"), "utf8");
  const writeRoute = serverSource.slice(
    serverSource.indexOf('// --- POST /api/write'),
    serverSource.indexOf('async function buildQueryEmbeddingBestEffort')
  );

  assert.match(writeRoute, /scheduleWriteRecordEmbedding\(result\.recordId\)/);
  assert.doesNotMatch(writeRoute, /api\/health/);
  assert.doesNotMatch(writeRoute, /await embedWriteRecordBestEffort/);
});
test("rejected server write exits cleanly without a direct retry", async () => {
  const requests = [];
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "brain-write-rejected-"));
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(request.url === "/api/health" ? 200 : 422, {
      "Content-Type": "application/json"
    });
    response.end(request.url === "/api/health"
      ? JSON.stringify({ status: "ok" })
      : JSON.stringify({ success: false, report: { step: 8, message: "검증 실패" } }));
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  try {
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "write", JSON.stringify(createIntent("create"))], {
        cwd: isolatedHome,
        env: {
          ...process.env,
          HOME: isolatedHome,
          USERPROFILE: isolatedHome,
          BRAIN_ROOT: path.join(isolatedHome, "missing-brain"),
          BRAIN_SERVER_URL: `http://127.0.0.1:${address.port}`
        },
        timeout: 8000,
        windowsHide: true
      }),
      error => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /FAILED:/);
        assert.doesNotMatch(error.stderr, /Assertion failed/);
        return true;
      }
    );
    assert.deepEqual(requests, ["/api/write"]);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
});
test("write embedding worker runs outside the server thread", async () => {
  const isolatedBase = fs.mkdtempSync(path.join(os.tmpdir(), "brain-write-worker-"));
  const brainRoot = init(isolatedBase).brainRoot;
  const workerPath = path.join(__dirname, "../../brain-server/write-embedding-worker.js");
  const worker = new Worker(workerPath, { workerData: { brainRoot } });

  try {
    const messagePromise = new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    worker.postMessage({ recordId: "rec_missing" });
    const message = await messagePromise;

    assert.equal(message.ok, true);
    assert.equal(message.result.reason, "record_not_active");
  } finally {
    await worker.terminate();
    fs.rmSync(isolatedBase, { recursive: true, force: true });
  }
});
test("connection refusal before submission falls back to an isolated local Brain", async () => {
  const isolatedBase = fs.mkdtempSync(path.join(os.tmpdir(), "brain-write-fallback-"));
  const brainRoot = init(isolatedBase).brainRoot;
  const portProbe = http.createServer();
  await new Promise(resolve => portProbe.listen(0, "127.0.0.1", resolve));
  const closedPort = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const intent = createIntent("create");

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cliPath,
      "write",
      JSON.stringify(intent)
    ], {
      cwd: isolatedBase,
      env: {
        ...process.env,
        HOME: isolatedBase,
        USERPROFILE: isolatedBase,
        BRAIN_ROOT: brainRoot,
        BRAIN_SERVER_URL: `http://127.0.0.1:${closedPort}`
      },
      timeout: 8000,
      windowsHide: true
    });

    assert.match(stderr, /로컬 서버가 실행 중이 아니어서 파일 저장으로 전환/);
    assert.match(stdout, /SUCCESS:/);
    const records = readJsonl(path.join(brainRoot, "90_index", "records.jsonl"));
    assert.ok(records.some(record => record.title === intent.record.title));
  } finally {
    fs.rmSync(isolatedBase, { recursive: true, force: true });
  }
});