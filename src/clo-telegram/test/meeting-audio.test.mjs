import assert from "node:assert/strict";
import test from "node:test";

import {
  captureMeetingVoiceMessage,
  normalizeTelegramVoiceExtension,
  transcribeAudioFile,
  voiceResultToBufferContent,
} from "../dist/modes/meeting-audio.js";

test("captureMeetingVoiceMessage returns transcribed voice result with injected deps", async () => {
  const result = await captureMeetingVoiceMessage({
    api: { getFile: async () => ({ file_path: "voice/file.ogg" }) },
    botToken: "token",
    fileId: "file-id",
    durationSec: 12,
    fileSize: 1000,
    tempDir: "unused",
    sttEnabled: true,
    sttModel: "test-model",
    maxBytes: 1024 * 1024,
  }, {
    download: async () => "C:/tmp/voice.ogg",
    transcribe: async () => ({
      status: "transcribed",
      text: "회의에서 밴딩AI 회의록 기능을 논의했습니다.",
      durationSec: 12,
    }),
  });

  assert.equal(result.status, "transcribed");
  assert.equal(result.text, "회의에서 밴딩AI 회의록 기능을 논의했습니다.");
  assert.equal(result.filePath, "C:/tmp/voice.ogg");
  assert.equal(voiceResultToBufferContent(result), result.text);
});

test("captureMeetingVoiceMessage keeps meeting flow when STT fails", async () => {
  const result = await captureMeetingVoiceMessage({
    api: { getFile: async () => ({ file_path: "voice/file.ogg" }) },
    botToken: "token",
    fileId: "file-id",
    durationSec: 9,
    fileSize: 1000,
    tempDir: "unused",
    sttEnabled: true,
    sttModel: "test-model",
    maxBytes: 1024 * 1024,
  }, {
    download: async () => "C:/tmp/voice.ogg",
    transcribe: async () => ({
      status: "failed",
      text: "STT 실패",
      durationSec: 9,
      error: "STT 실패",
    }),
  });

  assert.equal(result.status, "failed");
  assert.match(voiceResultToBufferContent(result), /음성 STT 실패/);
  assert.match(voiceResultToBufferContent(result), /voice\.ogg/);
});

test("captureMeetingVoiceMessage rejects oversized voice without download", async () => {
  const result = await captureMeetingVoiceMessage({
    api: { getFile: async () => ({ file_path: "voice/file.ogg" }) },
    botToken: "token",
    fileId: "file-id",
    durationSec: 120,
    fileSize: 30 * 1024 * 1024,
    tempDir: "unused",
    sttEnabled: true,
    sttModel: "test-model",
    maxBytes: 20 * 1024 * 1024,
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /너무 큽니다/);
});

test("transcribeAudioFile fails clearly without OPENAI_API_KEY", async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const result = await transcribeAudioFile("C:/tmp/missing.ogg", {
      model: "test-model",
      durationSec: 3,
    });
    assert.equal(result.status, "failed");
    assert.match(result.error, /OPENAI_API_KEY/);
  } finally {
    if (previous) process.env.OPENAI_API_KEY = previous;
  }
});

test("normalizeTelegramVoiceExtension maps Telegram .oga voice to .ogg", () => {
  assert.equal(normalizeTelegramVoiceExtension(".oga"), ".ogg");
  assert.equal(normalizeTelegramVoiceExtension(".opus"), ".ogg");
  assert.equal(normalizeTelegramVoiceExtension(".OGG"), ".ogg");
});
