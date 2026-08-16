import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const providersSource = readFileSync(new URL("../src/providers.ts", import.meta.url), "utf-8");

test("Claude provider allows current BandingAI MCP tool names", () => {
  for (const toolName of [
    "mcp__agentforge__bandingai_list",
    "mcp__agentforge__bandingai_invoke",
    "mcp__agentforge__bandingai_workflow",
    "mcp__agentforge__bandingai_status",
    "mcp__agentforge__bandingai_result",
    "mcp__agentforge__bandingai_chat",
    "mcp__agentforge__bandingai_log",
    "mcp__agentforge__bandingai_feedback",
  ]) {
    assert.match(providersSource, new RegExp(toolName));
  }
});
