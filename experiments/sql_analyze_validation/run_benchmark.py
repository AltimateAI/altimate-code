"""Run the StaticQueryAnalyzer against generated queries and capture results.

Compares detected issues to expected ground truth, recording true positives,
false positives, and false negatives per rule.

Usage:
    python run_benchmark.py --input queries.json --output results/
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from typing import Any

# Add the engine source to sys.path so we can import the analyzer
ENGINE_SRC = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "packages", "altimate-engine", "src")
)
sys.path.insert(0, ENGINE_SRC)

from altimate_engine.sql.analyzer import analyze_sql


def run_single_query(query: dict[str, Any], dialect: str = "snowflake") -> dict[str, Any]:
    """Run the analyzer on a single query and compare to ground truth.

    Args:
        query: Query dict with sql, expected_positive, expected_negative.
        dialect: SQL dialect to use.

    Returns:
        Result dict with detected issues, TP/FP/FN classification.
    """
    sql = query["sql"]
    expected_positive = set(query["expected_positive"])
    expected_negative = set(query["expected_negative"])

    start = time.perf_counter()
    result = analyze_sql(sql, dialect)
    elapsed_ms = (time.perf_counter() - start) * 1000

    detected_rules = set()
    if result.get("success"):
        for issue in result.get("issues", []):
            detected_rules.add(issue["type"])

    # Classification
    true_positives = sorted(expected_positive & detected_rules)
    false_negatives = sorted(expected_positive - detected_rules)
    false_positives = sorted(expected_negative & detected_rules)
    # Rules we expected negative and didn't detect = true negatives (not tracked per-query)

    return {
        "id": query["id"],
        "sql": sql,
        "category": query["category"],
        "expected_positive": sorted(expected_positive),
        "expected_negative_count": len(expected_negative),
        "detected_rules": sorted(detected_rules),
        "true_positives": true_positives,
        "false_positives": false_positives,
        "false_negatives": false_negatives,
        "parse_success": result.get("success", False),
        "parse_error": result.get("error"),
        "elapsed_ms": round(elapsed_ms, 3),
    }


def run_benchmark(queries: list[dict], dialect: str = "snowflake") -> dict[str, Any]:
    """Run the full benchmark on all queries.

    Args:
        queries: List of query dicts from generate_queries.py.
        dialect: SQL dialect.

    Returns:
        Benchmark results dict.
    """
    results = []
    total = len(queries)
    parse_failures = 0
    start_time = time.perf_counter()

    for i, query in enumerate(queries):
        result = run_single_query(query, dialect)
        results.append(result)
        if not result["parse_success"]:
            parse_failures += 1

        # Progress indicator every 100 queries
        if (i + 1) % 100 == 0 or (i + 1) == total:
            print(f"  [{i + 1}/{total}] processed", flush=True)

    total_elapsed = time.perf_counter() - start_time

    # Aggregate per-rule metrics
    rule_metrics = _compute_rule_metrics(results)

    # Aggregate per-category metrics
    category_metrics = _compute_category_metrics(results)

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")

    return {
        "timestamp": timestamp,
        "dialect": dialect,
        "total_queries": total,
        "parse_failures": parse_failures,
        "total_elapsed_s": round(total_elapsed, 3),
        "avg_query_ms": round(total_elapsed * 1000 / total, 3) if total > 0 else 0,
        "rule_metrics": rule_metrics,
        "category_metrics": category_metrics,
        "query_results": results,
    }


def _compute_rule_metrics(results: list[dict]) -> dict[str, dict]:
    """Compute per-rule TP/FP/FN metrics from query results."""
    from collections import defaultdict

    rule_stats: dict[str, dict[str, int]] = defaultdict(lambda: {"tp": 0, "fp": 0, "fn": 0})

    for r in results:
        for rule in r["true_positives"]:
            rule_stats[rule]["tp"] += 1
        for rule in r["false_positives"]:
            rule_stats[rule]["fp"] += 1
        for rule in r["false_negatives"]:
            rule_stats[rule]["fn"] += 1

    metrics = {}
    for rule, stats in sorted(rule_stats.items()):
        tp = stats["tp"]
        fp = stats["fp"]
        fn = stats["fn"]
        precision = tp / (tp + fp) if (tp + fp) > 0 else 1.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 1.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
        metrics[rule] = {
            "true_positives": tp,
            "false_positives": fp,
            "false_negatives": fn,
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1_score": round(f1, 4),
        }

    return metrics


def _compute_category_metrics(results: list[dict]) -> dict[str, dict]:
    """Compute per-category aggregate metrics."""
    from collections import defaultdict

    cat_data: dict[str, dict] = defaultdict(lambda: {
        "count": 0,
        "parse_failures": 0,
        "total_tp": 0,
        "total_fp": 0,
        "total_fn": 0,
        "rules_fired": defaultdict(int),
    })

    for r in results:
        cat = r["category"]
        cat_data[cat]["count"] += 1
        if not r["parse_success"]:
            cat_data[cat]["parse_failures"] += 1
        cat_data[cat]["total_tp"] += len(r["true_positives"])
        cat_data[cat]["total_fp"] += len(r["false_positives"])
        cat_data[cat]["total_fn"] += len(r["false_negatives"])
        for rule in r["detected_rules"]:
            cat_data[cat]["rules_fired"][rule] += 1

    metrics = {}
    for cat, data in sorted(cat_data.items()):
        tp = data["total_tp"]
        fp = data["total_fp"]
        fn = data["total_fn"]
        total = data["count"]
        # Accuracy: queries with zero FP and zero FN
        accurate = sum(
            1 for r in results
            if r["category"] == cat and len(r["false_positives"]) == 0 and len(r["false_negatives"]) == 0
        )
        metrics[cat] = {
            "query_count": total,
            "parse_failures": data["parse_failures"],
            "accuracy": round(accurate / total, 4) if total > 0 else 0.0,
            "total_true_positives": tp,
            "total_false_positives": fp,
            "total_false_negatives": fn,
            "rules_fired": dict(sorted(data["rules_fired"].items())),
        }

    return metrics


def main():
    parser = argparse.ArgumentParser(description="Run analyzer benchmark on generated queries")
    parser.add_argument("--input", type=str, required=True, help="Path to queries.json")
    parser.add_argument("--output", type=str, default="results/", help="Output directory (default: results/)")
    parser.add_argument("--dialect", type=str, default="snowflake", help="SQL dialect (default: snowflake)")
    args = parser.parse_args()

    # Load queries
    with open(args.input) as f:
        queries = json.load(f)

    print(f"Running benchmark on {len(queries)} queries (dialect: {args.dialect})...")

    benchmark = run_benchmark(queries, args.dialect)

    # Ensure output directory exists
    os.makedirs(args.output, exist_ok=True)

    output_file = os.path.join(args.output, f"benchmark_{benchmark['timestamp']}.json")
    with open(output_file, "w") as f:
        json.dump(benchmark, f, indent=2)

    print(f"\nBenchmark complete!")
    print(f"  Total queries: {benchmark['total_queries']}")
    print(f"  Parse failures: {benchmark['parse_failures']}")
    print(f"  Total time: {benchmark['total_elapsed_s']}s")
    print(f"  Avg per query: {benchmark['avg_query_ms']}ms")
    print(f"  Results saved to: {output_file}")

    # Quick summary
    print(f"\nRule metrics summary:")
    for rule, m in sorted(benchmark["rule_metrics"].items()):
        print(f"  {rule:30s}  P={m['precision']:.2f}  R={m['recall']:.2f}  F1={m['f1_score']:.2f}  (TP={m['true_positives']}, FP={m['false_positives']}, FN={m['false_negatives']})")


if __name__ == "__main__":
    main()
