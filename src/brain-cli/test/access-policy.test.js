"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { checkAccess, upsertOverride, filterMemoryItems } = require("../src/access-policy");

let testRoot;

function setupRoot() {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-access-policy-"));
}

describe("Access Policy", () => {
  beforeEach(setupRoot);
  afterEach(() => fs.rmSync(testRoot, { recursive: true, force: true }));

  it("telegram_multi_agent는 workstyle은 허용하고 private_user_contextual은 기본 차단한다", () => {
    assert.equal(checkAccess(testRoot, {
      channelMode: "telegram_multi_agent",
      visibility: "private_user_workstyle"
    }).allowed, true);
    assert.equal(checkAccess(testRoot, {
      channelMode: "telegram_multi_agent",
      visibility: "private_user_contextual"
    }).allowed, false);
  });

  it("override allow는 같은 conversation에서만 적용되고 deny가 우선한다", () => {
    upsertOverride(testRoot, {
      action: "allow",
      channelMode: "telegram_multi_agent",
      conversationId: "room-1",
      visibility: "private_user_contextual",
      scope: "thread",
      days: 7
    });
    assert.equal(checkAccess(testRoot, {
      channelMode: "telegram_multi_agent",
      conversationId: "room-1",
      visibility: "private_user_contextual"
    }).allowed, true);
    assert.equal(checkAccess(testRoot, {
      channelMode: "telegram_multi_agent",
      conversationId: "room-2",
      visibility: "private_user_contextual"
    }).allowed, false);

    upsertOverride(testRoot, {
      action: "deny",
      channelMode: "telegram_multi_agent",
      conversationId: "room-1",
      visibility: "private_user_contextual",
      scope: "thread"
    });
    assert.equal(checkAccess(testRoot, {
      channelMode: "telegram_multi_agent",
      conversationId: "room-1",
      visibility: "private_user_contextual"
    }).allowed, false);
  });

  it("sensitive 문자열은 본문에서 제외하고 blockedRefs에 남긴다", () => {
    const result = filterMemoryItems(testRoot, [{
      ref: "secret-1",
      visibility: "project",
      content: "api_key=abc123"
    }], { channelMode: "codex_local" });

    assert.equal(result.allowed.length, 0);
    assert.equal(result.blockedRefs[0].reason, "sensitive_blocked");
  });
});
