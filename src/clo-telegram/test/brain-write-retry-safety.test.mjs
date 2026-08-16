import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BRAIN_WRITE_MAX_ATTEMPTS,
  BRAIN_WRITE_TIMEOUT_MS,
  listBrainTransactionTmpFiles,
} from "../dist/tools.js";

test("brain_write timeout covers full-store validation", () => {
  assert.equal(BRAIN_WRITE_TIMEOUT_MS, 5 * 60 * 1000);
});

test("brain_write never automatically resubmits an ambiguous write", () => {
  assert.equal(BRAIN_WRITE_MAX_ATTEMPTS, 1);
});

test("brain_write diagnostics preserve another BWT transaction tmp files", () => {
  const brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-write-retry-"));
  const indexDir = path.join(brainRoot, "90_index");
  fs.mkdirSync(indexDir, { recursive: true });

  const transactionFiles = [
    "records.jsonl.tmp",
    "manifest.json.tmp",
    "records_digest.txt.tmp",
  ];
  for (const fileName of transactionFiles) {
    fs.writeFileSync(path.join(indexDir, fileName), "live transaction", "utf8");
  }

  assert.deepEqual(listBrainTransactionTmpFiles(brainRoot).sort(), transactionFiles.sort());
  for (const fileName of transactionFiles) {
    assert.equal(fs.existsSync(path.join(indexDir, fileName)), true);
  }
});
