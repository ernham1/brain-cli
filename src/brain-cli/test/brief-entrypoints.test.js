"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const { spawn } = require("child_process");
const { setInterval, clearInterval } = require("timers");
const { writeJsonl } = require("../src/utils");
const { upsertFact } = require("../src/fact-ledger");
const { indexObsidian } = require("../src/obsidian-connector");
const { indexDepthForSource } = require("../src/depth-retriever");
const {
  createGrowthPromotionProposal,
  createGrowthRegressionCase,
  listGrowthCandidates,
  reviewGrowthCandidate,
  reviewGrowthPromotionProposal,
  runGrowthRegressionCase,
  upsertGrowthSignal
} = require("../src/growth-signal");

let testRoot;

function setupRoot() {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-brief-entrypoints-"));
  fs.mkdirSync(path.join(testRoot, "90_index"), { recursive: true });
  fs.writeFileSync(path.join(testRoot, "90_index", "records_digest.txt"), [
    "rec_proj_agentforge_20260511_0001 | 밴딩AI HTML 산출물 | 밴딩AI는 HTML 산출물을 지원한다 | domain/dev,intent/retrieval | active | project_state | user_confirmed | 2026-05-11T00:00:00.000Z"
  ].join("\n") + "\n", "utf-8");
  writeJsonl(path.join(testRoot, "90_index", "records.jsonl"), []);
  upsertFact(testRoot, {
    scopeId: "agentforge",
    subject: "AgentForge",
    predicate: "supports",
    object: "HTML artifact generation",
    sourceRefs: ["test/brief-entrypoints"],
    sourceType: "user_confirmed"
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function waitForHealth(port) {
  const url = `http://127.0.0.1:${port}/api/health`;
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      try {
        const response = await globalThis.fetch(url);
        if (response.ok) {
          clearInterval(timer);
          resolve();
        }
      } catch {
        if (Date.now() - startedAt > 3000) {
          clearInterval(timer);
          reject(new Error(`Brain server health 대기 시간 초과: ${url}`));
        }
      }
    }, 50);
  });
}

function seedGrowthCandidate(scopeId = "agentforge") {
  const signal = {
    scopeId,
    source: "answer_guard",
    failureType: "known_capability_as_new_suggestion",
    summary: "HTML 산출물을 새 기능처럼 반복 제안함",
    evidenceRefs: ["test/growth-candidates"],
    guardReasons: ["avoid_repeating_as_new"],
    detectorStatus: "use_with_citations",
    detectorReasons: ["known_capability_already_present"],
    recommendedUse: { avoidRepeatingAsNew: true },
    suggestedFix: "이미 있는 HTML 산출물 기능과 연결해 답한다."
  };
  upsertGrowthSignal(testRoot, signal);
  upsertGrowthSignal(testRoot, signal);
}

