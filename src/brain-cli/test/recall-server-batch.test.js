"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const cliPath = path.join(__dirname, "../src/index.js");

test("recall --batch uses Brain Server for every query and exits", async () => {
  const receivedGoals = [];
  let activeRequests = 0;
  let maxConcurrentRequests = 0;
  const server = http.createServer((request, response) => {
    let rawBody = "";
    request.setEncoding("utf8");
    request.on("data", chunk => {
      rawBody += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(rawBody);
      receivedGoals.push(body.goal);
      activeRequests++;
      maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
      setTimeout(() => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          success: true,
          results: {
            candidates: [{
              recordId: `rec_${body.goal}`,
              title: `${body.goal} title`,
              summary: `${body.goal} summary`,
              tags: ["test"],
              score: 1
            }],
            consolidationHints: []
          }
        }));
        activeRequests--;
      }, 30);
    });
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cliPath,
      "recall",
      "--server",
      `http://127.0.0.1:${address.port}`,
      "--brief",
      "--batch",
      "alpha",
      "beta"
    ], {
      cwd: path.join(__dirname, ".."),
      timeout: 8000,
      windowsHide: true
    });

    assert.equal(stderr, "");
    assert.deepEqual(receivedGoals, ["alpha", "beta"]);
    assert.equal(maxConcurrentRequests, 1);
    assert.match(stdout, /쿼리 1: "alpha"/);
    assert.match(stdout, /쿼리 2: "beta"/);
    assert.ok(stdout.indexOf('쿼리 1: "alpha"') < stdout.indexOf('쿼리 2: "beta"'));
    assert.match(stdout, /alpha title — alpha summary/);
    assert.match(stdout, /beta title — beta summary/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

