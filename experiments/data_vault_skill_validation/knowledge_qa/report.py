"""Format the latest knowledge-QA result JSON as a markdown report."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def load_latest(results_dir: Path) -> dict:
    files = sorted(results_dir.glob("knowledge_qa_*.json"))
    if not files:
        print(f"No knowledge_qa_*.json files in {results_dir}", file=sys.stderr)
        sys.exit(2)
    return json.loads(files[-1].read_text())


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path,
                   default=Path(__file__).resolve().parent / "results")
    args = p.parse_args()

    report = load_latest(args.input) if args.input.is_dir() else json.loads(args.input.read_text())

    print(f"# Knowledge-QA Report — {report['timestamp']}\n")
    print(f"**{report['questions_passed']}/{report['total_questions']} questions passed**\n")

    print("| id | passed | question | failed citations |")
    print("|---|:---:|---|---|")
    for r in report["results"]:
        emoji = "✅" if r["passed"] else "❌"
        failed = [c for c in r["citations"] if not c["resolved"]]
        fail_str = "; ".join(f"`{c['file']}` — {c['phrase'][:40]!r}" for c in failed) or "—"
        print(f"| `{r['id']}` | {emoji} | {r['question'][:60]} | {fail_str} |")


if __name__ == "__main__":
    main()
