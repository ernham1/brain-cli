"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { evidenceDisposition } = require("../scripts/build-missing-raw-residual-ledger");

describe("missing Raw residual ledger", () => {
  it("assigns an evidence trail and next required evidence to every family", () => {
    for (const sourceFamily of ["work-log", "session-handoff", "10_projects/brain"]) {
      const result = evidenceDisposition({ sourceFamily });
      assert.ok(result.reason);
      assert.ok(result.searchedEvidence.length > 0);
      assert.ok(result.nextRequiredEvidence);
    }
  });
});
