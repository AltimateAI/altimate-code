"""Generate stratified lineage accuracy report from benchmark results.

Reads benchmark results JSON and produces a detailed per-category and
overall accuracy report with edge precision, recall, F1, confidence
accuracy, and pattern analysis.

Usage:
    python report_lineage.py --input results/lineage_benchmark_TIMESTAMP.json

    # Or point to the results/ directory to auto-select the latest file:
    python report_lineage.py --input results/
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any


def find_latest_result(directory: Path) -> Path | None:
    """Find the most recently modified benchmark result file in a directory."""
    results = sorted(directory.glob("lineage_benchmark_*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    return results[0] if results else None


def load_benchmark(path: Path) -> dict[str, Any]:
    """Load benchmark results from file or directory."""
    if path.is_dir():
        latest = find_latest_result(path)
        if latest is None:
            print(f"ERROR: No benchmark result files found in {path}")
            sys.exit(1)
        print(f"Using latest result file: {latest.name}")
        path = latest

    if not path.exists():
        print(f"ERROR: File not found: {path}")
        sys.exit(1)

    return json.loads(path.read_text())


def compute_category_metrics(results: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Compute per-category aggregate metrics."""
    by_category: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in results:
        by_category[r["category"]].append(r)

    metrics: dict[str, dict[str, Any]] = {}
    for cat, items in sorted(by_category.items()):
        n = len(items)
        errors = sum(1 for r in items if r["error"] is not None)

        avg_precision = sum(r["edge_comparison"]["precision"] for r in items) / n
        avg_recall = sum(r["edge_comparison"]["recall"] for r in items) / n
        avg_f1 = sum(r["edge_comparison"]["f1"] for r in items) / n
        perfect_edge = sum(1 for r in items if r["edge_comparison"]["f1"] == 1.0)
        conf_match = sum(1 for r in items if r["confidence_match"])
        factor_match = sum(1 for r in items if r["factor_comparison"]["subset_match"])

        avg_elapsed = sum(r["elapsed_ms"] for r in items) / n

        # Collect missed and extra edge patterns
        all_missed: list[dict[str, str]] = []
        all_extra: list[dict[str, str]] = []
        for r in items:
            all_missed.extend(r["edge_comparison"].get("missed_edges", []))
            all_extra.extend(r["edge_comparison"].get("extra_edges", []))

        metrics[cat] = {
            "count": n,
            "errors": errors,
            "avg_precision": round(avg_precision, 4),
            "avg_recall": round(avg_recall, 4),
            "avg_f1": round(avg_f1, 4),
            "perfect_edge_match": perfect_edge,
            "perfect_edge_pct": round(perfect_edge / n * 100, 1),
            "confidence_match": conf_match,
            "confidence_match_pct": round(conf_match / n * 100, 1),
            "factor_subset_match": factor_match,
            "factor_subset_pct": round(factor_match / n * 100, 1),
            "avg_elapsed_ms": round(avg_elapsed, 2),
            "total_missed_edges": len(all_missed),
            "total_extra_edges": len(all_extra),
        }

    return metrics


