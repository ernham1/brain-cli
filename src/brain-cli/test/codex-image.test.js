"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  sanitizeSubscriptionEnv,
  findRequestImage,
  generateCodexImage
} = require("../src/codex-image");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("Codex subscription image tool", () => {
  it("API 인증 환경변수를 자식 환경에서 제거한다", () => {
    const env = sanitizeSubscriptionEnv({
      OPENAI_API_KEY: "paid-key",
      OPENAI_ORG_ID: "org",
      KEEP_ME: "yes"
    });
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.OPENAI_ORG_ID, undefined);
    assert.equal(env.KEEP_ME, "yes");
  });

  it("요청 디렉터리 밖의 IMGPATH는 인정하지 않는다", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-image-path-"));
    const outside = path.join(path.dirname(root), "outside.png");
    fs.writeFileSync(outside, PNG_SIGNATURE);
    try {
      const result = findRequestImage(root, path.join(root, "result.png"), `IMGPATH=${outside}`);
      assert.equal(result, null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { force: true });
    }
  });

  it("ChatGPT 로그인 확인 후 요청별 PNG를 반환한다", async () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-image-generate-"));
    const calls = [];
    const fakeRunner = async (_command, args, options) => {
      calls.push({ args, options });
      if (args.includes("status")) {
        return { code: 0, stdout: "Logged in using ChatGPT", stderr: "" };
      }
      fs.writeFileSync(path.join(options.cwd, "result.png"), PNG_SIGNATURE);
      return { code: 0, stdout: `IMGPATH=${path.join(options.cwd, "result.png")}`, stderr: "" };
    };

    try {
      const result = await generateCodexImage(
        { prompt: "A clean product illustration", size: "1024x1024" },
        {
          outputRoot,
          env: { OPENAI_API_KEY: "must-not-leak", CODEX_HOME: outputRoot },
          commandInfo: { command: "fake-codex", prefixArgs: [] },
          runProcess: fakeRunner
        }
      );
      assert.equal(result.provider, "codex_subscription");
      assert.equal(result.authMode, "chatgpt_subscription");
      assert.equal(result.width, 1024);
      assert.ok(fs.existsSync(result.path));
      assert.equal(calls.length, 2);
      assert.equal(calls[1].options.env.OPENAI_API_KEY, undefined);
    } finally {
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("ChatGPT 로그인이 아니면 생성 명령을 실행하지 않는다", async () => {
    let callCount = 0;
    const fakeRunner = async () => {
      callCount += 1;
      return { code: 1, stdout: "Not logged in", stderr: "" };
    };
    await assert.rejects(
      generateCodexImage(
        { prompt: "test", size: "1536x1024" },
        {
          commandInfo: { command: "fake-codex", prefixArgs: [] },
          runProcess: fakeRunner
        }
      ),
      /ChatGPT 구독 로그인이 필요/
    );
    assert.equal(callCount, 1);
  });
});
