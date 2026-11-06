"""Top-level runner — executes every data-vault-skill eval and produces a unified report.

Runs the four fast offline suites by default:
    - skill_structure
    - sql_correctness
    - knowledge_qa
    - platform_routing
    - agent_tasks (deterministic mode)

Exit code = number of failed suites (0 = all clean).

Usage:
    python run_all.py                 # all offline evals
    python run_all.py --skip agent_tasks
    python run_all.py --with-llm --model moonshotai/kimi-k2.6   # also run agent_tasks in LLM mode
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


HERE = Path(__file__).resolve().parent

# (suite_name, script_path, extra_args)
SUITES = [
    ("skill_structure",   HERE / "skill_structure/run.py",   []),
    ("sql_correctness",   HERE / "sql_correctness/run.py",   []),
    ("knowledge_qa",      HERE / "knowledge_qa/run.py",      []),
    ("platform_routing",  HERE / "platform_routing/run.py",  []),
    ("agent_tasks",       HERE / "agent_tasks/run.py",       ["--mode", "deterministic"]),
    ("e2e_dbt",           HERE / "e2e_dbt/run.py",           []),
]


def run_suite(name: str, script: Path, extra: list[str]) -> dict:
    start = time.perf_counter()
    proc = subprocess.run(
        [sys.executable, str(script), *extra],
        capture_output=True, text=True,
    )
    elapsed_s = round(time.perf_counter() - start, 3)
    return {
        "suite": name,
        "returncode": proc.returncode,
        "passed": proc.returncode == 0,
        "elapsed_s": elapsed_s,
        "stdout_tail": "\n".join(proc.stdout.splitlines()[-15:]),
        "stderr_tail": "\n".join(proc.stderr.splitlines()[-10:]) if proc.stderr else "",
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--skip", nargs="*", default=[],
                   help="suite names to skip")
    p.add_argument("--with-llm", action="store_true",
                   help="also run agent_tasks in --mode llm")
    p.add_argument("--model", type=str, default=None,
                   help="model for LLM mode (required with --with-llm)")
    args = p.parse_args()

    suites_to_run = [s for s in SUITES if s[0] not in args.skip]

    results = []
    for name, script, extra in suites_to_run:
        print(f"\n▶ Running {name} …")
        r = run_suite(name, script, extra)
        results.append(r)
        status = "✅" if r["passed"] else "❌"
        print(f"{status} {name}: exit {r['returncode']} in {r['elapsed_s']}s")

    if args.with_llm:
        if not args.model:
            print("ERROR: --with-llm requires --model", file=sys.stderr)
            sys.exit(2)
        print(f"\n▶ Running agent_tasks (LLM mode, model={args.model}) …")
        r = run_suite(
            "agent_tasks_llm",
            HERE / "agent_tasks/run.py",
            ["--mode", "llm", "--model", args.model],
        )
        results.append(r)
        status = "✅" if r["passed"] else "❌"
        print(f"{status} agent_tasks_llm: exit {r['returncode']} in {r['elapsed_s']}s")

    passed = sum(1 for r in results if r["passed"])
    failed = len(results) - passed

    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "total_suites": len(results),
        "suites_passed": passed,
        "suites_failed": failed,
        "results": results,
    }

    print(f"\n{'=' * 70}")
    print(f"UNIFIED REPORT — {report['timestamp']}")
    print(f"{'=' * 70}")
    for r in results:
        status = "PASS" if r["passed"] else "FAIL"
        print(f"[{status}] {r['suite']:<25} exit={r['returncode']}  {r['elapsed_s']}s")
    print(f"\n{passed}/{len(results)} suites passed")

    if failed:
        print(f"\n{'-' * 70}\nFailed suite output (last 15 lines):")
        for r in results:
            if not r["passed"]:
                print(f"\n>>> {r['suite']} <<<")
                print(r["stdout_tail"])
                if r["stderr_tail"]:
                    print(f"[stderr]\n{r['stderr_tail']}")

    out_dir = HERE / "results"
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = report["timestamp"].replace(":", "-").replace(".", "-")
    out_file = out_dir / f"run_all_{ts}.json"
    out_file.write_text(json.dumps(report, indent=2))
    print(f"\nUnified report: {out_file}")

    sys.exit(failed)


if __name__ == "__main__":
    main()
