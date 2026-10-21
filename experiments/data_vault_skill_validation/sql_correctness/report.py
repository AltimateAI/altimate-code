"""Format the latest sql-correctness result JSON as a markdown report."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def load_latest(results_dir: Path) -> dict:
    files = sorted(results_dir.glob("sql_correctness_*.json"))
    if not files:
        print(f"No sql_correctness_*.json files in {results_dir}", file=sys.stderr)
        sys.exit(2)
    return json.loads(files[-1].read_text())


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path,
                   default=Path(__file__).resolve().parent / "results")
    args = p.parse_args()

    report = load_latest(args.input) if args.input.is_dir() else json.loads(args.input.read_text())

    print(f"# SQL Correctness Report — {report['timestamp']}\n")
    print(f"**{report['cases_passed']}/{report['total_cases']} cases passed**\n")

    # Group results by structure
    by_structure: dict[str, list[dict]] = {}
    for r in report["results"]:
        by_structure.setdefault(r["structure"], []).append(r)

    for structure, results in sorted(by_structure.items()):
        n_passed = sum(1 for r in results if r["passed"])
        print(f"## {structure.upper()} ({n_passed}/{len(results)})\n")
        print("| id | passed | expected | detected |")
        print("|---|:---:|---|---|")
        for r in results:
            emoji = "✅" if r["passed"] else "❌"
            exp = ", ".join(r["expected"]) or "—"
            det = ", ".join(r["detected"]) or "—"
            print(f"| `{r['id']}` | {emoji} | {exp} | {det} |")
        print()

    print("## Per-Rule Metrics\n")
    print("| rule | TP | FP | FN | precision | recall | F1 |")
    print("|---|--:|--:|--:|--:|--:|--:|")
    for m in report["rule_metrics"]:
        print(f"| `{m['rule']}` | {m['tp']} | {m['fp']} | {m['fn']} | "
              f"{m['precision']} | {m['recall']} | {m['f1']} |")


if __name__ == "__main__":
    main()
