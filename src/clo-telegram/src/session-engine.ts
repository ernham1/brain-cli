// SessionEngine(멀티세션 오케스트레이션 엔진) 클라이언트 — 텔레클로용
// 엔진은 WSL에서 돌고(기본 127.0.0.1:4870), WSL2 localhost 포워딩으로 Windows에서 직접 호출한다.
// 정본 API: D:/Projects/SessionEngine/src/engine.mjs (+ 정본 클라이언트 src/client.mjs)
// 배선일: 2026-08-10 (핸드오프 "텔레클로 클라이언트 연동" 항목)

const SESSION_ENGINE_URL = (process.env.SESSION_ENGINE_URL || "http://127.0.0.1:4870").replace(/\/$/, "");
const SESSION_ENGINE_TOKEN = process.env.SESSION_ENGINE_TOKEN || "dev-token";

export interface SessionEngineInput {
  op:
    | "health"
    | "create_project"
    | "list_projects"
    | "delete_project"
    | "list_sessions"
    | "spawn_session"
    | "send_message"
    | "get_logs"
    | "stop_session"
    | "list_tasks"
    | "close_task";
  projectId?: string;
  sessionId?: string;
  name?: string;
  prompt?: string;
  text?: string;
  model?: string;
  effort?: string;
  role?: string;
  /** 봉투 (설계서 01-멀티세션-규칙 1-1). send_message에서 사용 */
  taskId?: string;
  kind?: "task" | "done" | "report" | "info" | "ping";
  from?: string;
  deadline?: string;
  context?: string;
  /** create_project 전용: true면 오케스트레이터 세션을 스폰하지 않고
   *  호출자(데탑클로/텔레클로 자신)가 오케스트레이터가 된다. 이때 prompt 불필요. */
  external?: boolean;
}

