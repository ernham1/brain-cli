import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const providersSource = readFileSync(new URL("../src/providers.ts", import.meta.url), "utf-8");

const utilityToolNames = [
  "mcp__brain-tools__schedule_reminder",
  "mcp__brain-tools__list_reminders",
  "mcp__brain-tools__cancel_reminder",
  "mcp__brain-tools__generate_image",
  "mcp__brain-tools__send_file",
  "mcp__brain-tools__get_weather",
];

test("Claude provider attaches Telegram utility MCP tools even when Brain memory is disabled", () => {
  assert.match(
    providersSource,
    /if \(!toolsDisabled\) mcpServers\["brain-tools"\] = this\.createBrainMcp\(\);/,
  );

  const allowedStart = providersSource.indexOf("const brainAllowedTools = toolsDisabled");
  const allowedEnd = providersSource.indexOf("const agentforgeAllowedTools", allowedStart);
  assert.notEqual(allowedStart, -1);
  assert.notEqual(allowedEnd, -1);

  const allowedToolsSource = providersSource.slice(allowedStart, allowedEnd);
  assert.match(allowedToolsSource, /\.\.\.\(this\.brainEnabled \? \[/);

  for (const toolName of utilityToolNames) {
    assert.match(allowedToolsSource, new RegExp(toolName));
  }
});

test("Claude provider registers Brain memory tools only inside the brainEnabled gate", () => {
  const createStart = providersSource.indexOf("private createBrainMcp()");
  const utilityStart = providersSource.indexOf('"schedule_reminder"', createStart);
  assert.notEqual(createStart, -1);
  assert.notEqual(utilityStart, -1);

  const brainToolRegistration = providersSource.slice(createStart, utilityStart);
  assert.match(brainToolRegistration, /\.\.\.\(this\.brainEnabled \? \[/);

  for (const toolName of ["brain_recall", "nexus_search", "brain_write"]) {
    assert.match(brainToolRegistration, new RegExp(`"${toolName}"`));
  }
});

test("Telegram utility MCP tools have watchdog timeouts", () => {
  for (const toolName of [
    "mcp__brain-tools__generate_image",
    "mcp__brain-tools__send_file",
    "mcp__brain-tools__get_weather",
  ]) {
    assert.match(providersSource, new RegExp(`"${toolName}":`));
  }
});

