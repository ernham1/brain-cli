import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

export interface TelegramFileApi {
  getFile(fileId: string): Promise<{ file_path?: string }>;
}

export interface MeetingVoiceResult {
  status: "transcribed" | "failed";
  text: string;
  filePath: string;
  durationSec?: number;
  error?: string;
}

interface CaptureMeetingVoiceOptions {
  api: TelegramFileApi;
  botToken: string;
  fileId: string;
  durationSec?: number;
  fileSize?: number;
  tempDir: string;
  sttEnabled: boolean;
  sttModel: string;
  maxBytes: number;
}

interface CaptureDeps {
  download?: typeof downloadTelegramFile;
  transcribe?: typeof transcribeAudioFile;
}

export async function captureMeetingVoiceMessage(
  options: CaptureMeetingVoiceOptions,
  deps: CaptureDeps = {},
): Promise<MeetingVoiceResult> {
  if (options.fileSize && options.fileSize > options.maxBytes) {
    return failedVoiceResult({
      filePath: "",
      durationSec: options.durationSec,
      error: `음성 파일이 너무 큽니다 (${Math.ceil(options.fileSize / 1024 / 1024)}MB).`,
    });
  }

  const download = deps.download ?? downloadTelegramFile;
  const transcribe = deps.transcribe ?? transcribeAudioFile;
  const filePath = await download({
    api: options.api,
    botToken: options.botToken,
    fileId: options.fileId,
    tempDir: options.tempDir,
  });

  if (!options.sttEnabled) {
    return failedVoiceResult({
      filePath,
      durationSec: options.durationSec,
      error: "회의 STT가 비활성화되어 있습니다.",
    });
  }

  const transcript = await transcribe(filePath, {
    model: options.sttModel,
    durationSec: options.durationSec,
  });
  if (transcript.status === "failed") {
    return {
      ...transcript,
      filePath,
      durationSec: options.durationSec,
    };
  }

  return {
    status: "transcribed",
    text: transcript.text,
    filePath,
    durationSec: options.durationSec,
  };
}

export async function downloadTelegramFile(options: {
  api: TelegramFileApi;
  botToken: string;
  fileId: string;
  tempDir: string;
}): Promise<string> {
  const file = await options.api.getFile(options.fileId);
  if (!file.file_path) throw new Error("텔레그램 파일 경로를 가져오지 못했습니다.");

  fs.mkdirSync(options.tempDir, { recursive: true });
  const ext = normalizeTelegramVoiceExtension(path.extname(file.file_path));
  const fileName = `meeting_voice_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`;
  const filePath = path.join(options.tempDir, fileName);
  const fileUrl = `https://api.telegram.org/file/bot${options.botToken}/${file.file_path}`;

  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error(`텔레그램 파일 다운로드 실패: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.promises.writeFile(filePath, buffer);
  return filePath;
}

export async function transcribeAudioFile(
  filePath: string,
  options: { model: string; durationSec?: number },
): Promise<Omit<MeetingVoiceResult, "filePath">> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return failedVoiceResult({
      filePath: "",
      durationSec: options.durationSec,
      error: "OPENAI_API_KEY가 없어 STT를 실행하지 못했습니다.",
    });
  }

  try {
    const client = new OpenAI({ apiKey });
    const result = await client.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: options.model,
      language: "ko",
    });
    const text = result.text?.trim();
    if (!text) {
      return failedVoiceResult({
        filePath: "",
        durationSec: options.durationSec,
        error: "STT 결과가 비어 있습니다.",
      });
    }
    return {
      status: "transcribed",
      text,
      durationSec: options.durationSec,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return failedVoiceResult({
      filePath: "",
      durationSec: options.durationSec,
      error: msg.slice(0, 200),
    });
  }
}

export function voiceResultToBufferContent(result: MeetingVoiceResult): string {
  if (result.status === "transcribed") return result.text;
  const fileInfo = result.filePath ? ` 파일: ${path.resolve(result.filePath)}` : "";
  return `[음성 STT 실패: ${result.error || "알 수 없는 오류"}.${fileInfo}]`;
}

export function normalizeTelegramVoiceExtension(ext: string): string {
  const lower = ext.toLowerCase();
  if (!lower) return ".ogg";
  if (lower === ".oga" || lower === ".opus") return ".ogg";
  return lower;
}

function failedVoiceResult(input: {
  filePath: string;
  durationSec?: number;
  error: string;
}): MeetingVoiceResult {
  return {
    status: "failed",
    text: input.error,
    filePath: input.filePath,
    durationSec: input.durationSec,
    error: input.error,
  };
}
