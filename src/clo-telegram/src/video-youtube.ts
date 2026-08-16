import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

/** ffmpeg/ffprobe bin 디렉토리 탐지 (PATH에 있으면 null) */
function findFfmpegDir(): string | null {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore", windowsHide: true });
    return null;
  } catch {}
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const packagesDir = path.join(localAppData, "Microsoft", "WinGet", "Packages");
    try {
      for (const pkg of fs.readdirSync(packagesDir)) {
        if (!pkg.startsWith("Gyan.FFmpeg")) continue;
        for (const sub of fs.readdirSync(path.join(packagesDir, pkg))) {
          const binPath = path.join(packagesDir, pkg, sub, "bin", "ffmpeg.exe");
          if (fs.existsSync(binPath)) return path.join(packagesDir, pkg, sub, "bin");
        }
      }
    } catch {}
  }
  for (const dir of ["C:\\ffmpeg\\bin", "C:\\Program Files\\ffmpeg\\bin"]) {
    if (fs.existsSync(path.join(dir, "ffmpeg.exe"))) return dir;
  }
  return null;
}

const _dir = findFfmpegDir();
const FFMPEG = _dir ? path.join(_dir, "ffmpeg") : "ffmpeg";

const MAX_FRAMES = 30;

export interface YouTubeMeta {
  title: string;
  duration: number; // seconds
  videoId: string;
}

export interface YouTubeAnalysis {
  frames: string[];
  transcript: string;
  meta: YouTubeMeta;
}

/** 유튜브 URL에서 videoId 추출 */
export function extractVideoId(url: string): string | null {
  return url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{6,})/)?.[1] ?? null;
}

/** 유튜브 URL 여부 판정 */
export function isYouTubeUrl(url: string): boolean {
  return /(?:youtube\.com\/(?:watch|shorts|embed)|youtu\.be\/)/.test(url);
}

/** yt-dlp로 메타데이터(제목, 길이) 조회 (다운로드 전 사전 확인용) */
export async function probeMeta(url: string): Promise<YouTubeMeta> {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error("유효한 유튜브 URL이 아닙니다.");
  return getMeta(url, videoId);
}

/** yt-dlp로 메타데이터(제목, 길이) 조회 */
async function getMeta(url: string, videoId: string): Promise<YouTubeMeta> {
  try {
    const { stdout } = await execFileAsync(
      "yt-dlp",
      ["--print", "%(title)s\n%(duration)s", "--no-warnings", "--no-update", "--no-playlist", url],
      { timeout: 30000, windowsHide: true },
    );
    const [title, durationStr] = stdout.trim().split("\n");
    return { title: title || "", duration: parseFloat(durationStr) || 0, videoId };
  } catch {
    return { title: "", duration: 0, videoId };
  }
}

/** yt-dlp로 영상 다운로드 (720p 상한). 다운로드된 파일 경로 반환 */
async function downloadVideo(url: string, outDir: string, videoId: string): Promise<string> {
  const outTemplate = path.join(outDir, `yt_${videoId}.%(ext)s`);
  await execFileAsync(
    "yt-dlp",
    [
      "-f", "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]/best",
      "--merge-output-format", "mp4",
      "--no-warnings", "--no-update", "--no-playlist",
      "-o", outTemplate,
      url,
    ],
    { timeout: 180000, windowsHide: true, maxBuffer: 1024 * 1024 * 32 },
  );
  // 실제 생성된 파일 탐색 (확장자가 mp4가 아닐 수 있음)
  for (const ext of ["mp4", "mkv", "webm"]) {
    const p = path.join(outDir, `yt_${videoId}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  throw new Error("다운로드된 영상 파일을 찾지 못했습니다.");
}

/** 다운로드된 영상에서 최대 MAX_FRAMES장 균등 샘플링 */
async function extractFramesEven(
  videoPath: string,
  outDir: string,
  duration: number,
  videoId: string,
): Promise<string[]> {
  // 영상 길이에 맞춰 프레임 수 결정 (짧으면 적게, 길면 최대 30장)
  let frameCount: number;
  if (duration <= 0) frameCount = 5;
  else if (duration <= 30) frameCount = 6;
  else if (duration <= 120) frameCount = 12;
  else if (duration <= 600) frameCount = 20;
  else frameCount = MAX_FRAMES;

  const outputPattern = path.join(outDir, `ytf_${videoId}_%02d.jpg`);
  const fps = duration > 0 ? frameCount / duration : 0.2;

  await execFileAsync(
    FFMPEG,
    [
      "-i", videoPath,
      "-vf", `fps=${fps}`,
      "-frames:v", String(frameCount),
      "-q:v", "3",
      "-y",
      outputPattern,
    ],
    { timeout: 120000, windowsHide: true },
  );

  const frames: string[] = [];
  for (let i = 1; i <= frameCount; i++) {
    const fp = path.join(outDir, `ytf_${videoId}_${String(i).padStart(2, "0")}.jpg`);
    if (fs.existsSync(fp)) frames.push(fp);
  }
  return frames;
}

/** 유튜브 자막 추출 (ko 우선, 없으면 en, 자동생성 포함) */
async function fetchTranscript(url: string, outDir: string, videoId: string): Promise<string> {
  const outPath = path.join(outDir, `ytsub_${videoId}`);
  for (const lang of ["ko", "en"]) {
    const vttPath = `${outPath}.${lang}.vtt`;
    try {
      try { fs.unlinkSync(vttPath); } catch {}
      execFileSync(
        "yt-dlp",
        [
          "--write-auto-sub", "--write-sub", "--sub-lang", lang,
          "--skip-download", "--sub-format", "vtt",
          "--no-warnings", "--no-update", "--no-playlist",
          "-o", outPath, url,
        ],
        { timeout: 30000, windowsHide: true, stdio: "pipe" },
      );
    } catch {}
    if (fs.existsSync(vttPath)) {
      const vtt = fs.readFileSync(vttPath, "utf-8");
      const seen = new Set<string>();
      const texts: string[] = [];
      for (const line of vtt.split("\n")) {
        if (!line.trim() || line.startsWith("WEBVTT") || line.startsWith("Kind:") ||
            line.startsWith("Language:") || /^\d{2}:\d{2}/.test(line)) continue;
        const clean = line
          .replace(/<[^>]+>/g, "")
          .replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&")
          .replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
        if (clean && !seen.has(clean)) { seen.add(clean); texts.push(clean); }
      }
      try { fs.unlinkSync(vttPath); } catch {}
      const full = texts.join(" ");
      if (full.length > 50) return full.slice(0, 15000);
    }
  }
  return "";
}

/**
 * 유튜브 URL을 다운로드해 화면 프레임(최대 30장) + 자막을 확보한다.
 * claude-video 스타일: Claude가 화면을 직접 보고 분석할 수 있게 함.
 */
export async function analyzeYouTube(
  url: string,
  outDir: string,
  knownMeta?: YouTubeMeta,
): Promise<YouTubeAnalysis> {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error("유효한 유튜브 URL이 아닙니다.");

  fs.mkdirSync(outDir, { recursive: true });

  const meta = knownMeta ?? (await getMeta(url, videoId));

  // 자막과 영상 다운로드를 병렬 처리
  const [transcript, videoPath] = await Promise.all([
    fetchTranscript(url, outDir, videoId).catch(() => ""),
    downloadVideo(url, outDir, videoId),
  ]);

  const frames = await extractFramesEven(videoPath, outDir, meta.duration, videoId);

  // 원본 영상은 용량이 크므로 프레임 추출 후 즉시 삭제
  try { fs.unlinkSync(videoPath); } catch {}

  return { frames, transcript, meta };
}
