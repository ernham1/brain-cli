import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * 이미지 생성 백엔드: Codex 구독 경로 (codex exec + 내장 image_gen 도구).
 *
 * 왜 이 경로인가 (2026-07-16, 이사님 지시):
 *   기존 image-gen.ts는 image_gen.py를 OPENAI_API_KEY로 직접 호출 → 이미지당 API 유료 과금.
 *   Codex 내장 image_gen 도구는 auth.json(ChatGPT 구독 로그인)으로 돌아 별도 API 요금이 없다.
 *   외부(텔레클로)에서 그 구독 경로를 태우는 공식 방법은 `codex exec`로 코덱스에게
 *   이미지 생성을 지시하고, 코덱스가 내장 도구로 만든 PNG 경로를 회수하는 것.
 *   → API 키 과금 없이 구독 사용량만 소모. 단 1회 90~150초 소요(내장 도구가 느림).
 *
 * 요구: 이 PC에 codex CLI(>=0.144) 로그인(auth.json) + ~/.codex 접근.
 */

/** 지원 사이즈. 프레젠테이션/문서 삽입 기본은 3:2 가로. */
export type ImageSize =
  | "1024x1024"   // 1:1 정사각
  | "1536x1024"   // 3:2 가로 (기본)
  | "1024x1536";  // 2:3 세로

export interface ImageGenOptions {
  size?: ImageSize;
  chatId: number;
}

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
/** codex 실행 파일 (환경변수 우선). PM2 PATH엔 npm global bin이 없어 절대경로로 지정. */
const CODEX_BIN = process.env.CLO_CODEX_BIN
  || "C:\\Users\\ernham\\AppData\\Roaming\\npm\\codex.cmd";
/** codex exec에 지정할 모델 (환경변수로 덮어쓸 수 있음). 비우면 config.toml 기본값 사용 */
const CODEX_MODEL = process.env.CLO_CODEX_MODEL || "";
const GEN_TIMEOUT_MS = 300_000; // 구독 경로는 90~150초, 여유 있게 5분

const SIZE_LABEL: Record<ImageSize, string> = {
  "1024x1024": "1:1 정사각(1024x1024)",
  "1536x1024": "3:2 가로(1536x1024)",
  "1024x1536": "2:3 세로(1024x1536)",
};

/**
 * codex exec로 코덱스에게 이미지 생성을 지시하고, 생성된 PNG 절대경로를 회수한다.
 * 성공 시 파일 경로, 실패 시 null.
 */
