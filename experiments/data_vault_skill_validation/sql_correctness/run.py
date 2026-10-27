"""Run the DV 2.0 rule engine against the SQL-correctness dataset.

Compares each SQL snippet's detected violations to the expected set
declared in the dataset. Reports per-case pass/fail and per-rule
precision/recall.

Exit codes:
    0 = all cases pass
    1 = at least one case failed
    2 = harness/dataset error

Usage:
    python run.py [--input dataset.json] [--output results/]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rule_engine import evaluate, all_rule_ids  # noqa: E402


def run_case(case: dict) -> dict:
    sql = case["sql"]
    structure = case["structure"]
    expected = set(case["expected_violations"])

    start = time.perf_counter()
    detected = set(evaluate(sql, structure))
    elapsed_ms = (time.perf_counter() - start) * 1000

    true_positives  = sorted(expected & detected)
    false_positives = sorted(detected - expected)
    false_negatives = sorted(expected - detected)
    passed = (len(false_positives) + len(false_negatives)) == 0

    return {
        "id": case["id"],
        "structure": structure,
        "category": case["category"],
        "expected":       sorted(expected),
        "detected":       sorted(detected),
        "true_positives": true_positives,
        "false_positives": false_positives,
        "false_negatives": false_negatives,
        "passed": passed,
        "elapsed_ms": round(elapsed_ms, 3),
    }


def per_rule_metrics(case_results: list[dict], rule_ids: list[str]) -> list[dict]:
    """Aggregate per-rule TP/FP/FN across all cases."""
    metrics = []
    for rule_id in rule_ids:
        tp = fp = fn = 0
        for r in case_results:
            if rule_id in r["true_positives"]:
                tp += 1
            if rule_id in r["false_positives"]:
                fp += 1
            if rule_id in r["false_negatives"]:
                fn += 1
        precision = tp / (tp + fp) if (tp + fp) else 1.0
        recall    = tp / (tp + fn) if (tp + fn) else 1.0
        f1        = 2 * precision * recall / (precision + recall) if (precision + recall) else 1.0
        metrics.append({
            "rule": rule_id, "tp": tp, "fp": fp, "fn": fn,
            "precision": round(precision, 3),
            "recall":    round(recall, 3),
            "f1":        round(f1, 3),
        })
    return metrics


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path,
                   default=Path(__file__).resolve().parent / "dataset.json")
    p.add_argument("--output", type=Path,
                   default=Path(__file__).resolve().parent / "results")
    args = p.parse_args()

    if not args.input.is_file():
        print(f"ERROR: dataset not found: {args.input}", file=sys.stderr)
        sys.exit(2)

    try:
        dataset = json.loads(args.input.read_text())
    except json.JSONDecodeError as e:
        print(f"ERROR: dataset is not valid JSON: {e}", file=sys.stderr)
        sys.exit(2)

    results = [run_case(c) for c in dataset]
    passed = sum(1 for r in results if r["passed"])
    failed = len(results) - passed
    rule_metrics = per_rule_metrics(results, all_rule_ids())

    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "total_cases": len(results),
        "cases_passed": passed,
        "cases_failed": failed,
        "results": results,
        "rule_metrics": rule_metrics,
    }

    # Console output
    print(f"\n{'=' * 70}")
    print(f"SQL CORRECTNESS EVAL — {report['timestamp']}")
    print(f"{'=' * 70}")
    for r in results:
        status = "PASS" if r["passed"] else "FAIL"
        print(f"[{status}] {r['id']:<45} ({r['structure']})")
        if not r["passed"]:
            if r["false_positives"]:
                print(f"    ✗ FP (detected but not expected): {r['false_positives']}")
            if r["false_negatives"]:
                print(f"    ✗ FN (expected but not detected): {r['false_negatives']}")

    print(f"\n{'-' * 70}")
    print(f"Per-rule metrics:")
    print(f"{'-' * 70}")
    print(f"{'rule':<40} {'TP':>4} {'FP':>4} {'FN':>4} {'P':>6} {'R':>6} {'F1':>6}")
    for m in rule_metrics:
        print(f"{m['rule']:<40} {m['tp']:>4} {m['fp']:>4} {m['fn']:>4} "
              f"{m['precision']:>6.3f} {m['recall']:>6.3f} {m['f1']:>6.3f}")

    print(f"\n{'=' * 70}")
    print(f"{passed}/{len(results)} cases passed")
    print(f"{'=' * 70}\n")

    args.output.mkdir(parents=True, exist_ok=True)
    ts = report["timestamp"].replace(":", "-").replace(".", "-")
    out_file = args.output / f"sql_correctness_{ts}.json"
    out_file.write_text(json.dumps(report, indent=2))
    print(f"Report written to: {out_file}")

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
