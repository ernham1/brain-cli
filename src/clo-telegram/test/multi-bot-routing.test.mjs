import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBotNamePattern,
  hasInternalSilenceMarker,
  isAddressedToAnotherKnownBot,
  shouldSuppressInternalSilenceResponse,
  stripInternalSilenceMarkers,
} from "../dist/bot.js";

test("buildBotNamePattern matches Korean bot-name particles", () => {
  const cloPattern = buildBotNamePattern("클로");

  assert.equal(cloPattern.test("클로야 이거 봐줘"), true);
  assert.equal(cloPattern.test("클로한테 말씀하신 거군요"), true);
  assert.equal(cloPattern.test("클로에게만 보내"), true);
  assert.equal(cloPattern.test("클로드에게 보내"), false);
});

test("isAddressedToAnotherKnownBot ignores group messages for other bot names", () => {
  assert.equal(isAddressedToAnotherKnownBot("클로한테 말씀하신 거군요", "지피", false), true);
  assert.equal(isAddressedToAnotherKnownBot("지피야 이거 봐줘", "지피", false), false);
  assert.equal(isAddressedToAnotherKnownBot("클로, 지피 둘 다 봐줘", "지피", true), false);
});

test("internal silence markers do not leak into Telegram replies", () => {
  assert.equal(hasInternalSilenceMarker("죄송합니다.\n\n[QUIET]"), true);
  assert.equal(stripInternalSilenceMarkers("죄송합니다.\n\n[QUIET]"), "죄송합니다.");
  assert.equal(stripInternalSilenceMarkers("[QUIET]"), "");
});

test("internal silence suppresses only passive group turns", () => {
  assert.equal(shouldSuppressInternalSilenceResponse("[QUIET]", true), true);
  assert.equal(shouldSuppressInternalSilenceResponse("[SKIP]", true), true);
  assert.equal(shouldSuppressInternalSilenceResponse("[QUIET]", false), false);
  assert.equal(shouldSuppressInternalSilenceResponse("[SKIP]", false), false);
});

