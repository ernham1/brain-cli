"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _loadExistingWiki, _runClaudeCompile } = require("../src/wiki-compile");

const roots = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

describe("Wiki 기존 문서 로드", () => {
  it("wiki 레코드가 없어도 물리 wiki.md를 읽는다", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "brain-wiki-existing-"));
    roots.push(root);
    const wikiPath = path.join(root, "40_wiki", "brain", "wiki.md");
    fs.mkdirSync(path.dirname(wikiPath), { recursive: true });
    fs.writeFileSync(wikiPath, "# 기존 Brain Wiki\n", "utf-8");
    const result = _loadExistingWiki(root, [], "brain");
    assert.match(result.existingWikiContent, /기존 Brain Wiki/);
    assert.equal(result.existingWikiRecordId, null);
  });
});

describe("Wiki Claude 실행", () => {
  it("셸 치환 없이 stdin으로 프롬프트를 전달한다", () => {
    let invocation;
    const runner = (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: "# 컴파일 결과\n", stderr: "", error: null };
    };
    const output = _runClaudeCompile(
      "scope={{SCOPE_ID}}\nraw={{RAW_RECORDS}}\nold={{EXISTING_WIKI}}",
      "brain",
      [{ recordId: "rec_proj_brain_1", type: "log", title: "기록", summary: "요약" }],
      "# 기존 Wiki",
      runner
    );
    assert.equal(output, "# 컴파일 결과");
    assert.equal(invocation.command, process.platform === "win32" ? "claude.cmd" : "claude");
    assert.deepEqual(invocation.args, ["-p"]);
    assert.equal(invocation.options.shell, process.platform === "win32");
    assert.match(invocation.options.input, /rec_proj_brain_1/);
    assert.match(invocation.options.input, /기존 Wiki/);
  });
});
