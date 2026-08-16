"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { teamInit, teamAddMember, readConfig } = require("../src/team");

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-team-test-"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- F2: teamInit ---

describe("teamInit", () => {
  it("팀 Brain 기본 디렉토리를 생성한다", () => {
    const teamBrainPath = path.join(tmpDir, "TeamBrain1");
    teamInit(teamBrainPath, "test-project");

    assert.ok(fs.existsSync(path.join(teamBrainPath, "90_index")));
    assert.ok(fs.existsSync(path.join(teamBrainPath, "10_projects")));
    assert.ok(fs.existsSync(path.join(teamBrainPath, "30_topics")));
    assert.ok(fs.existsSync(path.join(teamBrainPath, "projects")));
  });

  it("90_index 하위 인덱스 파일을 생성한다", () => {
    const teamBrainPath = path.join(tmpDir, "TeamBrain2");
    teamInit(teamBrainPath, "test-project");

    assert.ok(fs.existsSync(path.join(teamBrainPath, "90_index", "records.jsonl")));
    assert.ok(fs.existsSync(path.join(teamBrainPath, "90_index", "records_digest.txt")));
    assert.ok(fs.existsSync(path.join(teamBrainPath, "90_index", "tags.json")));
    assert.ok(fs.existsSync(path.join(teamBrainPath, "90_index", "manifest.json")));
    assert.ok(fs.existsSync(path.join(teamBrainPath, "90_index", "folderRegistry.json")));
  });

  it("projects/<projectName>/shared/ 디렉토리를 생성한다", () => {
    const teamBrainPath = path.join(tmpDir, "TeamBrain3");
    teamInit(teamBrainPath, "clo-telegram");

    assert.ok(fs.existsSync(path.join(teamBrainPath, "projects", "clo-telegram", "shared")));
  });

  it("team-config.json을 생성하고 프로젝트를 등록한다", () => {
    const teamBrainPath = path.join(tmpDir, "TeamBrain4");
    teamInit(teamBrainPath, "my-project");

    const cfgPath = path.join(teamBrainPath, "team-config.json");
    assert.ok(fs.existsSync(cfgPath));

    const config = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    assert.ok(config.projects["my-project"]);
    assert.deepEqual(config.projects["my-project"].members, []);
  });

  it("멱등 — 이미 존재하는 구조에서도 에러 없이 실행된다", () => {
    const teamBrainPath = path.join(tmpDir, "TeamBrain5");
    teamInit(teamBrainPath, "proj");
    // 두 번 호출해도 에러 없음
    const result = teamInit(teamBrainPath, "proj");
    assert.ok(result.skipped.length > 0);
  });

  it("같은 Brain에 프로젝트를 추가로 등록할 수 있다", () => {
    const teamBrainPath = path.join(tmpDir, "TeamBrain6");
    teamInit(teamBrainPath, "proj-a");
    teamInit(teamBrainPath, "proj-b");

    const config = readConfig(teamBrainPath);
    assert.ok(config.projects["proj-a"]);
    assert.ok(config.projects["proj-b"]);
  });
});

// --- F3: teamAddMember ---

describe("teamAddMember", () => {
  it("팀원을 등록하고 개인 공간 디렉토리를 생성한다", () => {
    const teamBrainPath = path.join(tmpDir, "TeamBrainM1");
    teamInit(teamBrainPath, "clo-telegram");
    const result = teamAddMember(teamBrainPath, "clo-telegram", "고광웅");

    assert.ok(result.isNew);
    assert.ok(fs.existsSync(path.join(teamBrainPath, "projects", "clo-telegram", "고광웅")));
  });

  it("team-config.json의 members 배열에 팀원이 추가된다", () => {
    const teamBrainPath = path.join(tmpDir, "TeamBrainM2");
    teamInit(teamBrainPath, "my-proj");
    teamAddMember(teamBrainPath, "my-proj", "김철수");

    const config = readConfig(teamBrainPath);
    assert.ok(config.projects["my-proj"].members.includes("김철수"));
  });

  it("중복 등록 시 isNew=false를 반환한다", () => {
    const teamBrainPath = path.join(tmpDir, "TeamBrainM3");
    teamInit(teamBrainPath, "proj");
    teamAddMember(teamBrainPath, "proj", "이영희");
    const result = teamAddMember(teamBrainPath, "proj", "이영희");

    assert.equal(result.isNew, false);
    const config = readConfig(teamBrainPath);
    // 중복 없이 1개만 존재
    assert.equal(config.projects["proj"].members.filter(m => m === "이영희").length, 1);
  });

  it("여러 팀원을 순차 등록할 수 있다", () => {
    const teamBrainPath = path.join(tmpDir, "TeamBrainM4");
    teamInit(teamBrainPath, "team-proj");
    teamAddMember(teamBrainPath, "team-proj", "팀원A");
    teamAddMember(teamBrainPath, "team-proj", "팀원B");

    const config = readConfig(teamBrainPath);
    assert.ok(config.projects["team-proj"].members.includes("팀원A"));
    assert.ok(config.projects["team-proj"].members.includes("팀원B"));
  });

  it("team-config.json 없이 add-member 시 에러가 발생한다", () => {
    const teamBrainPath = path.join(tmpDir, "TeamBrainM5-empty");
    fs.mkdirSync(teamBrainPath, { recursive: true });

    assert.throws(
      () => teamAddMember(teamBrainPath, "proj", "팀원"),
      /team-config\.json이 없습니다/
    );
  });

  it("존재하지 않는 프로젝트에 add-member 시 에러가 발생한다", () => {
    const teamBrainPath = path.join(tmpDir, "TeamBrainM6");
    teamInit(teamBrainPath, "real-proj");

    assert.throws(
      () => teamAddMember(teamBrainPath, "nonexistent-proj", "팀원"),
      /프로젝트.*없습니다/
    );
  });
});

// --- F1: resolveBrainRoot ---

describe("resolveBrainRoot", () => {
  it("--brain 옵션이 있으면 해당 경로를 반환한다", () => {
    const { resolveBrainRoot } = require("../src/utils");
    const result = resolveBrainRoot({ brain: tmpDir });
    assert.equal(result, path.resolve(tmpDir));
  });

  it("--root 옵션이 있으면 해당 경로를 반환한다", () => {
    const { resolveBrainRoot } = require("../src/utils");
    const result = resolveBrainRoot({ root: tmpDir });
    assert.equal(result, path.resolve(tmpDir));
  });

  it("--brain이 --root보다 우선순위가 높다", () => {
    const { resolveBrainRoot } = require("../src/utils");
    const brain = path.join(tmpDir, "BrainA");
    const root = path.join(tmpDir, "BrainB");
    const result = resolveBrainRoot({ brain, root });
    assert.equal(result, path.resolve(brain));
  });
});
