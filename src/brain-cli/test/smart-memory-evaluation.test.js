"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { writeJsonl } = require("../src/utils");
const {
  listSmartMemoryEvaluationCases,
  readSmartMemoryEvaluationResults,
  runSmartMemoryEvaluationSuite,
  seedDefaultSmartMemoryEvaluationCases
} = require("../src/smart-memory-evaluation");

let testRoot;

function setupRoot() {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-smart-memory-evaluation-"));
  fs.mkdirSync(path.join(testRoot, "90_index"), { recursive: true });
  fs.writeFileSync(path.join(testRoot, "90_index", "records_digest.txt"), [
    "# Brain records_digest.txt",
    "rec_proj_agentforge_20260511_0001 | 밴딩AI HTML 산출물 | 밴딩AI는 HTML 산출물을 만들 수 있음 | domain/design,intent/retrieval | active | project_state | user_confirmed | 2026-05-11T00:00:00.000Z",
    "rec_proj_brain_20260511_0002 | Brain 설계서 검증 | Brain 설계서는 원문 근거와 citation 기반 검증이 필요함 | domain/design,intent/verification | active | decision | user_confirmed | 2026-05-11T00:00:00.000Z"
  ].join("\n") + "\n", "utf-8");
  writeJsonl(path.join(testRoot, "90_index", "records.jsonl"), []);
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

describe("Smart Memory Evaluation Regression", () => {
  beforeEach(setupRoot);
  afterEach(() => {
    if (testRoot) fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("기본 golden case를 idempotent하게 seed한다", () => {
    const first = seedDefaultSmartMemoryEvaluationCases(testRoot, { scopeId: "agentforge" });
    const second = seedDefaultSmartMemoryEvaluationCases(testRoot, { scopeId: "agentforge" });
    const cases = listSmartMemoryEvaluationCases(testRoot, { scopeId: "agentforge" });

    assert.equal(first.created, 2);
    assert.equal(first.updated, 0);
    assert.equal(second.created, 0);
    assert.equal(second.updated, 2);
    assert.equal(cases.length, 2);
    assert.ok(cases.some(testCase => testCase.caseId === "agentforge_html_novelty_guard"));
    assert.ok(cases.some(testCase => testCase.caseId === "agentforge_verification_depth"));
  });

  it("evaluation suite는 HTML novelty guard와 verification depth를 검증한다", () => {
    const suite = runSmartMemoryEvaluationSuite(testRoot, {
      scopeId: "agentforge",
      seedDefaults: true
    });
    const results = readSmartMemoryEvaluationResults(testRoot);

    assert.equal(suite.status, "passed");
    assert.equal(suite.total, 2);
    assert.equal(suite.failed, 0);
    assert.equal(results.length, 2);
    const htmlCase = suite.results.find(result => result.caseId === "agentforge_html_novelty_guard");
    const verificationCase = suite.results.find(result => result.caseId === "agentforge_verification_depth");
    assert.equal(htmlCase.status, "passed");
    assert.equal(verificationCase.status, "passed");
    assert.ok(htmlCase.checks.some(check => check.checkId === "guard.failureTypes.includes:known_capability_as_new_suggestion" && check.passed));
    assert.ok(verificationCase.checks.some(check => check.checkId === "depth.usedDepth" && check.passed));
    assert.ok(verificationCase.checks.some(check => check.checkId === "answerPolicy.requiresCitation" && check.passed));
  });

  it("CLI smart-memory evaluation-cases/evaluate를 실행한다", async () => {
    const cases = await runCli([
      "smart-memory", "evaluation-cases",
      "--scope", "agentforge",
      "--seed-defaults",
      "--brain", testRoot
    ]);
    assert.equal(cases.code, 0, cases.stderr);
    assert.equal(JSON.parse(cases.stdout).total, 2);

    const evaluation = await runCli([
      "smart-memory", "evaluate",
      "--scope", "agentforge",
      "--seed-defaults",
      "--brain", testRoot
    ]);
    assert.equal(evaluation.code, 0, evaluation.stderr);
    const body = JSON.parse(evaluation.stdout);
    assert.equal(body.status, "passed");
    assert.equal(body.total, 2);
  });
});
