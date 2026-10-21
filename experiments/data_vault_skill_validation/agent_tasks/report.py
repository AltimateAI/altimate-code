"""Format the latest agent-tasks result JSON as a markdown report."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def load_latest(results_dir: Path) -> dict:
    files = sorted(results_dir.glob("agent_tasks_*.json"))
    if not files:
        print(f"No agent_tasks_*.json files in {results_dir}", file=sys.stderr)
        sys.exit(2)
    return json.loads(files[-1].read_text())


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path,
                   default=Path(__file__).resolve().parent / "results")
    args = p.parse_args()

    report = load_latest(args.input) if args.input.is_dir() else json.loads(args.input.read_text())

    print(f"# Agent Tasks Report — {report['timestamp']}\n")
    print(f"mode: `{report['mode']}`  |  model: `{report.get('model') or '—'}`")
    print(f"\n**{report['tasks_passed']}/{report['total_tasks']} tasks passed**\n")

    print("| id | passed | grader | detail |")
    print("|---|:---:|---|---|")
    for r in report["results"]:
        emoji = "✅" if r["passed"] else "❌"
        print(f"| `{r['id']}` | {emoji} | `{r['grader']}` | {r['detail']} |")


if __name__ == "__main__":
    main()