async function engineRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(SESSION_ENGINE_URL + path, {
      method,
      headers: { "x-se-token": SESSION_ENGINE_TOKEN, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = (data as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`${res.status}: ${msg}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function requireFields(input: SessionEngineInput, fields: (keyof SessionEngineInput)[]): string | null {
  const missing = fields.filter((f) => !input[f]);
  return missing.length ? `필수 필드 누락: ${missing.join(", ")} (op=${input.op})` : null;
}

export async function executeSessionEngine(input: SessionEngineInput): Promise<string> {
  const op = input.op;
  if (!op) return "op 필드가 필요합니다.";

  // 엔진 생존 선확인 (health 자체 요청은 제외)
  if (op !== "health") {
    try {
      await engineRequest("GET", "/health", undefined, 5000);
    } catch {
      return [
        "SessionEngine이 응답하지 않습니다 (엔진 미기동 추정).",
        "WSL에서 기동: cd /mnt/d/Projects/SessionEngine && SE_TOKEN=<토큰> setsid nohup node src/engine.mjs > /tmp/se-engine.log 2>&1 < /dev/null & disown",
        `현재 설정: ${SESSION_ENGINE_URL} (토큰은 SESSION_ENGINE_TOKEN 환경변수와 일치해야 함)`,
      ].join("\n");
    }
  }

  try {
    switch (op) {
      case "health": {
        try {
          const h = await engineRequest("GET", "/health", undefined, 5000);
          return `엔진 정상: ${JSON.stringify(h)}`;
        } catch (e) {
          return `엔진 미응답: ${(e as Error).message}`;
        }
      }
      case "create_project": {
        // external:true면 오케스트레이터를 스폰하지 않으므로 prompt 불필요(name만 필수).
        const required: (keyof SessionEngineInput)[] = input.external
          ? ["name"]
          : ["name", "prompt"];
        const miss = requireFields(input, required);
        if (miss) return miss;
        const r = await engineRequest("POST", "/projects", {
          name: input.name, prompt: input.prompt, model: input.model,
          effort: input.effort, external: input.external === true ? true : undefined,
        }, 60000);
        return input.external
          ? `외부 오케스트레이터 프로젝트 생성됨(호출자가 오케스트레이터): ${JSON.stringify(r)}`
          : `프로젝트 생성됨: ${JSON.stringify(r)}`;
      }
      case "list_projects": {
        const r = await engineRequest("GET", "/projects");
        return `프로젝트 목록: ${JSON.stringify(r)}`;
      }
      case "delete_project": {
        const miss = requireFields(input, ["projectId"]);
        if (miss) return miss;
        const r = await engineRequest("DELETE", `/projects/${input.projectId}`, undefined, 60000);
        return `프로젝트 종료됨: ${JSON.stringify(r)}`;
      }
      case "list_sessions": {
        const miss = requireFields(input, ["projectId"]);
        if (miss) return miss;
        const r = await engineRequest("GET", `/projects/${input.projectId}/sessions`);
        return `세션 목록: ${JSON.stringify(r)}`;
      }
      case "spawn_session": {
        const miss = requireFields(input, ["projectId", "name", "prompt"]);
        if (miss) return miss;
        const r = await engineRequest("POST", `/projects/${input.projectId}/sessions`, {
          name: input.name, prompt: input.prompt, model: input.model,
          effort: input.effort, role: input.role,
        }, 60000);
        return `세션 기동됨: ${JSON.stringify(r)}`;
      }
      case "send_message": {
        const miss = requireFields(input, ["projectId", "sessionId", "text"]);
        if (miss) return miss;
        // 봉투 규약 (설계서 1-1): taskId 미지정 시 자동 생성, kind 기본 info, from 기본 teleclo
        const taskId = input.taskId
          || "tsk-" + Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
        const kind = input.kind || "info";
        if (kind === "task" && !input.deadline) {
          return "kind=task는 deadline(ISO8601) 필수입니다. 과제 크기를 보고 기한을 정해 주세요.";
        }
        const r = await engineRequest(
          "POST",
          `/projects/${input.projectId}/sessions/${input.sessionId}/message`,
          {
            taskId, kind, from: input.from || "teleclo", text: input.text,
            ...(input.deadline ? { deadline: input.deadline } : {}),
            ...(input.context ? { context: input.context } : {}),
          },
          120000,
        );
        return `라우팅 결과: ${JSON.stringify(r)}`;
      }
      case "list_tasks": {
        const miss = requireFields(input, ["projectId"]);
        if (miss) return miss;
        const r = await engineRequest("GET", `/projects/${input.projectId}/tasks`);
        return `과제 장부: ${JSON.stringify(r)}`;
      }
      case "close_task": {
        const miss = requireFields(input, ["projectId", "taskId"]);
        if (miss) return miss;
        const r = await engineRequest("POST", `/projects/${input.projectId}/tasks/${input.taskId}/close`);
        return `과제 마감됨: ${JSON.stringify(r)}`;
      }
      case "get_logs": {
        const miss = requireFields(input, ["projectId", "sessionId"]);
        if (miss) return miss;
        const r = await engineRequest("GET", `/projects/${input.projectId}/sessions/${input.sessionId}/logs`) as { logs?: string };
        const logs = r.logs ?? "";
        // LLM 컨텍스트 보호: 로그 꼬리 4000자만
        const tail = logs.length > 4000 ? `...(앞 ${logs.length - 4000}자 생략)\n${logs.slice(-4000)}` : logs;
        return `세션 로그(${logs.length}자):\n${tail}`;
      }
      case "stop_session": {
        const miss = requireFields(input, ["projectId", "sessionId"]);
        if (miss) return miss;
        const r = await engineRequest("DELETE", `/projects/${input.projectId}/sessions/${input.sessionId}`);
        return `세션 종료됨: ${JSON.stringify(r)}`;
      }
      default:
        return `알 수 없는 op: ${String(op)}`;
    }
  } catch (e) {
    return `SessionEngine 오류 (op=${op}): ${(e as Error).message}`;
  }
}
