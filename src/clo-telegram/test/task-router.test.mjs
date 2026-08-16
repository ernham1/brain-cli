import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskRouter } from "../dist/router.js";

function session(projectName, startedAt = "2026-06-14T00:00:00.000Z") {
  return {
    sessionId: `session_${projectName}_${startedAt}`,
    cwd: `C:/Projects/${projectName}`,
    projectName,
    startedAt,
    watcherPid: 1000,
  };
}

function withTempCwd(run) {
  const originalCwd = process.cwd();
  const dir = mkdtempSync(path.join(tmpdir(), "clo-task-router-"));
  try {
    process.chdir(dir);
    return run(dir);
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("TaskRouter does not route explicit @D to latest session when project is ambiguous", () => {
  const router = new TaskRouter();
  const decision = router.decide("@D 빌드 상태 확인해줘", [
    session("nexus", "2026-06-14T00:00:00.000Z"),
    session("gateway", "2026-06-14T01:00:00.000Z"),
  ]);

  assert.equal(decision.shouldRoute, true);
  assert.equal(decision.targetSession, null);
  assert.equal(decision.reason, "ambiguous_session");
});

test("TaskRouter routes explicit @D when instruction names one active project", () => {
  const router = new TaskRouter();
  const decision = router.decide("@D nexus 빌드 상태 확인해줘", [
    session("nexus", "2026-06-14T00:00:00.000Z"),
    session("gateway", "2026-06-14T01:00:00.000Z"),
  ]);

  assert.equal(decision.shouldRoute, true);
  assert.equal(decision.targetSession?.projectName, "nexus");
  assert.equal(decision.reason, "vscode_task");
  assert.equal(decision.projectHint, "nexus");
});

test("TaskRouter returns no_session for alias match when the target project session is not active", () => withTempCwd((rootDir) => {
  mkdirSync(path.join(rootDir, "data"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "data", "project-aliases.json"),
    JSON.stringify({ "브레인": "brain" }, null, 2),
    "utf-8",
  );

  const router = new TaskRouter();
  const decision = router.decide("@D 브레인 빌드 상태 확인해줘", [
    session("nexus", "2026-06-14T00:00:00.000Z"),
    session("gateway", "2026-06-14T01:00:00.000Z"),
  ]);

  assert.equal(decision.shouldRoute, true);
  assert.equal(decision.targetSession, null);
  assert.equal(decision.reason, "no_session");
  assert.equal(decision.projectHint, "brain");
}));

test("TaskRouter does not choose between duplicate project sessions", () => {
  const router = new TaskRouter();
  const decision = router.decide("@D brain 테스트 돌려줘", [
    session("brain", "2026-06-14T00:00:00.000Z"),
    session("brain", "2026-06-14T01:00:00.000Z"),
  ]);

  assert.equal(decision.shouldRoute, true);
  assert.equal(decision.targetSession, null);
  assert.equal(decision.reason, "ambiguous_session");
  assert.equal(decision.projectHint, "brain");
});

test("TaskRouter routes explicit project path work to matching active session", () => {
  const router = new TaskRouter();
  const decision = router.decide("@D 다음 폴더내 설계서 저장 D:\\Projects\\Sentinel", [
    session("sentinel", "2026-06-23T12:00:00.000Z"),
    session("vision21", "2026-06-23T12:00:00.000Z"),
  ]);

  assert.equal(decision.shouldRoute, true);
  assert.equal(decision.targetSession?.projectName, "sentinel");
  assert.equal(decision.reason, "vscode_task");
  assert.equal(decision.projectHint, "sentinel");
});