def compute_overall_metrics(results: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute aggregate metrics across all categories."""
    n = len(results)
    if n == 0:
        return {}

    errors = sum(1 for r in results if r["error"] is not None)
    avg_precision = sum(r["edge_comparison"]["precision"] for r in results) / n
    avg_recall = sum(r["edge_comparison"]["recall"] for r in results) / n
    avg_f1 = sum(r["edge_comparison"]["f1"] for r in results) / n
    perfect_edge = sum(1 for r in results if r["edge_comparison"]["f1"] == 1.0)
    conf_match = sum(1 for r in results if r["confidence_match"])
    factor_match = sum(1 for r in results if r["factor_comparison"]["subset_match"])
    avg_elapsed = sum(r["elapsed_ms"] for r in results) / n

    return {
        "total_queries": n,
        "errors": errors,
        "avg_precision": round(avg_precision, 4),
        "avg_recall": round(avg_recall, 4),
        "avg_f1": round(avg_f1, 4),
        "perfect_edge_match": perfect_edge,
        "perfect_edge_pct": round(perfect_edge / n * 100, 1),
        "confidence_match": conf_match,
        "confidence_match_pct": round(conf_match / n * 100, 1),
        "factor_subset_match": factor_match,
        "factor_subset_pct": round(factor_match / n * 100, 1),
        "avg_elapsed_ms": round(avg_elapsed, 2),
    }


def find_failure_patterns(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Identify the most common failure patterns."""
    # Group failures by category + type of mismatch
    edge_failures: dict[str, int] = defaultdict(int)
    conf_failures: dict[str, int] = defaultdict(int)

    for r in results:
        cat = r["category"]
        if r["edge_comparison"]["f1"] < 1.0:
            missed = r["edge_comparison"].get("missed_edges", [])
            extra = r["edge_comparison"].get("extra_edges", [])
            if missed:
                edge_failures[f"{cat}: missed edges (expected edges not found)"] += len(missed)
            if extra:
                edge_failures[f"{cat}: extra edges (unexpected edges found)"] += len(extra)

        if not r["confidence_match"]:
            conf_failures[f"{cat}: expected={r['expected_confidence']} actual={r['actual_confidence']}"] += 1

    patterns = []
    for desc, count in sorted(edge_failures.items(), key=lambda x: -x[1]):
        patterns.append({"type": "edge_mismatch", "description": desc, "count": count})
    for desc, count in sorted(conf_failures.items(), key=lambda x: -x[1]):
        patterns.append({"type": "confidence_mismatch", "description": desc, "count": count})

    return patterns


def find_example_failures(results: list[dict[str, Any]], max_per_category: int = 2) -> list[dict[str, Any]]:
    """Find example failures for each category."""
    by_cat: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in results:
        if r["edge_comparison"]["f1"] < 1.0 or not r["confidence_match"]:
            by_cat[r["category"]].append(r)

    examples = []
    for cat, failures in sorted(by_cat.items()):
        for r in failures[:max_per_category]:
            examples.append({
                "category": cat,
                "sql": r["sql"],
                "edge_f1": r["edge_comparison"]["f1"],
                "confidence_match": r["confidence_match"],
                "missed_edges": r["edge_comparison"].get("missed_edges", []),
                "extra_edges": r["edge_comparison"].get("extra_edges", []),
                "actual_confidence": r.get("actual_confidence", "?"),
                "expected_confidence": r["expected_confidence"],
            })

    return examples


def format_report(
    overall: dict[str, Any],
    by_category: dict[str, dict[str, Any]],
    patterns: list[dict[str, Any]],
    examples: list[dict[str, Any]],
    metadata: dict[str, Any],
) -> str:
    """Format the report as a readable text string."""
    lines: list[str] = []

    lines.append("=" * 80)
    lines.append("LINEAGE ENGINE BENCHMARK REPORT")
    lines.append("=" * 80)
    lines.append(f"Timestamp: {metadata.get('timestamp', 'unknown')}")
    lines.append(f"Engine:    {metadata.get('engine_path', 'unknown')}")
    lines.append(f"Dialect:   {metadata.get('dialect', 'unknown')}")
    lines.append("")

    # Overall summary
    lines.append("-" * 80)
    lines.append("OVERALL SUMMARY")
    lines.append("-" * 80)
    lines.append(f"  Total queries:          {overall['total_queries']}")
    lines.append(f"  Errors:                 {overall['errors']}")
    lines.append(f"  Avg edge precision:     {overall['avg_precision']}")
    lines.append(f"  Avg edge recall:        {overall['avg_recall']}")
    lines.append(f"  Avg edge F1:            {overall['avg_f1']}")
    lines.append(f"  Perfect edge match:     {overall['perfect_edge_match']}/{overall['total_queries']} ({overall['perfect_edge_pct']}%)")
    lines.append(f"  Confidence accuracy:    {overall['confidence_match']}/{overall['total_queries']} ({overall['confidence_match_pct']}%)")
    lines.append(f"  Factor subset match:    {overall['factor_subset_match']}/{overall['total_queries']} ({overall['factor_subset_pct']}%)")
    lines.append(f"  Avg latency:            {overall['avg_elapsed_ms']}ms")
    lines.append("")

    # Per-category table
    lines.append("-" * 80)
    lines.append("PER-CATEGORY METRICS")
    lines.append("-" * 80)

    header = f"{'Category':<22} {'N':>4} {'Prec':>6} {'Rec':>6} {'F1':>6} {'Perf%':>6} {'Conf%':>6} {'Fact%':>6} {'ms':>7}"
    lines.append(header)
    lines.append("-" * len(header))

    for cat, m in sorted(by_category.items()):
        row = (
            f"{cat:<22} "
            f"{m['count']:>4} "
            f"{m['avg_precision']:>6.4f} "
            f"{m['avg_recall']:>6.4f} "
            f"{m['avg_f1']:>6.4f} "
            f"{m['perfect_edge_pct']:>5.1f}% "
            f"{m['confidence_match_pct']:>5.1f}% "
            f"{m['factor_subset_pct']:>5.1f}% "
            f"{m['avg_elapsed_ms']:>7.2f}"
        )
        lines.append(row)

    lines.append("")

    # Strengths and weaknesses
    lines.append("-" * 80)
    lines.append("STRENGTHS (categories with 100% perfect edge match)")
    lines.append("-" * 80)
    strengths = [cat for cat, m in by_category.items() if m["perfect_edge_pct"] == 100.0]
    if strengths:
        for cat in sorted(strengths):
            lines.append(f"  + {cat} ({by_category[cat]['count']} queries)")
    else:
        lines.append("  (none)")
    lines.append("")

    lines.append("-" * 80)
    lines.append("WEAKNESSES (categories with <80% perfect edge match)")
    lines.append("-" * 80)
    weaknesses = [(cat, m) for cat, m in by_category.items() if m["perfect_edge_pct"] < 80.0]
    if weaknesses:
        for cat, m in sorted(weaknesses, key=lambda x: x[1]["perfect_edge_pct"]):
            lines.append(f"  - {cat}: {m['perfect_edge_pct']}% perfect ({m['total_missed_edges']} missed, {m['total_extra_edges']} extra)")
    else:
        lines.append("  (none)")
    lines.append("")

    # Failure patterns
    if patterns:
        lines.append("-" * 80)
        lines.append("FAILURE PATTERNS")
        lines.append("-" * 80)
        for p in patterns[:15]:
            lines.append(f"  [{p['type']}] {p['description']} (count: {p['count']})")
        lines.append("")

    # Example failures
    if examples:
        lines.append("-" * 80)
        lines.append("EXAMPLE FAILURES (up to 2 per category)")
        lines.append("-" * 80)
        for ex in examples:
            lines.append(f"  Category: {ex['category']}")
            lines.append(f"  SQL: {ex['sql'][:120]}{'...' if len(ex['sql']) > 120 else ''}")
            lines.append(f"  Edge F1: {ex['edge_f1']}")
            lines.append(f"  Confidence: expected={ex['expected_confidence']} actual={ex['actual_confidence']} match={ex['confidence_match']}")
            if ex["missed_edges"]:
                for me in ex["missed_edges"][:3]:
                    lines.append(f"    MISSED: {me['source_table']}.{me['source_column']} -> {me['target_table']}.{me['target_column']}")
            if ex["extra_edges"]:
                for ee in ex["extra_edges"][:3]:
                    lines.append(f"    EXTRA:  {ee['source_table']}.{ee['source_column']} -> {ee['target_table']}.{ee['target_column']}")
            lines.append("")

    lines.append("=" * 80)
    lines.append("END OF REPORT")
    lines.append("=" * 80)

    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate lineage benchmark report")
    parser.add_argument("--input", type=str, required=True, help="Benchmark results JSON file or results/ directory")
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.is_absolute():
        input_path = Path.cwd() / input_path

    benchmark = load_benchmark(input_path)

    results = benchmark["results"]
    metadata = benchmark.get("metadata", {})

    overall = compute_overall_metrics(results)
    by_category = compute_category_metrics(results)
    patterns = find_failure_patterns(results)
    examples = find_example_failures(results, max_per_category=2)

    report = format_report(overall, by_category, patterns, examples, metadata)
    print(report)


if __name__ == "__main__":
    main()
