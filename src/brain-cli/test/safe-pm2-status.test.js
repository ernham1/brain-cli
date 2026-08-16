"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const scriptPath = path.join(__dirname, "../scripts/safe-pm2-status.js");

test("safe PM2 parser returns only allowlisted process status fields", () => {
  const { parsePm2Table } = require(scriptPath);
  const sample = [
    "│ id │ name         │ namespace │ version │ mode │ pid  │ uptime │ ↺ │ status │ cpu │ mem  │ user   │ watching │",
    "│ 7  │ brain-server │ default   │ 0.1.0   │ fork │ 1234 │ 2h     │ 2 │ online │ 0%  │ 10mb │ ernham │ disabled │",
    "SECRET_VALUE=must-not-appear"
  ].join("\n");

  assert.deepEqual(parsePm2Table(sample), [{
    name: "brain-server",
    status: "online",
    pid: "1234",
    uptime: "2h",
    restarts: "2"
  }]);
});

test("safe PM2 status source cannot invoke raw environment commands", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.doesNotMatch(source, /jlist|prettylist|describe|\benv\b|process\.env/i);
  assert.match(source, /\["ls", "--no-color"\]/);
});
