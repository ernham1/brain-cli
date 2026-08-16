"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { embedText, disposeEmbeddingPipeline } = require("../src/db");

test("disposeEmbeddingPipeline releases the cached transformer pipeline", async () => {
  let disposeCalls = 0;
  embedText._pipe = {
    async dispose() {
      disposeCalls += 1;
    },
  };

  await disposeEmbeddingPipeline();

  assert.equal(disposeCalls, 1);
  assert.equal(embedText._pipe, null);
});

test("recall command disposes the embedding pipeline before returning", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/index.js"), "utf8");
  const recallSection = source.slice(
    source.indexOf("// --- recall 명령"),
    source.indexOf("// --- meta-seed 명령"),
  );

  assert.match(recallSection, /finally\s*\{[\s\S]*disposeEmbeddingPipeline/);
  assert.match(recallSection, /Promise\.race/);
  assert.match(recallSection, /setImmediate/);
  assert.doesNotMatch(recallSection, /process\.exit\(0\)/);
  assert.match(recallSection, /implicitLocalServer/);
  assert.match(recallSection, /AbortSignal\.timeout\(5000\)/);
  assert.equal(
    (recallSection.match(/!options\.brief && bootResult\.mismatches/g) || []).length,
    2,
  );
});