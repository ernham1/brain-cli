"use strict";

const { execFileSync } = require("node:child_process");

function parsePm2Table(output) {
  const processes = [];

  for (const line of String(output).split(/\r?\n/)) {
    if (!line.includes("│")) continue;
    const columns = line.split("│").slice(1, -1).map(value => value.trim());
    if (columns.length < 9 || !/^\d+$/.test(columns[0])) continue;

    processes.push({
      name: columns[1],
      status: columns[8],
      pid: columns[5],
      uptime: columns[6],
      restarts: columns[7]
    });
  }

  return processes;
}

function parseRequestedNames(argv) {
  const namesIndex = argv.indexOf("--names");
  if (namesIndex === -1) return [];

  return (argv[namesIndex + 1] || "")
    .split(",")
    .map(name => name.trim())
    .filter(name => /^[A-Za-z0-9._-]+$/.test(name));
}

function readSafePm2Status(requestedNames = []) {
  const pm2Args = ["ls", "--no-color"];
  const command = process.platform === "win32" ? "cmd.exe" : "pm2";
  const commandArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", "pm2 ls --no-color"]
    : pm2Args;
  const output = execFileSync(command, commandArgs, {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10000
  });
  const processes = parsePm2Table(output);

  if (requestedNames.length === 0) return processes;
  const allowedNames = new Set(requestedNames);
  return processes.filter(processInfo => allowedNames.has(processInfo.name));
}

if (require.main === module) {
  try {
    const requestedNames = parseRequestedNames(process.argv.slice(2));
    console.log(JSON.stringify({ processes: readSafePm2Status(requestedNames) }, null, 2));
  } catch {
    console.error("ERROR: PM2 안전 상태 조회 실패");
    process.exit(1);
  }
}

module.exports = { parsePm2Table, parseRequestedNames, readSafePm2Status };