function runCli(args) {
  const cliPath = path.join(__dirname, "..", "src", "index.js");
  const child = spawn(process.execPath, [cliPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });

  return new Promise(resolve => {
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

describe("Memory Brief entrypoint contract", () => {
  beforeEach(setupRoot);
  afterEach(() => {
    if (testRoot) fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("CLI brief JSON은 Evidence Detector 필드를 보존한다", async () => {
    const cliPath = path.join(__dirname, "..", "src", "index.js");
    const child = spawn(process.execPath, [
      cliPath,
      "brief",
      "--project", "agentforge",
      "--goal", "밴딩AI에 HTML 산출물을 넣으면 좋을까?",
      "--brain", testRoot
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });

    const code = await new Promise(resolve => child.on("close", resolve));
    assert.equal(code, 0, stderr);

    const brief = JSON.parse(stdout);
    assert.ok(brief.sections.evidenceDigest.detector);
    assert.equal(brief.sections.evidenceDigest.detector.recommendedUse.avoidRepeatingAsNew, true);
    assert.ok(brief.sections.evidenceDigest.detector.analyzerCount >= 2);
    assert.ok(Array.isArray(brief.sections.memoryGraph.activatedNodes));
    assert.ok(brief.sections.memoryGraph.inhibitionSignals.some(signal => signal.signal === "avoid_repeating_existing_capability"));
    assert.equal(brief.sections.smartMemory.schemaVersion, "smart-memory/v1");
    assert.equal(brief.sections.smartMemory.answerPolicy.avoidRepeatingExistingCapability, true);
    assert.ok(brief.sections.smartMemory.decisions.some(decision => decision.decision === "use_as_current"));
  });

  it("CLI growth candidates JSON은 promotionCandidate를 별도 목록으로 노출한다", async () => {
    seedGrowthCandidate();
    seedGrowthCandidate("other-scope");
    const cliPath = path.join(__dirname, "..", "src", "index.js");
    const child = spawn(process.execPath, [
      cliPath,
      "growth",
      "candidates",
      "--scope", "agentforge",
      "--brain", testRoot
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });

    const code = await new Promise(resolve => child.on("close", resolve));
    assert.equal(code, 0, stderr);

    const body = JSON.parse(stdout);
    assert.equal(body.total, 1);
    assert.equal(body.candidates[0].scopeId, "agentforge");
    assert.equal(body.candidates[0].promotionCandidate.candidateType, "capability_patch");
    assert.equal(JSON.stringify(body).includes("이 오픈소스를 활용해"), false);
  });

  it("CLI memory-graph 명령은 seed, brief, inspect, evaluate를 제공한다", async () => {
    const obsidianRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brief-entrypoint-obsidian-"));
    try {
      fs.writeFileSync(path.join(obsidianRoot, "AgentForge-HTML.md"), [
        "---",
        "doc_type: design",
        "scope_id: agentforge",
        "scope: agentforge",
        "status: final",
        "authority: high",
        "---",
        "# AgentForge HTML",
        "밴딩AI는 HTML 산출물을 지원한다."
      ].join("\n"), "utf-8");
      const indexed = indexObsidian(testRoot, { root: obsidianRoot, scope: "agentforge" });
      indexDepthForSource(testRoot, indexed.sources[0].sourceId);

      const seed = await runCli(["memory-graph", "seed", "--scope", "agentforge", "--brain", testRoot]);
      assert.equal(seed.code, 0, seed.stderr);
      assert.ok(JSON.parse(seed.stdout).seededNodes > 0);

      const brief = await runCli([
        "memory-graph", "brief",
        "--scope", "agentforge",
        "--goal", "신규 오픈소스 HTML 분석",
        "--brain", testRoot
      ]);
      assert.equal(brief.code, 0, brief.stderr);
      assert.ok(JSON.parse(brief.stdout).activatedNodes.length > 0);

      const inspect = await runCli(["memory-graph", "inspect", "--scope", "agentforge", "--brain", testRoot]);
      assert.equal(inspect.code, 0, inspect.stderr);
      assert.ok(JSON.parse(inspect.stdout).nodes > 0);

      const evaluation = await runCli([
        "memory-graph", "evaluate",
        "--scope", "agentforge",
        "--goal", "신규 오픈소스 HTML 분석",
        "--brain", testRoot
      ]);
      assert.equal(evaluation.code, 0, evaluation.stderr);
      assert.equal(JSON.parse(evaluation.stdout).status, "passed");
    } finally {
      fs.rmSync(obsidianRoot, { recursive: true, force: true });
    }
  });

  it("CLI growth review는 candidate를 승인하고 기본 후보 목록에서 제외한다", async () => {
    seedGrowthCandidate();
    const signalId = listGrowthCandidates(testRoot, "agentforge")[0].signalId;
    const cliPath = path.join(__dirname, "..", "src", "index.js");
    const child = spawn(process.execPath, [
      cliPath,
      "growth",
      "review",
      "--signal", signalId,
      "--decision", "approved",
      "--reviewer", "entrypoint-test",
      "--reason", "검토 완료",
      "--brain", testRoot
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });

    const code = await new Promise(resolve => child.on("close", resolve));
    assert.equal(code, 0, stderr);

    const body = JSON.parse(stdout);
    assert.equal(body.signal.promotionCandidate.status, "approved");
    assert.equal(body.decision.decision, "approved");
    assert.equal(body.decision.reviewer, "entrypoint-test");
    assert.equal(listGrowthCandidates(testRoot, "agentforge").length, 0);
  });

  it("CLI growth regression-case는 approved candidate에서 회귀 케이스를 생성한다", async () => {
    seedGrowthCandidate();
    const signalId = listGrowthCandidates(testRoot, "agentforge")[0].signalId;
    reviewGrowthCandidate(testRoot, {
      signalId,
      decision: "approved",
      reviewer: "entrypoint-test"
    });
    const cliPath = path.join(__dirname, "..", "src", "index.js");
    const child = spawn(process.execPath, [
      cliPath,
      "growth",
      "regression-case",
      "--signal", signalId,
      "--created-by", "entrypoint-test",
      "--reason", "회귀 케이스 생성",
      "--brain", testRoot
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });

    const code = await new Promise(resolve => child.on("close", resolve));
    assert.equal(code, 0, stderr);

    const body = JSON.parse(stdout);
    assert.equal(body.created, true);
    assert.equal(body.case.signalId, signalId);
    assert.equal(body.case.candidateType, "capability_patch");
    assert.equal(body.case.sourceDecision.status, "approved");
  });

  it("CLI growth run-regression은 회귀 케이스 실행 결과를 남긴다", async () => {
    seedGrowthCandidate();
    const signalId = listGrowthCandidates(testRoot, "agentforge")[0].signalId;
    reviewGrowthCandidate(testRoot, {
      signalId,
      decision: "approved",
      reviewer: "entrypoint-test"
    });
    const regression = createGrowthRegressionCase(testRoot, {
      signalId,
      createdBy: "entrypoint-test"
    });
    const cliPath = path.join(__dirname, "..", "src", "index.js");
    const child = spawn(process.execPath, [
      cliPath,
      "growth",
      "run-regression",
      "--case", regression.case.caseId,
      "--runner", "entrypoint-test",
      "--reason", "회귀 케이스 실행",
      "--brain", testRoot
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });

    const code = await new Promise(resolve => child.on("close", resolve));
    assert.equal(code, 0, stderr);

    const body = JSON.parse(stdout);
    assert.equal(body.result.status, "passed");
    assert.equal(body.case.status, "executed_passed");
    assert.equal(body.case.lastRun.resultId, body.result.resultId);
  });

  it("CLI growth propose-promotion은 passed regression case에서 proposal을 생성한다", async () => {
    seedGrowthCandidate();
    const signalId = listGrowthCandidates(testRoot, "agentforge")[0].signalId;
    reviewGrowthCandidate(testRoot, {
      signalId,
      decision: "approved",
      reviewer: "entrypoint-test"
    });
    const regression = createGrowthRegressionCase(testRoot, {
      signalId,
      createdBy: "entrypoint-test"
    });
    runGrowthRegressionCase(testRoot, {
      caseId: regression.case.caseId,
      runner: "entrypoint-test"
    });
    const cliPath = path.join(__dirname, "..", "src", "index.js");
    const child = spawn(process.execPath, [
      cliPath,
      "growth",
      "propose-promotion",
      "--case", regression.case.caseId,
      "--created-by", "entrypoint-test",
      "--reason", "promotion proposal 생성",
      "--brain", testRoot
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });

    const code = await new Promise(resolve => child.on("close", resolve));
    assert.equal(code, 0, stderr);

    const body = JSON.parse(stdout);
    assert.equal(body.created, true);
    assert.equal(body.proposal.caseId, regression.case.caseId);
    assert.equal(body.proposal.status, "proposal");
    assert.equal(body.proposal.gate.lastRunStatus, "passed");
  });

  it("CLI growth review-proposal은 proposal review decision을 남긴다", async () => {
    seedGrowthCandidate();
    const signalId = listGrowthCandidates(testRoot, "agentforge")[0].signalId;
    reviewGrowthCandidate(testRoot, {
      signalId,
      decision: "approved",
      reviewer: "entrypoint-test"
    });
    const regression = createGrowthRegressionCase(testRoot, {
      signalId,
      createdBy: "entrypoint-test"
    });
    runGrowthRegressionCase(testRoot, {
      caseId: regression.case.caseId,
      runner: "entrypoint-test"
    });
    const proposal = createGrowthPromotionProposal(testRoot, {
      caseId: regression.case.caseId,
      createdBy: "entrypoint-test"
    });
    const cliPath = path.join(__dirname, "..", "src", "index.js");
    const child = spawn(process.execPath, [
      cliPath,
      "growth",
      "review-proposal",
      "--proposal", proposal.proposal.proposalId,
      "--decision", "approved",
      "--reviewer", "entrypoint-test",
      "--reason", "promotion proposal 승인",
      "--brain", testRoot
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });

    const code = await new Promise(resolve => child.on("close", resolve));
    assert.equal(code, 0, stderr);

    const body = JSON.parse(stdout);
    assert.equal(body.proposal.status, "approved");
    assert.equal(body.proposal.proposalId, proposal.proposal.proposalId);
    assert.equal(body.decision.decision, "approved");
    assert.equal(body.decision.reviewer, "entrypoint-test");
  });

  it("CLI growth apply-proposal은 approved proposal을 적용한다", async () => {
    seedGrowthCandidate();
    const signalId = listGrowthCandidates(testRoot, "agentforge")[0].signalId;
    reviewGrowthCandidate(testRoot, {
      signalId,
      decision: "approved",
      reviewer: "entrypoint-test"
    });
    const regression = createGrowthRegressionCase(testRoot, {
      signalId,
      createdBy: "entrypoint-test"
    });
    runGrowthRegressionCase(testRoot, {
      caseId: regression.case.caseId,
      runner: "entrypoint-test"
    });
    const proposal = createGrowthPromotionProposal(testRoot, {
      caseId: regression.case.caseId,
      createdBy: "entrypoint-test"
    });
    reviewGrowthPromotionProposal(testRoot, {
      proposalId: proposal.proposal.proposalId,
      decision: "approved",
      reviewer: "entrypoint-test"
    });
    const cliPath = path.join(__dirname, "..", "src", "index.js");
    const child = spawn(process.execPath, [
      cliPath,
      "growth",
      "apply-proposal",
      "--proposal", proposal.proposal.proposalId,
      "--applied-by", "entrypoint-test",
      "--reason", "approved proposal 적용",
      "--brain", testRoot
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });

    const code = await new Promise(resolve => child.on("close", resolve));
    assert.equal(code, 0, stderr);

    const body = JSON.parse(stdout);
    assert.equal(body.applied, true);
    assert.equal(body.proposal.status, "applied");
    assert.equal(body.promotion.status, "applied");
    assert.equal(body.promotion.appliedTargets[0].type, "active_state_capability");

    const exportChild = spawn(process.execPath, [
      cliPath,
      "growth",
      "project-export",
      "--scope", "agentforge",
      "--brain", testRoot
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let exportStdout = "";
    let exportStderr = "";
    exportChild.stdout.setEncoding("utf-8");
    exportChild.stderr.setEncoding("utf-8");
    exportChild.stdout.on("data", chunk => { exportStdout += chunk; });
    exportChild.stderr.on("data", chunk => { exportStderr += chunk; });

    const exportCode = await new Promise(resolve => exportChild.on("close", resolve));
    assert.equal(exportCode, 0, exportStderr);
    const exportBody = JSON.parse(exportStdout);
    assert.equal(exportBody.adapter, "project");
    assert.equal(exportBody.total, 1);
    assert.equal(exportBody.promotions[0].target.targetType, "capability_registry");
    assert.equal(exportBody.promotions[0].payload.capability.sourceProposalId, proposal.proposal.proposalId);

    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-cli-consumer-"));
    const registryPath = path.join(testRoot, "47_growth", "cli-adapter-registry.json");
    fs.writeFileSync(registryPath, JSON.stringify({
      schemaVersion: "project-adapter-registry/v1",
      projects: {
        agentforge: {
          targets: {
            capability_registry: {
              path: "native/capabilities.json",
              format: "json_array",
              mode: "upsert",
              key: "id"
            }
          }
        }
      }
    }, null, 2), "utf-8");
    try {
      const consumeChild = spawn(process.execPath, [
        cliPath,
        "growth",
        "consume-project-export",
        "--scope", "agentforge",
        "--project-root", projectRoot,
        "--mode", "dry_run",
        "--promotion", exportBody.promotions[0].promotionId,
        "--adapter-registry", registryPath,
        "--brain", testRoot
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });

      let consumeStdout = "";
      let consumeStderr = "";
      consumeChild.stdout.setEncoding("utf-8");
      consumeChild.stderr.setEncoding("utf-8");
      consumeChild.stdout.on("data", chunk => { consumeStdout += chunk; });
      consumeChild.stderr.on("data", chunk => { consumeStderr += chunk; });

      const consumeCode = await new Promise(resolve => consumeChild.on("close", resolve));
      assert.equal(consumeCode, 0, consumeStderr);
      const consumeBody = JSON.parse(consumeStdout);
      assert.equal(consumeBody.status, "preview_ready");
      assert.equal(consumeBody.changes[0].targetType, "capability_registry");
      assert.equal(consumeBody.changes[0].format, "json_array");
      assert.equal(consumeBody.changes[0].relativePath, path.join("native", "capabilities.json"));
      assert.equal(fs.existsSync(path.join(projectRoot, "native", "capabilities.json")), false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("HTTP /api/brief 응답은 Evidence Detector 필드를 보존한다", async () => {
    const port = await freePort();
    const serverPath = path.resolve(__dirname, "..", "..", "brain-server", "index.js");
    const child = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        PORT: String(port),
        BRAIN_ROOT: testRoot,
        BRAIN_API_KEY: ""
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    try {
      await waitForHealth(port);
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/api/brief`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: "agentforge",
          goal: "밴딩AI에 HTML 산출물을 넣으면 좋을까?",
          channelMode: "codex_local"
        })
      });
      assert.equal(response.status, 200);
      const body = await response.json();

      assert.equal(body.success, true);
      assert.ok(body.brief.sections.evidenceDigest.detector);
      assert.equal(body.brief.sections.evidenceDigest.detector.recommendedUse.avoidRepeatingAsNew, true);
      assert.ok(Array.isArray(body.brief.sections.memoryGraph.activatedNodes));
      assert.equal(body.brief.sections.smartMemory.schemaVersion, "smart-memory/v1");
      assert.equal(body.brief.sections.smartMemory.answerPolicy.avoidRepeatingExistingCapability, true);
    } finally {
      child.kill();
    }
  });

  it("HTTP /api/smart-memory/proposals 응답은 Guard proposal을 반환한다", async () => {
    const port = await freePort();
    const serverPath = path.resolve(__dirname, "..", "..", "brain-server", "index.js");
    const child = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        PORT: String(port),
        BRAIN_ROOT: testRoot,
        BRAIN_API_KEY: ""
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    try {
      await waitForHealth(port);
      const briefResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/brief`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: "agentforge",
          goal: "신규 오픈소스를 분석해줘",
          channelMode: "desktop_claude"
        })
      });
      assert.equal(briefResponse.status, 200);
      const briefBody = await briefResponse.json();
      const guardResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/guard`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brief: briefBody.brief,
          draftText: "이 오픈소스를 활용해 HTML 산출물 기능을 밴딩AI에 추가하면 좋겠습니다."
        })
      });
      assert.equal(guardResponse.status, 200);
      const guardBody = await guardResponse.json();
      assert.equal(guardBody.result.status, "revise_required");

      const response = await globalThis.fetch(`http://127.0.0.1:${port}/api/smart-memory/proposals?scope=agentforge`);
      assert.equal(response.status, 200);
      const body = await response.json();

      assert.equal(body.success, true);
      assert.equal(body.total, 1);
      assert.equal(body.proposals[0].schemaVersion, "smart-memory-learning-proposal/v1");
      assert.equal(body.proposals[0].eventType, "memory_prevented_error");
      assert.equal(body.proposals[0].status, "proposal");

      const proposalId = body.proposals[0].proposalId;
      const reviewResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/smart-memory/proposals/${proposalId}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision: "approved",
          reviewer: "http-test",
          reason: "Smart Memory proposal 승인"
        })
      });
      assert.equal(reviewResponse.status, 200);
      const reviewBody = await reviewResponse.json();
      assert.equal(reviewBody.success, true);
      assert.equal(reviewBody.result.proposal.status, "approved");
      assert.equal(reviewBody.result.decision.reviewer, "http-test");

      const applyResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/smart-memory/proposals/${proposalId}/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appliedBy: "http-test",
          reason: "approved proposal 적용"
        })
      });
      const duplicateApplyResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/smart-memory/proposals/${proposalId}/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appliedBy: "http-test" })
      });
      assert.equal(applyResponse.status, 200);
      assert.equal(duplicateApplyResponse.status, 200);
      const applyBody = await applyResponse.json();
      const duplicateApplyBody = await duplicateApplyResponse.json();
      assert.equal(applyBody.success, true);
      assert.equal(applyBody.result.applied, true);
      assert.equal(applyBody.result.proposal.status, "applied");
      assert.match(applyBody.result.application.status, /^applied/);
      assert.ok(applyBody.result.application.policy);
      assert.equal(duplicateApplyBody.result.applied, false);
      assert.equal(duplicateApplyBody.result.application.applicationId, applyBody.result.application.applicationId);

      const policyResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/smart-memory/policy?scope=agentforge`);
      assert.equal(policyResponse.status, 200);
      const policyBody = await policyResponse.json();
      assert.equal(policyBody.success, true);
      assert.equal(policyBody.policy.scopeId, "agentforge");
      assert.ok(policyBody.policy.inhibitionSignals.some(signal => signal.signal === "avoid_repeating_existing_capability"));

      const evaluationResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/smart-memory/evaluate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scopeId: "agentforge",
          seedDefaults: true
        })
      });
      assert.equal(evaluationResponse.status, 200);
      const evaluationBody = await evaluationResponse.json();
      assert.equal(evaluationBody.success, true);
      assert.equal(evaluationBody.result.status, "passed");
      assert.equal(evaluationBody.result.total, 2);

      const casesResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/smart-memory/evaluation-cases?scope=agentforge`);
      assert.equal(casesResponse.status, 200);
      const casesBody = await casesResponse.json();
      assert.equal(casesBody.success, true);
      assert.equal(casesBody.total, 2);
    } finally {
      child.kill();
    }
  });

  it("HTTP /api/growth/candidates 응답은 scope별 후보를 반환한다", async () => {
    seedGrowthCandidate();
    seedGrowthCandidate("other-scope");
    const port = await freePort();
    const serverPath = path.resolve(__dirname, "..", "..", "brain-server", "index.js");
    const child = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        PORT: String(port),
        BRAIN_ROOT: testRoot,
        BRAIN_API_KEY: ""
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    try {
      await waitForHealth(port);
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/api/growth/candidates?scope=agentforge`);
      assert.equal(response.status, 200);
      const body = await response.json();

      assert.equal(body.success, true);
      assert.equal(body.total, 1);
      assert.equal(body.candidates[0].scopeId, "agentforge");
      assert.equal(body.candidates[0].promotionCandidate.status, "candidate");
      assert.equal(body.candidates[0].promotionCandidate.candidateType, "capability_patch");
    } finally {
      child.kill();
    }
  });

  it("HTTP candidate review는 dismissed 상태와 decision log를 반환한다", async () => {
    seedGrowthCandidate();
    const signalId = listGrowthCandidates(testRoot, "agentforge")[0].signalId;
    const port = await freePort();
    const serverPath = path.resolve(__dirname, "..", "..", "brain-server", "index.js");
    const child = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        PORT: String(port),
        BRAIN_ROOT: testRoot,
        BRAIN_API_KEY: ""
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    try {
      await waitForHealth(port);
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/api/growth/candidates/${signalId}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision: "dismissed",
          reviewer: "http-test",
          reason: "이번 후보는 보류"
        })
      });
      assert.equal(response.status, 200);
      const body = await response.json();

      assert.equal(body.success, true);
      assert.equal(body.result.signal.promotionCandidate.status, "dismissed");
      assert.equal(body.result.decision.decision, "dismissed");
      assert.equal(body.result.decision.reviewer, "http-test");

      const candidates = await globalThis.fetch(`http://127.0.0.1:${port}/api/growth/candidates?scope=agentforge`);
      const candidatesBody = await candidates.json();
      assert.equal(candidatesBody.total, 0);
    } finally {
      child.kill();
    }
  });

  it("HTTP regression-case는 approved candidate에서 idempotent하게 생성된다", async () => {
    seedGrowthCandidate();
    const signalId = listGrowthCandidates(testRoot, "agentforge")[0].signalId;
    reviewGrowthCandidate(testRoot, {
      signalId,
      decision: "approved",
      reviewer: "http-test"
    });
    const port = await freePort();
    const serverPath = path.resolve(__dirname, "..", "..", "brain-server", "index.js");
    const child = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        PORT: String(port),
        BRAIN_ROOT: testRoot,
        BRAIN_API_KEY: ""
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    try {
      await waitForHealth(port);
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/api/growth/candidates/${signalId}/regression-case`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          createdBy: "http-test",
          reason: "회귀 케이스 생성"
        })
      });
      const secondResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/growth/candidates/${signalId}/regression-case`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ createdBy: "http-test" })
      });
      assert.equal(response.status, 200);
      assert.equal(secondResponse.status, 200);
      const body = await response.json();
      const secondBody = await secondResponse.json();

      assert.equal(body.success, true);
      assert.equal(body.result.created, true);
      assert.equal(secondBody.result.created, false);
      assert.equal(secondBody.result.case.caseId, body.result.case.caseId);
    } finally {
      child.kill();
    }
  });

  it("HTTP regression case run은 실행 결과를 반환한다", async () => {
    seedGrowthCandidate();
    const signalId = listGrowthCandidates(testRoot, "agentforge")[0].signalId;
    reviewGrowthCandidate(testRoot, {
      signalId,
      decision: "approved",
      reviewer: "http-test"
    });
    const regression = createGrowthRegressionCase(testRoot, {
      signalId,
      createdBy: "http-test"
    });
    const port = await freePort();
    const serverPath = path.resolve(__dirname, "..", "..", "brain-server", "index.js");
    const child = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        PORT: String(port),
        BRAIN_ROOT: testRoot,
        BRAIN_API_KEY: ""
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    try {
      await waitForHealth(port);
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/api/growth/regression-cases/${regression.case.caseId}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runner: "http-test",
          reason: "회귀 케이스 실행"
        })
      });
      assert.equal(response.status, 200);
      const body = await response.json();

      assert.equal(body.success, true);
      assert.equal(body.result.result.status, "passed");
      assert.equal(body.result.case.status, "executed_passed");
      assert.equal(body.result.case.lastRun.resultId, body.result.result.resultId);
    } finally {
      child.kill();
    }
  });

  it("HTTP promotion proposal은 passed regression case에서 idempotent하게 생성된다", async () => {
    seedGrowthCandidate();
    const signalId = listGrowthCandidates(testRoot, "agentforge")[0].signalId;
    reviewGrowthCandidate(testRoot, {
      signalId,
      decision: "approved",
      reviewer: "http-test"
    });
    const regression = createGrowthRegressionCase(testRoot, {
      signalId,
      createdBy: "http-test"
    });
    runGrowthRegressionCase(testRoot, {
      caseId: regression.case.caseId,
      runner: "http-test"
    });
    const port = await freePort();
    const serverPath = path.resolve(__dirname, "..", "..", "brain-server", "index.js");
    const child = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        PORT: String(port),
        BRAIN_ROOT: testRoot,
        BRAIN_API_KEY: ""
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    try {
      await waitForHealth(port);
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/api/growth/regression-cases/${regression.case.caseId}/promotion-proposal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          createdBy: "http-test",
          reason: "promotion proposal 생성"
        })
      });
      const secondResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/growth/regression-cases/${regression.case.caseId}/promotion-proposal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ createdBy: "http-test" })
      });
      assert.equal(response.status, 200);
      assert.equal(secondResponse.status, 200);
      const body = await response.json();
      const secondBody = await secondResponse.json();

      assert.equal(body.success, true);
      assert.equal(body.result.created, true);
      assert.equal(secondBody.result.created, false);
      assert.equal(secondBody.result.proposal.proposalId, body.result.proposal.proposalId);
      assert.equal(body.result.proposal.gate.lastRunStatus, "passed");
    } finally {
      child.kill();
    }
  });

  it("HTTP promotion proposal review는 needs_changes decision을 남긴다", async () => {
    seedGrowthCandidate();
    const signalId = listGrowthCandidates(testRoot, "agentforge")[0].signalId;
    reviewGrowthCandidate(testRoot, {
      signalId,
      decision: "approved",
      reviewer: "http-test"
    });
    const regression = createGrowthRegressionCase(testRoot, {
      signalId,
      createdBy: "http-test"
    });
    runGrowthRegressionCase(testRoot, {
      caseId: regression.case.caseId,
      runner: "http-test"
    });
    const proposal = createGrowthPromotionProposal(testRoot, {
      caseId: regression.case.caseId,
      createdBy: "http-test"
    });
    const port = await freePort();
    const serverPath = path.resolve(__dirname, "..", "..", "brain-server", "index.js");
    const child = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        PORT: String(port),
        BRAIN_ROOT: testRoot,
        BRAIN_API_KEY: ""
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    try {
      await waitForHealth(port);
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/api/growth/promotion-proposals/${proposal.proposal.proposalId}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision: "needs_changes",
          reviewer: "http-test",
          reason: "수정 후 재검토"
        })
      });
      assert.equal(response.status, 200);
      const body = await response.json();

      assert.equal(body.success, true);
      assert.equal(body.result.proposal.status, "needs_changes");
      assert.equal(body.result.decision.decision, "needs_changes");
      assert.equal(body.result.decision.reviewer, "http-test");
    } finally {
      child.kill();
    }
  });

  it("HTTP apply proposal은 approved proposal을 idempotent하게 적용한다", async () => {
    seedGrowthCandidate();
    const signalId = listGrowthCandidates(testRoot, "agentforge")[0].signalId;
    reviewGrowthCandidate(testRoot, {
      signalId,
      decision: "approved",
      reviewer: "http-test"
    });
    const regression = createGrowthRegressionCase(testRoot, {
      signalId,
      createdBy: "http-test"
    });
    runGrowthRegressionCase(testRoot, {
      caseId: regression.case.caseId,
      runner: "http-test"
    });
    const proposal = createGrowthPromotionProposal(testRoot, {
      caseId: regression.case.caseId,
      createdBy: "http-test"
    });
    reviewGrowthPromotionProposal(testRoot, {
      proposalId: proposal.proposal.proposalId,
      decision: "approved",
      reviewer: "http-test"
    });
    const port = await freePort();
    const serverPath = path.resolve(__dirname, "..", "..", "brain-server", "index.js");
    const child = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        PORT: String(port),
        BRAIN_ROOT: testRoot,
        BRAIN_API_KEY: ""
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    try {
      await waitForHealth(port);
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/api/growth/promotion-proposals/${proposal.proposal.proposalId}/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appliedBy: "http-test",
          reason: "approved proposal 적용"
        })
      });
      const secondResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/growth/promotion-proposals/${proposal.proposal.proposalId}/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appliedBy: "http-test" })
      });
      assert.equal(response.status, 200);
      assert.equal(secondResponse.status, 200);
      const body = await response.json();
      const secondBody = await secondResponse.json();

      assert.equal(body.success, true);
      assert.equal(body.result.applied, true);
      assert.equal(body.result.proposal.status, "applied");
      assert.equal(secondBody.result.applied, false);
      assert.equal(secondBody.result.promotion.promotionId, body.result.promotion.promotionId);

      const exportResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/growth/promotion-exports?scope=agentforge`);
      assert.equal(exportResponse.status, 200);
      const exportBody = await exportResponse.json();
      assert.equal(exportBody.success, true);
      assert.equal(exportBody.result.adapter, "project");
      assert.equal(exportBody.result.total, 1);
      assert.equal(exportBody.result.promotions[0].target.targetType, "capability_registry");

      const aliasResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/growth/agentforge/promotion-exports?scope=agentforge`);
      assert.equal(aliasResponse.status, 200);
      const aliasBody = await aliasResponse.json();
      assert.equal(aliasBody.result.promotions[0].promotionId, exportBody.result.promotions[0].promotionId);

      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-http-consumer-"));
      try {
        const consumeResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/growth/promotion-exports/consume`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scopeId: "agentforge",
            projectRoot,
            mode: "dry_run",
            promotionId: exportBody.result.promotions[0].promotionId,
            adapterRegistry: {
              schemaVersion: "project-adapter-registry/v1",
              projects: {
                agentforge: {
                  applyPipeline: {
                    required: true,
                    requiredChecks: ["npm test"],
                    runChecks: [{
                      name: "npm test",
                      command: process.execPath,
                      args: ["-e", "process.exit(0)"],
                      timeoutMs: 5000
                    }],
                    postApplyRequired: true,
                    postApplyRequiredChecks: ["post smoke"],
                    postApplyRunChecks: [{
                      name: "post smoke",
                      command: process.execPath,
                      args: ["-e", "process.exit(0)"],
                      timeoutMs: 5000
                    }]
                  },
                  targets: {
                    capability_registry: {
                      path: "src/capabilities.ts",
                      format: "typescript",
                      exportName: "capabilities",
                      mode: "upsert",
                      key: "id"
                    }
                  }
                }
              }
            },
            requestedBy: "http-test"
          })
        });
        assert.equal(consumeResponse.status, 200);
        const consumeBody = await consumeResponse.json();
        assert.equal(consumeBody.success, true);
        assert.equal(consumeBody.result.status, "preview_ready");
        assert.equal(consumeBody.result.requiresVerification, true);
        assert.equal(consumeBody.result.changes[0].targetType, "capability_registry");
        assert.equal(consumeBody.result.changes[0].format, "typescript");
        assert.equal(consumeBody.result.changes[0].exportName, "capabilities");
        assert.equal(fs.existsSync(path.join(projectRoot, "src", "capabilities.ts")), false);

        const blockedApplyResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/growth/promotion-exports/consume`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scopeId: "agentforge",
            projectRoot,
            mode: "apply",
            approvalId: "approval_http_pipeline",
            promotionId: exportBody.result.promotions[0].promotionId,
            adapterRegistry: {
              schemaVersion: "project-adapter-registry/v1",
              projects: {
                agentforge: {
                  applyPipeline: {
                    required: true,
                    requiredChecks: ["npm test"],
                    runChecks: [{
                      name: "npm test",
                      command: process.execPath,
                      args: ["-e", "process.exit(0)"],
                      timeoutMs: 5000
                    }],
                    postApplyRequired: true,
                    postApplyRequiredChecks: ["post smoke"],
                    postApplyRunChecks: [{
                      name: "post smoke",
                      command: process.execPath,
                      args: ["-e", "process.exit(0)"],
                      timeoutMs: 5000
                    }]
                  },
                  targets: {
                    capability_registry: {
                      path: "native/capabilities.json",
                      format: "json_array",
                      mode: "upsert",
                      key: "id"
                    }
                  }
                }
              }
            },
            requestedBy: "http-test"
          })
        });
        assert.equal(blockedApplyResponse.status, 200);
        const blockedApplyBody = await blockedApplyResponse.json();
        assert.equal(blockedApplyBody.result.status, "verification_required");
        assert.equal(fs.existsSync(path.join(projectRoot, "native", "capabilities.json")), false);

        const appliedResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/growth/promotion-exports/consume`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scopeId: "agentforge",
            projectRoot,
            mode: "apply",
            approvalId: "approval_http_pipeline",
            promotionId: exportBody.result.promotions[0].promotionId,
            runVerification: true,
            adapterRegistry: {
              schemaVersion: "project-adapter-registry/v1",
              projects: {
                agentforge: {
                  applyPipeline: {
                    required: true,
                    requiredChecks: ["npm test"],
                    runChecks: [{
                      name: "npm test",
                      command: process.execPath,
                      args: ["-e", "process.exit(0)"],
                      timeoutMs: 5000
                    }],
                    postApplyRequired: true,
                    postApplyRequiredChecks: ["post smoke"],
                    postApplyRunChecks: [{
                      name: "post smoke",
                      command: process.execPath,
                      args: ["-e", "process.exit(0)"],
                      timeoutMs: 5000
                    }]
                  },
                  targets: {
                    capability_registry: {
                      path: "native/capabilities.json",
                      format: "json_array",
                      mode: "upsert",
                      key: "id"
                    }
                  }
                }
              }
            },
            requestedBy: "http-test"
          })
        });
        assert.equal(appliedResponse.status, 200);
        const appliedBody = await appliedResponse.json();
        assert.equal(appliedBody.result.status, "applied");
        assert.equal(appliedBody.result.pipelineGate.checks[0].status, "passed");
        assert.equal(appliedBody.result.postApplyGate.checks[0].status, "passed");
        const nativeRecords = JSON.parse(fs.readFileSync(path.join(projectRoot, "native", "capabilities.json"), "utf-8"));
        assert.equal(nativeRecords[0].approvalId, "approval_http_pipeline");
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    } finally {
      child.kill();
    }
  });
});
