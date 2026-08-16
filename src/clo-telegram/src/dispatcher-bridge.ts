import { execFile } from "node:child_process";

const PYTHON_EXE =
  process.env.PYTHON_EXE ??
  "C:/Users/ernham/AppData/Local/Programs/Python/Python313/python.exe";

const NFX_OLLAMA_DIR = "D:/Projects/rtx6000pro";

export interface SuggestOption {
  model: string;
  alias: string;
  description: string;
  recommended: boolean;
  available: boolean;
}

export interface DispatchResult {
  model: string;
  alias: string;
  output: string;
  reason: string;
  elapsed: number;
}

/** nfx-ollama Python 호출 공통 래퍼 */
function runPython(script: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      PYTHON_EXE,
      ["-X", "utf8", "-c", script],
      {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          if (signal?.aborted) return reject(new Error("CANCELLED"));
          const detail = stderr?.slice(0, 300) ?? err.message;
          return reject(new Error(detail));
        }
        resolve(stdout.trim());
      },
    );

    // AbortSignal 연결 — abort 시 Python 프로세스 강제 종료
    if (signal) {
      signal.addEventListener("abort", () => {
        child.kill("SIGTERM");
        reject(new Error("CANCELLED"));
      }, { once: true });
    }
  });
}

/**
 * suggest_for_api() 호출 — 모델 추천 목록 반환 (15초 타임아웃)
 */
export async function suggestModels(prompt: string): Promise<SuggestOption[]> {
  const escaped = JSON.stringify(prompt);
  const script = [
    `import json, sys`,
    `sys.path.insert(0, ${JSON.stringify(NFX_OLLAMA_DIR)})`,
    `from nfx_ollama.dispatcher import suggest_for_api`,
    `print(json.dumps(suggest_for_api(${escaped}), ensure_ascii=False))`,
  ].join("\n");

  const raw = await runPython(script, 15_000);
  try {
    return JSON.parse(raw) as SuggestOption[];
  } catch {
    throw new Error(`suggest 응답 파싱 실패: ${raw.slice(0, 200)}`);
  }
}

/**
 * 특정 모델에 직접 질의 — dispatchToLocal(prompt, "젬마") 형식으로 호출
 * model 생략 시 nfx-ollama dispatch()가 자동 선택
 */
export async function dispatchToLocal(
  prompt: string,
  model?: string,
  signal?: AbortSignal,
): Promise<DispatchResult> {
  const escaped = JSON.stringify(prompt);

  const script = model
    ? [
        `import json, sys, time`,
        `sys.path.insert(0, ${JSON.stringify(NFX_OLLAMA_DIR)})`,
        `from nfx_ollama import ask, resolve_model`,
        `m = resolve_model(${JSON.stringify(model)})`,
        `t0 = time.time()`,
        `output = ask(m, ${escaped})`,
        `print(json.dumps({"model": m, "alias": ${JSON.stringify(model)}, "output": output, "reason": "직접 지정", "elapsed": round(time.time()-t0, 1)}, ensure_ascii=False))`,
      ].join("\n")
    : [
        `import json, sys`,
        `sys.path.insert(0, ${JSON.stringify(NFX_OLLAMA_DIR)})`,
        `from nfx_ollama.dispatcher import dispatch`,
        `r = dispatch(${escaped})`,
        `print(json.dumps({"model": r.model, "alias": r.alias, "output": r.output, "reason": r.reason, "elapsed": round(r.elapsed_seconds, 1)}, ensure_ascii=False))`,
      ].join("\n");

  const raw = await runPython(script, 300_000, signal); // 5분 (대형 모델 로딩 포함)
  try {
    return JSON.parse(raw) as DispatchResult;
  } catch {
    throw new Error(`dispatch 응답 파싱 실패: ${raw.slice(0, 500)}`);
  }
}
