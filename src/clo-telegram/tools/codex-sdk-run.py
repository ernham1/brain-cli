import argparse
import json
import sys
from pathlib import Path

from openai_codex import Codex, CodexError, Sandbox, retry_on_overload


SANDBOX_PRESETS = {
    "read_only": Sandbox.read_only,
    "workspace_write": Sandbox.workspace_write,
    "full_access": Sandbox.full_access,
}


def _read_text(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def _usage_to_dict(usage) -> dict:
    if not usage or not getattr(usage, "total", None):
        return {}
    total = usage.total
    return {
        "input_tokens": getattr(total, "input_tokens", None),
        "output_tokens": getattr(total, "output_tokens", None),
        "total_tokens": getattr(total, "total_tokens", None),
    }


def run_codex_turn(args: argparse.Namespace) -> dict:
    sandbox = SANDBOX_PRESETS[args.sandbox]
    prompt = _read_text(args.prompt_file)
    base_instructions = _read_text(args.base_instructions_file) if args.base_instructions_file else None
    model = args.model.strip() or None

    with Codex() as codex:
        thread = codex.thread_start(
            cwd=args.cwd or None,
            model=model,
            sandbox=sandbox,
            base_instructions=base_instructions,
        )
        result = thread.run(prompt)

    return {
        "ok": str(result.status) == "TurnStatus.completed",
        "status": str(result.status),
        "error": str(result.error) if result.error else None,
        "final_response": result.final_response or "",
        "duration_ms": result.duration_ms,
        "usage": _usage_to_dict(result.usage),
        "thread_id": getattr(result, "thread_id", None),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run one Codex SDK turn and emit JSON.")
    parser.add_argument("--prompt-file", required=True)
    parser.add_argument("--out-file")
    parser.add_argument("--base-instructions-file")
    parser.add_argument("--cwd")
    parser.add_argument("--model", default="")
    parser.add_argument(
        "--sandbox",
        choices=sorted(SANDBOX_PRESETS.keys()),
        default="read_only",
    )
    args = parser.parse_args()

    try:
        payload = retry_on_overload(lambda: run_codex_turn(args), max_attempts=3)
    except CodexError as exc:
        payload = {
            "ok": False,
            "status": "CodexError",
            "error": str(exc),
            "final_response": "",
            "duration_ms": None,
            "usage": {},
        }
    except Exception as exc:
        payload = {
            "ok": False,
            "status": type(exc).__name__,
            "error": str(exc),
            "final_response": "",
            "duration_ms": None,
            "usage": {},
        }

    encoded = json.dumps(payload, ensure_ascii=False)
    if args.out_file:
        Path(args.out_file).write_text(encoded, encoding="utf-8")
    else:
        print(encoded)

    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
