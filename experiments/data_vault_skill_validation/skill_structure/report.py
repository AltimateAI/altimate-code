"""Format the latest structure-eval result JSON into a readable report."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def load_latest(results_dir: Path) -> dict:
    files = sorted(results_dir.glob("structure_*.json"))
    if not files:
        print(f"No structure_*.json files in {results_dir}", file=sys.stderr)
        sys.exit(2)
    return json.loads(files[-1].read_text())


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path,
                   default=Path(__file__).resolve().parent / "results")
    args = p.parse_args()

    report = load_latest(args.input) if args.input.is_dir() else json.loads(args.input.read_text())

    print(f"# Skill Structure Report — {report['timestamp']}\n")
    print(f"skill_root: `{report['skill_root']}`")
    print(f"\n**{report['checks_passed']}/{report['total_checks']} checks passed**\n")

    for r in report["results"]:
        emoji = "✅" if r["passed"] else "❌"
        print(f"## {emoji} `{r['name']}`")
        print(f"- pass: {r['pass_count']}, fail: {r['fail_count']}")
        if r["failures"]:
            print("- failures:")
            for f in r["failures"]:
                print(f"  - {f}")
        print()


if __name__ == "__main__":
    main()
