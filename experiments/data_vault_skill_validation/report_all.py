"""Print the latest unified-report JSON."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


HERE = Path(__file__).resolve().parent


def load_latest(results_dir: Path) -> dict:
    files = sorted(results_dir.glob("run_all_*.json"))
    if not files:
        print(f"No run_all_*.json files in {results_dir}", file=sys.stderr)
        sys.exit(2)
    return json.loads(files[-1].read_text())


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path, default=HERE / "results")
    args = p.parse_args()

    report = load_latest(args.input) if args.input.is_dir() else json.loads(args.input.read_text())

    print(f"# Unified Data Vault Skill Eval Report — {report['timestamp']}\n")
    print(f"**{report['suites_passed']}/{report['total_suites']} suites passed**\n")

    print("| suite | passed | exit | elapsed (s) |")
    print("|---|:---:|--:|--:|")
    for r in report["results"]:
        emoji = "✅" if r["passed"] else "❌"
        print(f"| `{r['suite']}` | {emoji} | {r['returncode']} | {r['elapsed_s']} |")


if __name__ == "__main__":
    main()
