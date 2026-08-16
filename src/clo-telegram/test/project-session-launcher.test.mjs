import assert from "node:assert/strict";
import test from "node:test";

import { ProjectSessionLauncher } from "../dist/project-session-launcher.js";

test("ProjectSessionLauncher opens VS Code and an interactive Codex session with result contract", () => {
  const calls = [];
  const launcher = new ProjectSessionLauncher({
    codeCommand: "code-test",
    codexCommand: "codex-test",
    spawnDetached: (command, args) => {
      calls.push({ command, args });
    },
  });

  const result = launcher.launch({
    projectName: "Sentinel",
    projectPath: "D:/Projects/Sentinel",
    instruction: "설계서 작성",
    bridgeTask: {
      taskId: "task_1",
      sourceChatId: 64445716,
      sourceMessageId: 123,
      targetCwd: "D:/Projects/Sentinel",
      instruction: "설계서 작성",
      resultFile: "C:/Projects/Brain/src/clo-telegram/data/bridge/task-results/task_1.json",
    },
  });

  assert.equal(result.vscodeLaunched, true);
  assert.equal(result.agentLaunched, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(calls[0], { command: "code-test", args: ["-n", "D:/Projects/Sentinel"] });
  assert.equal(calls[1].command, "cmd.exe");
  assert.ok(calls[1].args.includes("codex-test"));
  assert.ok(calls[1].args.includes("-C"));
  assert.ok(calls[1].args.includes("D:/Projects/Sentinel"));
  assert.match(calls[1].args.at(-1), /resultFile/);
  assert.match(calls[1].args.at(-1), /task_1/);
});

