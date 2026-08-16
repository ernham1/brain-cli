import test from "node:test";
import assert from "node:assert/strict";
import { normalizeModelName } from "../dist/config.js";

test("normalizeModelName removes terminal style fragments from MODEL", () => {
  assert.equal(normalizeModelName("claude-opus-4-6[1m]", "fallback"), "claude-opus-4-6");
  assert.equal(normalizeModelName("\u001b[1mclaude-opus-4-6\u001b[0m", "fallback"), "claude-opus-4-6");
});

test("normalizeModelName falls back when MODEL is unset", () => {
  assert.equal(normalizeModelName(undefined, "claude-sonnet-4-5"), "claude-sonnet-4-5");
});