function generateViaCodex(
  prompt: string,
  size: ImageSize,
): Promise<string | null> {
  return new Promise((resolve) => {
    // 프롬프트를 인라인 한 줄로 삽입한다. 멀티라인 [이미지 설명] 블록을 쓰면
    // codex가 별개 지시로 오해해 "설명 누락"이라며 되물어 실패한다(2026-07-16 확인).
    const inlinePrompt = prompt.replace(/'/g, "’").replace(/\r?\n/g, " ").trim();
    const instruction =
      `imagegen 스킬(Codex 내장 image_gen 도구)로 이미지를 생성해줘. ` +
      `이미지 내용: '${inlinePrompt}'. ` +
      `크기 ${SIZE_LABEL[size]}. ` +
      `image_gen.py(CLI fallback)는 쓰지 말고 반드시 내장 도구를 사용해. ` +
      `완료되면 저장된 PNG 절대경로를 마지막 줄에 IMGPATH=<경로> 형식으로만 출력해줘.`;

    const args = [
      "exec",
      "--skip-git-repo-check",
      "--sandbox", "workspace-write",
    ];
    if (CODEX_MODEL) {
      args.push("-m", CODEX_MODEL);
    }
    args.push(instruction);

    console.log(`[Clo] codex exec 이미지 생성: "${prompt.slice(0, 70)}..." (${size})`);

    const child = spawn(CODEX_BIN, args, {
      cwd: CODEX_HOME,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"], // stdin 닫아 "reading from stdin" 대기 방지
      shell: CODEX_BIN.toLowerCase().endsWith(".cmd"), // Windows .cmd는 shell 경유 필요
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      console.error(`[Clo] codex exec 이미지 생성 타임아웃 (${GEN_TIMEOUT_MS / 1000}초)`);
      resolve(null);
    }, GEN_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      const combined = stdout + "\n" + stderr;
      // IMGPATH= 뒤 경로 회수 (여러 번 찍히면 마지막 것)
      const matches = [...combined.matchAll(/IMGPATH=(.+?)\s*$/gim)];
      const imgPath = matches.length
        ? matches[matches.length - 1][1].trim().replace(/^["']|["']$/g, "")
        : null;

      if (imgPath && fs.existsSync(imgPath)) {
        resolve(imgPath);
        return;
      }
      // 경로 회수 실패 시: generated_images에서 방금 생성된 최신 PNG를 폴백 탐색
      const fallback = findLatestGeneratedImage();
      if (fallback) {
        console.warn(`[Clo] IMGPATH 회수 실패 → 최신 생성 이미지로 폴백: ${fallback}`);
        resolve(fallback);
        return;
      }
      const tail = combined.trim().split("\n").slice(-4).join(" / ");
      console.error(`[Clo] codex exec 이미지 생성 실패 (code ${code}): ${tail}`);
      resolve(null);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      console.error(`[Clo] codex exec 프로세스 오류:`, err.message);
      resolve(null);
    });
  });
}

/** generated_images 하위에서 가장 최근 수정된 .png를 찾는다 (IMGPATH 회수 실패 폴백). */
function findLatestGeneratedImage(): string | null {
  const root = path.join(CODEX_HOME, "generated_images");
  if (!fs.existsSync(root)) return null;
  let latestPath: string | null = null;
  let latestM = 0;
  const now = Date.now();
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.toLowerCase().endsWith(".png")) continue;
      try {
        const m = fs.statSync(full).mtimeMs;
        // 최근 5분 내 생성된 것만 (이번 실행 결과로 한정)
        if (now - m > 5 * 60 * 1000) continue;
        if (m > latestM) { latestM = m; latestPath = full; }
      } catch { /* 무시 */ }
    }
  };
  walk(root);
  return latestPath;
}

/**
 * 이미지를 생성하고 텔레그램으로 전송합니다.
 * 백엔드: Codex 구독 경로(codex exec). 실패 시 명확히 실패 메시지 반환.
 */
export async function generateImage(
  prompt: string,
  options: ImageGenOptions,
): Promise<string> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return "텔레그램 봇 토큰이 없습니다.";
  }

  const size = options.size || "1536x1024";
  console.log(`[Clo] 이미지 생성 요청: Codex 구독 경로, size=${size}`);

  const imgPath = await generateViaCodex(prompt, size);
  if (!imgPath) {
    return "이미지 생성에 실패했습니다. (Codex 구독 경로)";
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(imgPath);
  } catch (e) {
    console.error(`[Clo] 생성 이미지 읽기 실패: ${imgPath}`, e);
    return "이미지는 생성됐지만 파일을 읽지 못했습니다.";
  }
  console.log(`[Clo] 이미지 확보: ${imgPath} (${(buffer.length / 1024).toFixed(0)}KB)`);

  // 텔레그램 전송
  const fileName = path.basename(imgPath);
  const caption = prompt.length > 200 ? prompt.slice(0, 197) + "..." : prompt;
  const formData = new FormData();
  formData.append("chat_id", String(options.chatId));
  formData.append("photo", new Blob([new Uint8Array(buffer)], { type: "image/png" }), fileName);
  formData.append("caption", caption);

  const sendResponse = await fetch(
    `https://api.telegram.org/bot${botToken}/sendPhoto`,
    { method: "POST", body: formData },
  );

  if (!sendResponse.ok) {
    const errText = await sendResponse.text().catch(() => "");
    console.error(`[Clo] 텔레그램 전송 실패: ${errText}`);
    return "이미지 생성은 성공했지만 텔레그램 전송에 실패했습니다.";
  }

  console.log(`[Clo] 이미지 전송 완료 [Codex 구독] (chat: ${options.chatId})`);
  return `이미지를 생성하여 전송했습니다. (${size}, Codex 구독 경로)`;
}
