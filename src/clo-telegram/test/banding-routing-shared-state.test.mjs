import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  getSharedBandingAiRoutingStatePath,
  readSharedBandingAiRoutingState,
  writeSharedBandingAiRoutingState,
} from "../dist/banding-routing-state.js";

test("shared BandingAI routing state persists under Brain active state", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "brain-banding-routing-"));
  const previousBrainRoot = process.env.BRAIN_ROOT;
  process.env.BRAIN_ROOT = dir;
  try {
    assert.equal(readSharedBandingAiRoutingState().forced, false);
    const state = writeSharedBandingAiRoutingState(true, "desktop-test", "desktopclo");
    assert.equal(state.forced, true);
    assert.equal(state.updatedBy, "desktop-test");
    assert.equal(state.updatedFrom, "desktopclo");
    assert.match(getSharedBandingAiRoutingStatePath(), /41_active[\\/]bandingai-routing\.json$/);
    assert.equal(readSharedBandingAiRoutingState().forced, true);
  } finally {
    if (previousBrainRoot === undefined) delete process.env.BRAIN_ROOT;
    else process.env.BRAIN_ROOT = previousBrainRoot;
    rmSync(dir, { recursive: true, force: true });
  }
});
