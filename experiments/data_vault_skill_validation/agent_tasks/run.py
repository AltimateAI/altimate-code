"""Agent-task eval — grade answers to end-to-end DV tasks.

Two modes:

  --mode deterministic (default)
      For every task, use `reference_answer` from the dataset as the
      candidate answer. Verifies that the graders themselves work
      correctly given a known-good answer. This is a regression test
      for the grader logic + a smoke test for the dataset.

  --mode llm
      Send each task's `task` field to an LLM together with the skill
      content. Grade the LLM's response. Requires an OPENROUTER_API_KEY
      (or --api-key) and --model. Slow, non-deterministic, opt-in.

Exit codes:
    0 = all tasks pass their graders
    1 = at least one failure
    2 = harness/dataset error

Usage:
    python run.py --mode deterministic
    python run.py --mode llm --model moonshotai/kimi-k2.6
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from graders import GRADERS  # noqa: E402


DEFAULT_SKILL_ROOT = Path(__file__).resolve().parents[3] / ".opencode" / "skills" / "data-vault"


def load_skill_context(skill_root: Path) -> str:
    """Concatenate SKILL.md + every reference file as one big context blob."""
    parts = [(skill_root / "SKILL.md").read_text()]
    for md in sorted((skill_root / "references").glob("*.md")):
        parts.append(f"\n\n===== {md.name} =====\n\n{md.read_text()}")
    return "\n".join(parts)


def call_llm(prompt: str, model: str, api_key: str) -> str:
    """Best-effort LLM call via OpenRouter's HTTP API. Requires `requests` library."""
    try:
        import requests
    except ImportError:
        raise RuntimeError("`requests` not installed; run `pip install requests` for LLM mode")

    resp = requests.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.0,
        },
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def run_case(case: dict, mode: str, skill_context: str | None,
             model: str | None, api_key: str | None) -> dict:
    grader_name = case["grader"]
    grader = GRADERS.get(grader_name)
    if grader is None:
        return {
            "id": case["id"],
            "task": case["task"],
            "passed": False,
            "grader": grader_name,
            "detail": f"unknown grader: {grader_name}",
            "answer_source": "n/a",
        }

    if mode == "deterministic":
        # Use the reference_answer for phrase-based graders;
        # sql_correctness graders don't need any answer.
        answer = case.get("reference_answer", "")
        answer_source = "reference_answer"
    elif mode == "llm":
        prompt = (
            "You are an expert in Data Vault 2.0. Use the following skill "
            "documentation to answer the task at the end.\n\n"
            f"{skill_context}\n\n"
            f"TASK: {case['task']}\n\nAnswer:"
        )
        try:
            answer = call_llm(prompt, model=model, api_key=api_key)
        except Exception as e:
            return {
                "id": case["id"],
                "task": case["task"],
                "passed": False,
                "grader": grader_name,
                "detail": f"LLM call failed: {e!r}",
                "answer_source": "llm",
            }
        answer_source = "llm"
    else:
        raise ValueError(f"unknown mode: {mode}")

    passed, detail = grader(answer, case.get("grader_args", {}))
    return {
        "id": case["id"],
        "task": case["task"],
        "passed": passed,
        "grader": grader_name,
        "detail": detail,
        "answer_source": answer_source,
        # Only include the LLM answer in output when LLM mode was used
        **({"llm_answer": answer} if mode == "llm" else {}),
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path,
                   default=Path(__file__).resolve().parent / "dataset.json")
    p.add_argument("--output", type=Path,
                   default=Path(__file__).resolve().parent / "results")
    p.add_argument("--skill-root", type=Path, default=DEFAULT_SKILL_ROOT)
    p.add_argument("--mode", choices=["deterministic", "llm"], default="deterministic")
    p.add_argument("--model", type=str, default=None,
                   help="Model ID for LLM mode (e.g. moonshotai/kimi-k2.6)")
    p.add_argument("--api-key", type=str, default=None,
                   help="OpenRouter API key (overrides OPENROUTER_API_KEY env)")
    args = p.parse_args()

    if not args.input.is_file():
        print(f"ERROR: dataset not found: {args.input}", file=sys.stderr)
        sys.exit(2)

    try:
        dataset = json.loads(args.input.read_text())
    except json.JSONDecodeError as e:
        print(f"ERROR: dataset is not valid JSON: {e}", file=sys.stderr)
        sys.exit(2)

    skill_context = None
    api_key = None
    if args.mode == "llm":
        if not args.model:
            print("ERROR: --model is required for --mode llm", file=sys.stderr)
            sys.exit(2)
        api_key = args.api_key or os.environ.get("OPENROUTER_API_KEY")
        if not api_key:
            print("ERROR: set OPENROUTER_API_KEY or pass --api-key for --mode llm",
                  file=sys.stderr)
            sys.exit(2)
        if not args.skill_root.is_dir():
            print(f"ERROR: skill root not found: {args.skill_root}", file=sys.stderr)
            sys.exit(2)
        skill_context = load_skill_context(args.skill_root)

    results = [
        run_case(c, args.mode, skill_context, args.model, api_key)
        for c in dataset
    ]
    passed = sum(1 for r in results if r["passed"])
    failed = len(results) - passed

    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "mode": args.mode,
        "model": args.model,
        "total_tasks": len(results),
        "tasks_passed": passed,
        "tasks_failed": failed,
        "results": results,
    }

    print(f"\n{'=' * 70}")
    print(f"AGENT TASKS EVAL — {report['timestamp']} — mode={args.mode}")
    print(f"{'=' * 70}")
    for r in results:
        status = "PASS" if r["passed"] else "FAIL"
        print(f"[{status}] {r['id']}  (grader={r['grader']})")
        if not r["passed"]:
            print(f"    ✗ {r['detail']}")

    print(f"\n{'=' * 70}")
    print(f"{passed}/{len(results)} tasks passed")
    print(f"{'=' * 70}\n")

    args.output.mkdir(parents=True, exist_ok=True)
    ts = report["timestamp"].replace(":", "-").replace(".", "-")
    out_file = args.output / f"agent_tasks_{ts}.json"
    out_file.write_text(json.dumps(report, indent=2))
    print(f"Report written to: {out_file}")

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
