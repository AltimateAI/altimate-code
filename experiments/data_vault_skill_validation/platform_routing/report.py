"""Format the latest platform-routing result JSON as a markdown report."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def load_latest(results_dir: Path) -> dict:
    files = sorted(results_dir.glob("platform_routing_*.json"))
    if not files:
        print(f"No platform_routing_*.json files in {results_dir}", file=sys.stderr)
        sys.exit(2)
    return json.loads(files[-1].read_text())


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path,
                   default=Path(__file__).resolve().parent / "results")
    args = p.parse_args()

    report = load_latest(args.input) if args.input.is_dir() else json.loads(args.input.read_text())

    print(f"# Platform Routing Report — {report['timestamp']}\n")
    print(f"**{report['scenarios_passed']}/{report['total_scenarios']} scenarios passed**\n")

    print("| id | passed | setup | failing checks |")
    print("|---|:---:|---|---|")
    for r in report["results"]:
        emoji = "✅" if r["passed"] else "❌"
        failing = [c for c in r["checks"] if not c["passed"]]
        fail_str = "; ".join(f"{c['check']}: {c['detail']}" for c in failing) or "—"
        print(f"| `{r['id']}` | {emoji} | {r['setup_description'][:50]} | {fail_str} |")


if __name__ == "__main__":
    main()
