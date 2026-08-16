import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

export interface VideoMeta {
  duration: number;
  width: number;
  height: number;
}

export interface ExtractResult {
  frames: string[];
  meta: VideoMeta;
}

/** ffmpeg bin 디렉토리 탐지 (PATH에 있으면 null) */
function findFfmpegDir(): string | null {
  // 1. PATH에서 찾기
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore", windowsHide: true });
    return null;
  } catch {}

  // 2. winget 설치 경로 검색
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

  // 3. 일반적인 설치 경로
  for (const dir of ["C:\\ffmpeg\\bin", "C:\\Program Files\\ffmpeg\\bin"]) {
    if (fs.existsSync(path.join(dir, "ffmpeg.exe"))) return dir;
  }

  return null;
}

const _dir = findFfmpegDir();
const FFMPEG = _dir ? path.join(_dir, "ffmpeg") : "ffmpeg";
const FFPROBE = _dir ? path.join(_dir, "ffprobe") : "ffprobe";

if (_dir) {
  console.log(`[Clo] ffmpeg 경로: ${_dir}`);
}

/** ffprobe로 동영상 메타데이터 조회 */
async function getVideoMeta(videoPath: string): Promise<VideoMeta> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    videoPath,
  ], { timeout: 10000, windowsHide: true });

  const info = JSON.parse(stdout);
  const stream = info.streams?.find(
    (s: Record<string, unknown>) => s.codec_type === "video",
  );

  return {
    duration: parseFloat(info.format?.duration || "0"),
    width: (stream?.width as number) || 0,
    height: (stream?.height as number) || 0,
  };
}

/** ffmpeg로 주요 프레임 추출 */
export async function extractFrames(
  videoPath: string,
  outputDir: string,
): Promise<ExtractResult> {
  const meta = await getVideoMeta(videoPath);

  // 영상 길이에 따라 프레임 수 결정
  let frameCount: number;
  if (meta.duration <= 0) frameCount = 1;
  else if (meta.duration <= 10) frameCount = 3;
  else if (meta.duration <= 60) frameCount = 6;
  else frameCount = 10;

  const prefix = path.basename(videoPath, path.extname(videoPath));
  const outputPattern = path.join(outputDir, `${prefix}_f%02d.jpg`);
  const fps = meta.duration > 0 ? frameCount / meta.duration : 1;

  await execFileAsync(FFMPEG, [
    "-i", videoPath,
    "-vf", `fps=${fps}`,
    "-frames:v", String(frameCount),
    "-q:v", "2",
    "-y",
    outputPattern,
  ], { timeout: 60000, windowsHide: true });

  // 추출된 프레임 파일 목록 수집
  const frames: string[] = [];
  for (let i = 1; i <= frameCount; i++) {
    const fp = path.join(
      outputDir,
      `${prefix}_f${String(i).padStart(2, "0")}.jpg`,
    );
    if (fs.existsSync(fp)) frames.push(fp);
  }

  return { frames, meta };
}
