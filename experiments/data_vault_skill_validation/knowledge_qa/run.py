"""Knowledge-QA eval — verify that every question's expected citations
actually exist in the skill's reference files.

This is a citation-integrity check, not a "does the LLM answer
correctly" check. If the skill file no longer contains the phrase a
question depends on, the QA dataset is either stale or the skill lost
the guidance — either way, the eval fails and forces a review.

Exit codes:
    0 = every citation resolves
    1 = at least one citation failed to resolve
    2 = harness/dataset error

Usage:
    python run.py [--input dataset.json] [--output results/]
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_SKILL_ROOT = Path(__file__).resolve().parents[3] / ".opencode" / "skills" / "data-vault"


def check_citation(skill_root: Path, citation: dict) -> tuple[bool, str]:
    path = skill_root / citation["file"]
    if not path.is_file():
        return False, f"missing file {citation['file']}"
    text = path.read_text()
    needle = citation["must_contain"]
    # Case-insensitive contains — safer against title-case drift
    if needle.lower() in text.lower():
        return True, ""
    return False, f"phrase not found in {citation['file']!r}: {needle!r}"


def run_case(skill_root: Path, case: dict) -> dict:
    results = []
    for cit in case["citations"]:
        ok, err = check_citation(skill_root, cit)
        results.append({
            "file": cit["file"],
            "phrase": cit["must_contain"],
            "resolved": ok,
            "error": err,
        })
    passed = all(r["resolved"] for r in results)
    return {
        "id": case["id"],
        "question": case["question"],
        "citations": results,
        "passed": passed,
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path,
                   default=Path(__file__).resolve().parent / "dataset.json")
    p.add_argument("--output", type=Path,
                   default=Path(__file__).resolve().parent / "results")
    p.add_argument("--skill-root", type=Path, default=DEFAULT_SKILL_ROOT)
    args = p.parse_args()

    if not args.input.is_file():
        print(f"ERROR: dataset not found: {args.input}", file=sys.stderr)
        sys.exit(2)
    if not args.skill_root.is_dir():
        print(f"ERROR: skill root not found: {args.skill_root}", file=sys.stderr)
        sys.exit(2)

    try:
        dataset = json.loads(args.input.read_text())
    except json.JSONDecodeError as e:
        print(f"ERROR: dataset is not valid JSON: {e}", file=sys.stderr)
        sys.exit(2)

    results = [run_case(args.skill_root, c) for c in dataset]
    passed = sum(1 for r in results if r["passed"])
    failed = len(results) - passed

    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "skill_root": str(args.skill_root),
        "total_questions": len(results),
        "questions_passed": passed,
        "questions_failed": failed,
        "results": results,
    }

    print(f"\n{'=' * 70}")
    print(f"KNOWLEDGE-QA EVAL — {report['timestamp']}")
    print(f"{'=' * 70}")
    for r in results:
        status = "PASS" if r["passed"] else "FAIL"
        print(f"[{status}] {r['id']}: {r['question'][:60]}")
        for c in r["citations"]:
            if not c["resolved"]:
                print(f"    ✗ {c['error']}")

    print(f"\n{'=' * 70}")
    print(f"{passed}/{len(results)} questions passed all citations")
    print(f"{'=' * 70}\n")

    args.output.mkdir(parents=True, exist_ok=True)
    ts = report["timestamp"].replace(":", "-").replace(".", "-")
    out_file = args.output / f"knowledge_qa_{ts}.json"
    out_file.write_text(json.dumps(report, indent=2))
    print(f"Report written to: {out_file}")

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
