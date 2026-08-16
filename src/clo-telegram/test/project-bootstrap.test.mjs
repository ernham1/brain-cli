import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureProjectDirectory,
  parseProjectBootstrapRequest,
} from "../dist/project-bootstrap.js";

test("parseProjectBootstrapRequest extracts project and task from explicit Korean request", () => {
  const root = "C:/Projects";
  const request = parseProjectBootstrapRequest(
    "@D A라는 프로젝트 폴더 생성하고 해당 프로젝트에 세션을 적용해 B라는 작업 수행해줘",
    { projectRoot: root },
  );

  assert.equal(request?.projectName, "A");
  assert.equal(request?.projectPath, path.resolve(root, "A"));
  assert.equal(request?.taskInstruction, "B");
});

test("parseProjectBootstrapRequest supports quoted project and task names", () => {
  const request = parseProjectBootstrapRequest(
    "'quizPop' 프로젝트 폴더 만들고 \"기본 README 작성\" 작업 수행해주세요",
    { projectRoot: "C:/Projects" },
  );

  assert.equal(request?.projectName, "quizPop");
  assert.equal(request?.taskInstruction, "기본 README 작성");
});

test("parseProjectBootstrapRequest rejects unsafe project names", () => {
  const request = parseProjectBootstrapRequest(
    "../secret라는 프로젝트 폴더 생성하고 B라는 작업 수행해줘",
    { projectRoot: "C:/Projects" },
  );

  assert.equal(request, null);
});

test("ensureProjectDirectory creates the target project folder", () => {
  const root = mkdtempSync(path.join(tmpdir(), "clo-project-root-"));
  try {
    const request = parseProjectBootstrapRequest(
      "SampleApp라는 프로젝트 폴더 생성하고 README 작성이라는 작업 수행해줘",
      { projectRoot: root },
    );

    assert.ok(request);
    ensureProjectDirectory(request);
    assert.equal(existsSync(path.join(root, "SampleApp")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
