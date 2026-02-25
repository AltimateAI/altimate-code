"""Run the lineage engine on generated queries and compare to ground truth.

Executes check_lineage on each query from the generated dataset, compares
edges, confidence, and confidence factors against expected values, and
writes timestamped results to the results/ directory.

Usage:
    python run_lineage_benchmark.py --input lineage_queries.json --output results/
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Add the engine source to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages" / "altimate-engine" / "src"))

from altimate_engine.lineage.check import check_lineage
from altimate_engine.models import LineageCheckParams, ModelColumn


def _edge_key(e: dict[str, str]) -> tuple[str, str, str, str]:
    """Normalised edge key for comparison (case-insensitive)."""
    return (
        e["source_table"].lower(),
        e["source_column"].lower(),
        e["target_table"].lower(),
        e["target_column"].lower(),
    )


def _edges_as_set(edges: list[dict[str, str]]) -> dict[tuple[str, str, str, str], int]:
    """Convert edge list to a multiset (key -> count) for matching duplicates."""
    result: dict[tuple[str, str, str, str], int] = {}
    for e in edges:
        key = _edge_key(e)
        result[key] = result.get(key, 0) + 1
    return result


def compare_edges(
    actual_edges: list[dict[str, str]],
    expected_edges: list[dict[str, str]],
) -> dict[str, Any]:
    """Compare actual vs expected edges, computing precision, recall, F1.

    Uses multiset matching: each expected edge can match at most one actual edge.
    """
    actual_ms = _edges_as_set(actual_edges)
    expected_ms = _edges_as_set(expected_edges)

    # True positives = intersection of multisets
    tp = 0
    for key, expected_count in expected_ms.items():
        actual_count = actual_ms.get(key, 0)
        tp += min(expected_count, actual_count)

    total_actual = sum(actual_ms.values())
    total_expected = sum(expected_ms.values())

    precision = tp / total_actual if total_actual > 0 else (1.0 if total_expected == 0 else 0.0)
    recall = tp / total_expected if total_expected > 0 else (1.0 if total_actual == 0 else 0.0)
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0

    # Find missed and extra edges for diagnostics
    missed: list[dict[str, str]] = []
    extra: list[dict[str, str]] = []

    remaining_actual = dict(actual_ms)
    for key, count in expected_ms.items():
        actual_count = remaining_actual.get(key, 0)
        matched = min(count, actual_count)
        if matched < count:
            for _ in range(count - matched):
                missed.append({
                    "source_table": key[0],
                    "source_column": key[1],
                    "target_table": key[2],
                    "target_column": key[3],
                })
        if key in remaining_actual:
            remaining_actual[key] = actual_count - matched
            if remaining_actual[key] <= 0:
                del remaining_actual[key]

    for key, count in remaining_actual.items():
        for _ in range(count):
            extra.append({
                "source_table": key[0],
                "source_column": key[1],
                "target_table": key[2],
                "target_column": key[3],
            })

    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "true_positives": tp,
        "total_actual": total_actual,
        "total_expected": total_expected,
        "missed_edges": missed,
        "extra_edges": extra,
    }


def compare_confidence(actual: str, expected: str) -> bool:
    """Exact match on confidence level."""
    return actual.lower() == expected.lower()


def compare_confidence_factors(
    actual_factors: list[str],
    expected_factors: list[str],
) -> dict[str, Any]:
    """Check that expected factors are a subset of actual factors.

    Uses normalized substring matching: an expected factor matches if any
    actual factor contains the expected text (case-insensitive).
    """
    matched: list[str] = []
    missing: list[str] = []

    for ef in expected_factors:
        ef_lower = ef.lower()
        found = any(ef_lower in af.lower() for af in actual_factors)
        if found:
            matched.append(ef)
        else:
            missing.append(ef)

    unexpected = []
    for af in actual_factors:
        af_lower = af.lower()
        was_expected = any(ef.lower() in af_lower for ef in expected_factors)
        if not was_expected:
            unexpected.append(af)

    return {
        "matched": matched,
        "missing": missing,
        "unexpected": unexpected,
        "subset_match": len(missing) == 0,
    }


def run_single_query(query: dict[str, Any]) -> dict[str, Any]:
    """Run lineage engine on a single query and compare to ground truth."""
    sql = query["sql"]
    category = query["category"]
    expected_edges = query["expected_edges"]
    expected_confidence = query["expected_confidence"]
    expected_factors = query["expected_confidence_factors"]
    has_schema = query.get("has_schema_context", False)

    # Build schema context if provided
    schema_context = None
    if has_schema and "schema_context" in query:
        schema_context = {}
        for table_name, col_defs in query["schema_context"].items():
            schema_context[table_name] = [
                ModelColumn(name=cd["name"], data_type=cd["data_type"])
                for cd in col_defs
            ]

    # Run the engine
    start = time.perf_counter()
    try:
        params = LineageCheckParams(
            sql=sql,
            dialect="snowflake",
            schema_context=schema_context,
        )
        result = check_lineage(params)
        elapsed_ms = round((time.perf_counter() - start) * 1000, 2)
        error = None
    except Exception as e:
        elapsed_ms = round((time.perf_counter() - start) * 1000, 2)
        return {
            "id": query["id"],
            "sql": sql,
            "category": category,
            "error": str(e),
            "elapsed_ms": elapsed_ms,
            "edge_comparison": {"precision": 0, "recall": 0, "f1": 0, "true_positives": 0, "total_actual": 0, "total_expected": len(expected_edges), "missed_edges": expected_edges, "extra_edges": []},
            "confidence_match": False,
            "actual_confidence": "error",
            "expected_confidence": expected_confidence,
            "factor_comparison": {"matched": [], "missing": expected_factors, "unexpected": [], "subset_match": False},
        }

    # Convert actual edges to dicts
    actual_edges = [
        {
            "source_table": e.source_table,
            "source_column": e.source_column,
            "target_table": e.target_table,
            "target_column": e.target_column,
        }
        for e in result.edges
    ]

    edge_cmp = compare_edges(actual_edges, expected_edges)
    conf_match = compare_confidence(result.confidence, expected_confidence)
    factor_cmp = compare_confidence_factors(result.confidence_factors, expected_factors)

    return {
        "id": query["id"],
        "sql": sql,
        "category": category,
        "error": error,
        "elapsed_ms": elapsed_ms,
        "edge_comparison": edge_cmp,
        "confidence_match": conf_match,
        "actual_confidence": result.confidence,
        "expected_confidence": expected_confidence,
        "actual_edges": actual_edges,
        "expected_edges": expected_edges,
        "actual_confidence_factors": result.confidence_factors,
        "expected_confidence_factors": expected_factors,
        "factor_comparison": factor_cmp,
    }


def run_benchmark(queries: list[dict[str, Any]]) -> dict[str, Any]:
    """Run the full benchmark and return results."""
    results = []
    total = len(queries)

    for i, query in enumerate(queries):
        result = run_single_query(query)
        results.append(result)
        if (i + 1) % 50 == 0 or i + 1 == total:
            print(f"  Processed {i + 1}/{total} queries...")

    # Compute summary
    total_queries = len(results)
    errors = sum(1 for r in results if r["error"] is not None)
    perfect_edge_match = sum(1 for r in results if r["edge_comparison"]["f1"] == 1.0)
    confidence_matches = sum(1 for r in results if r["confidence_match"])
    factor_subset_matches = sum(1 for r in results if r["factor_comparison"]["subset_match"])

    avg_precision = sum(r["edge_comparison"]["precision"] for r in results) / total_queries if total_queries > 0 else 0
    avg_recall = sum(r["edge_comparison"]["recall"] for r in results) / total_queries if total_queries > 0 else 0
    avg_f1 = sum(r["edge_comparison"]["f1"] for r in results) / total_queries if total_queries > 0 else 0
    avg_elapsed = sum(r["elapsed_ms"] for r in results) / total_queries if total_queries > 0 else 0

    summary = {
        "total_queries": total_queries,
        "errors": errors,
        "perfect_edge_match": perfect_edge_match,
        "perfect_edge_match_pct": round(perfect_edge_match / total_queries * 100, 2) if total_queries > 0 else 0,
        "confidence_matches": confidence_matches,
        "confidence_match_pct": round(confidence_matches / total_queries * 100, 2) if total_queries > 0 else 0,
        "factor_subset_matches": factor_subset_matches,
        "factor_subset_match_pct": round(factor_subset_matches / total_queries * 100, 2) if total_queries > 0 else 0,
        "avg_edge_precision": round(avg_precision, 4),
        "avg_edge_recall": round(avg_recall, 4),
        "avg_edge_f1": round(avg_f1, 4),
        "avg_elapsed_ms": round(avg_elapsed, 2),
    }

    return {
        "summary": summary,
        "results": results,
        "metadata": {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "engine_path": "packages/altimate-engine/src/altimate_engine/lineage/check.py",
            "dialect": "snowflake",
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Run lineage benchmark against generated queries")
    parser.add_argument("--input", type=str, required=True, help="Input JSON file with generated queries")
    parser.add_argument("--output", type=str, default="results/", help="Output directory for results")
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.is_absolute():
        input_path = Path.cwd() / input_path

    if not input_path.exists():
        print(f"ERROR: Input file not found: {input_path}")
        sys.exit(1)

    queries = json.loads(input_path.read_text())
    print(f"Loaded {len(queries)} queries from {input_path}")

    output_dir = Path(args.output)
    if not output_dir.is_absolute():
        output_dir = Path.cwd() / output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    print("Running benchmark...")
    benchmark = run_benchmark(queries)

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    output_file = output_dir / f"lineage_benchmark_{timestamp}.json"
    output_file.write_text(json.dumps(benchmark, indent=2))

    print(f"\nResults written to {output_file}")
    print("\n--- Summary ---")
    s = benchmark["summary"]
    print(f"  Total queries:          {s['total_queries']}")
    print(f"  Errors:                 {s['errors']}")
    print(f"  Perfect edge match:     {s['perfect_edge_match']} ({s['perfect_edge_match_pct']}%)")
    print(f"  Confidence match:       {s['confidence_matches']} ({s['confidence_match_pct']}%)")
    print(f"  Factor subset match:    {s['factor_subset_matches']} ({s['factor_subset_match_pct']}%)")
    print(f"  Avg edge precision:     {s['avg_edge_precision']}")
    print(f"  Avg edge recall:        {s['avg_edge_recall']}")
    print(f"  Avg edge F1:            {s['avg_edge_f1']}")
    print(f"  Avg latency:            {s['avg_elapsed_ms']}ms")


if __name__ == "__main__":
    main()
