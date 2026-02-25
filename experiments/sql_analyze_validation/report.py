"""Generate a stratified accuracy report from benchmark results.

Reads benchmark JSON output and produces formatted tables showing per-rule
and per-category accuracy metrics.

Usage:
    python report.py --input results/benchmark_TIMESTAMP.json
    python report.py --input results/    # reads latest file in directory
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any


def load_benchmark(path: str) -> dict[str, Any]:
    """Load benchmark results from a file or directory.

    If path is a directory, loads the most recent benchmark file.
    """
    if os.path.isdir(path):
        files = [f for f in os.listdir(path) if f.startswith("benchmark_") and f.endswith(".json")]
        if not files:
            print(f"No benchmark files found in {path}", file=sys.stderr)
            sys.exit(1)
        files.sort(reverse=True)
        path = os.path.join(path, files[0])
        print(f"Loading latest benchmark: {path}")

    with open(path) as f:
        return json.load(f)


def format_rule_table(rule_metrics: dict[str, dict]) -> str:
    """Format rule metrics as a table."""
    lines = []
    header = f"{'Rule':<35} {'Prec':>6} {'Recall':>6} {'F1':>6} {'TP':>5} {'FP':>5} {'FN':>5}"
    sep = "-" * len(header)
    lines.append(sep)
    lines.append(header)
    lines.append(sep)

    for rule, m in sorted(rule_metrics.items()):
        lines.append(
            f"{rule:<35} {m['precision']:>6.2f} {m['recall']:>6.2f} {m['f1_score']:>6.2f} "
            f"{m['true_positives']:>5} {m['false_positives']:>5} {m['false_negatives']:>5}"
        )

    lines.append(sep)

    # Aggregate
    total_tp = sum(m["true_positives"] for m in rule_metrics.values())
    total_fp = sum(m["false_positives"] for m in rule_metrics.values())
    total_fn = sum(m["false_negatives"] for m in rule_metrics.values())
    macro_prec = sum(m["precision"] for m in rule_metrics.values()) / len(rule_metrics) if rule_metrics else 0
    macro_rec = sum(m["recall"] for m in rule_metrics.values()) / len(rule_metrics) if rule_metrics else 0
    macro_f1 = sum(m["f1_score"] for m in rule_metrics.values()) / len(rule_metrics) if rule_metrics else 0
    lines.append(
        f"{'MACRO AVG':<35} {macro_prec:>6.2f} {macro_rec:>6.2f} {macro_f1:>6.2f} "
        f"{total_tp:>5} {total_fp:>5} {total_fn:>5}"
    )
    lines.append(sep)

    return "\n".join(lines)


def format_category_table(category_metrics: dict[str, dict]) -> str:
    """Format category metrics as a table."""
    lines = []
    header = f"{'Category':<25} {'Count':>6} {'Accuracy':>8} {'TP':>5} {'FP':>5} {'FN':>5} {'Parse Fail':>10} {'Rules Fired'}"
    sep = "-" * 120
    lines.append(sep)
    lines.append(header)
    lines.append(sep)

    for cat, m in sorted(category_metrics.items()):
        rules = ", ".join(f"{r}({c})" for r, c in sorted(m["rules_fired"].items()))
        lines.append(
            f"{cat:<25} {m['query_count']:>6} {m['accuracy']:>8.2%} "
            f"{m['total_true_positives']:>5} {m['total_false_positives']:>5} {m['total_false_negatives']:>5} "
            f"{m['parse_failures']:>10} {rules}"
        )

    lines.append(sep)

    # Overall accuracy
    total_q = sum(m["query_count"] for m in category_metrics.values())
    total_accurate = sum(int(m["accuracy"] * m["query_count"]) for m in category_metrics.values())
    overall_acc = total_accurate / total_q if total_q > 0 else 0
    lines.append(f"{'OVERALL':<25} {total_q:>6} {overall_acc:>8.2%}")
    lines.append(sep)

    return "\n".join(lines)


def format_false_positive_details(query_results: list[dict], limit: int = 20) -> str:
    """Show details of false positive detections for debugging."""
    fp_queries = [r for r in query_results if r["false_positives"]]
    if not fp_queries:
        return "No false positives detected."

    lines = ["Top false positive examples:", ""]
    for r in fp_queries[:limit]:
        lines.append(f"  ID {r['id']} [{r['category']}]")
        lines.append(f"    SQL: {r['sql'][:120]}...")
        lines.append(f"    FP rules: {', '.join(r['false_positives'])}")
        lines.append("")

    if len(fp_queries) > limit:
        lines.append(f"  ... and {len(fp_queries) - limit} more queries with false positives")

    return "\n".join(lines)


def format_false_negative_details(query_results: list[dict], limit: int = 20) -> str:
    """Show details of false negative detections for debugging."""
    fn_queries = [r for r in query_results if r["false_negatives"]]
    if not fn_queries:
        return "No false negatives detected."

    lines = ["Top false negative examples:", ""]
    for r in fn_queries[:limit]:
        lines.append(f"  ID {r['id']} [{r['category']}]")
        lines.append(f"    SQL: {r['sql'][:120]}...")
        lines.append(f"    Expected but not detected: {', '.join(r['false_negatives'])}")
        lines.append("")

    if len(fn_queries) > limit:
        lines.append(f"  ... and {len(fn_queries) - limit} more queries with false negatives")

    return "\n".join(lines)


def generate_report(benchmark: dict[str, Any], verbose: bool = False) -> str:
    """Generate a full formatted report from benchmark results."""
    sections = []

    # Header
    sections.append("=" * 80)
    sections.append("SQL ANALYZER VALIDATION REPORT")
    sections.append("=" * 80)
    sections.append(f"Timestamp:     {benchmark['timestamp']}")
    sections.append(f"Dialect:       {benchmark['dialect']}")
    sections.append(f"Total queries: {benchmark['total_queries']}")
    sections.append(f"Parse fails:   {benchmark['parse_failures']}")
    sections.append(f"Total time:    {benchmark['total_elapsed_s']}s")
    sections.append(f"Avg per query: {benchmark['avg_query_ms']}ms")
    sections.append("")

    # Rule metrics
    sections.append("RULE METRICS (Precision / Recall / F1)")
    sections.append("")
    sections.append(format_rule_table(benchmark["rule_metrics"]))
    sections.append("")

    # Category metrics
    sections.append("CATEGORY METRICS (Accuracy = queries with 0 FP and 0 FN)")
    sections.append("")
    sections.append(format_category_table(benchmark["category_metrics"]))
    sections.append("")

    # Detail sections
    if verbose:
        sections.append("FALSE POSITIVE DETAILS")
        sections.append("")
        sections.append(format_false_positive_details(benchmark.get("query_results", []), limit=30))
        sections.append("")
        sections.append("FALSE NEGATIVE DETAILS")
        sections.append("")
        sections.append(format_false_negative_details(benchmark.get("query_results", []), limit=30))
        sections.append("")

    return "\n".join(sections)


def generate_json_summary(benchmark: dict[str, Any]) -> dict[str, Any]:
    """Generate a JSON summary (without raw query results) for programmatic use."""
    return {
        "timestamp": benchmark["timestamp"],
        "dialect": benchmark["dialect"],
        "total_queries": benchmark["total_queries"],
        "parse_failures": benchmark["parse_failures"],
        "total_elapsed_s": benchmark["total_elapsed_s"],
        "avg_query_ms": benchmark["avg_query_ms"],
        "rule_metrics": benchmark["rule_metrics"],
        "category_metrics": benchmark["category_metrics"],
    }


def main():
    parser = argparse.ArgumentParser(description="Generate report from benchmark results")
    parser.add_argument("--input", type=str, required=True, help="Path to benchmark JSON file or results/ directory")
    parser.add_argument("--verbose", action="store_true", help="Include FP/FN detail examples")
    parser.add_argument("--json-output", type=str, help="Save JSON summary to file")
    args = parser.parse_args()

    benchmark = load_benchmark(args.input)
    report = generate_report(benchmark, verbose=args.verbose)
    print(report)

    if args.json_output:
        summary = generate_json_summary(benchmark)
        with open(args.json_output, "w") as f:
            json.dump(summary, f, indent=2)
        print(f"\nJSON summary saved to: {args.json_output}")


if __name__ == "__main__":
    main()
