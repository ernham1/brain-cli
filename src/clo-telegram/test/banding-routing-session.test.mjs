import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SessionManager, makeSessionKey } from "../dist/session.js";

test("SessionManager persists BandingAI routing state", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clo-banding-routing-"));
  try {
    const manager = new SessionManager(dir);
    const session = manager.getOrCreate(12345, 67890);
    session.bandingAiRouting = {
      forced: true,
      updatedAt: "2026-06-04T00:00:00.000Z",
      updatedBy: 67890,
    };
    manager.save(session);

    const loaded = manager.load(makeSessionKey(12345, 67890));
    assert.equal(loaded?.bandingAiRouting?.forced, true);
    assert.equal(loaded?.bandingAiRouting?.updatedBy, 67890);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
