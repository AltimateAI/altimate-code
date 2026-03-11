"""Evaluate benchmark results using Spider2's official eval_utils.

Compares workspace DuckDB outputs against gold standard databases using
the official `duckdb_match` function from Spider2's evaluation suite.

Usage:
    python evaluate_results.py                                    # Use latest results
    python evaluate_results.py --results results/spider2_benchmark_*.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from config import (
    EVAL_UTILS_DIR,
    GOLD_EVAL_JSONL,
    RESULTS_DIR,
    SPIDER2_DBT_DIR,
    WORKSPACE_DIR,
    get_task_domain,
)


def add_eval_utils_to_path() -> None:
    """Add Spider2's evaluation_suite to sys.path for importing eval_utils."""
    for p in [str(EVAL_UTILS_DIR), str(SPIDER2_DBT_DIR)]:
        if p not in sys.path:
            sys.path.insert(0, p)


def load_gold_standard() -> dict[str, dict[str, Any]]:
    """Load gold evaluation data keyed by instance_id."""
    if not GOLD_EVAL_JSONL.exists():
        print("Gold evaluation files not found. Running automatic setup...")
        from setup_spider2 import clone_spider2, download_databases, run_spider2_setup, create_directories
        clone_spider2()
        download_databases()
        run_spider2_setup()
        create_directories()
        if not GOLD_EVAL_JSONL.exists():
            print(f"ERROR: Gold evaluation file still not found after setup: {GOLD_EVAL_JSONL}")
            sys.exit(1)

    gold = {}
    for line in GOLD_EVAL_JSONL.read_text().strip().splitlines():
        line = line.strip()
        if line:
            entry = json.loads(line)
            gold[entry["instance_id"]] = entry
    return gold


def find_latest_results() -> Path:
    """Find the latest benchmark results file."""
    latest = RESULTS_DIR / "latest.json"
    if latest.exists() or latest.is_symlink():
        return latest.resolve()

    results_files = sorted(RESULTS_DIR.glob("spider2_benchmark_*.json"), reverse=True)
    if not results_files:
        print("ERROR: No benchmark results found. Run `python run_benchmark.py` first.")
        sys.exit(1)
    return results_files[0]


def find_workspace_duckdb(instance_id: str) -> str | None:
    """Find the DuckDB file in the workspace for a given task."""
    workspace = WORKSPACE_DIR / instance_id

    if not workspace.exists():
        return None

    # Search for .duckdb files (exclude target/ build artifacts)
    db_files = list(workspace.glob("*.duckdb"))
    if db_files:
        return str(db_files[0])

    # Check subdirectories (some projects have db in subdirs)
    db_files = list(workspace.rglob("*.duckdb"))
    # Prefer non-target files
    non_target = [f for f in db_files if "target" not in str(f)]
    if non_target:
        return str(non_target[0])
    if db_files:
        return str(db_files[0])

    return None


def find_gold_duckdb(instance_id: str, gold_filename: str) -> str | None:
    """Find the gold DuckDB file for a given task."""
    gold_dir = SPIDER2_DBT_DIR / "evaluation_suite" / "gold" / instance_id
    if not gold_dir.exists():
        return None

    # Try exact filename first
    gold_path = gold_dir / gold_filename
    if gold_path.exists():
        return str(gold_path)

    # Fallback: use any .duckdb file in the gold directory
    db_files = list(gold_dir.glob("*.duckdb"))
    if db_files:
        return str(db_files[0])

    return None


def evaluate_task(
    instance_id: str,
    gold_entry: dict[str, Any],
) -> dict[str, Any]:
    """Evaluate a single task using Spider2's official duckdb_match.

    The gold_entry has format:
    {
        "instance_id": "...",
        "evaluation": {
            "func": "duckdb_match",
            "parameters": {
                "gold": "filename.duckdb",
                "condition_tabs": ["table1", "table2"],
                "condition_cols": [[col_indices], [col_indices]],
                "ignore_orders": [true, true]
            }
        }
    }
    """
    result = {
        "instance_id": instance_id,
        "passed": False,
        "error": None,
        "method": "unknown",
    }

    eval_spec = gold_entry.get("evaluation", {})
    eval_func = eval_spec.get("func", "")
    params = eval_spec.get("parameters", {})

    if eval_func != "duckdb_match":
        result["error"] = f"Unsupported eval function: {eval_func}"
        return result

    # Find workspace DuckDB (the result produced by the agent)
    workspace_db = find_workspace_duckdb(instance_id)
    if not workspace_db:
        result["error"] = "No DuckDB file found in workspace"
        return result

    # Find gold DuckDB
    gold_filename = params.get("gold", "")
    gold_db = find_gold_duckdb(instance_id, gold_filename)
    if not gold_db:
        result["error"] = f"Gold DuckDB not found: {instance_id}/{gold_filename}"
        return result

    # Call the official eval function
    try:
        from eval_utils import duckdb_match

        score = duckdb_match(
            result=workspace_db,
            gold=gold_db,
            condition_tabs=params.get("condition_tabs"),
            condition_cols=params.get("condition_cols"),
            ignore_orders=params.get("ignore_orders"),
        )
        result["passed"] = score == 1
        result["method"] = "spider2_duckdb_match"
    except ImportError:
        result["error"] = "Could not import eval_utils.duckdb_match"
    except Exception as e:
        result["error"] = f"Evaluation error: {str(e)[:300]}"

    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate Spider 2.0-DBT benchmark results")
    parser.add_argument("--results", type=str, default=None, help="Path to benchmark results JSON")
    args = parser.parse_args()

    print("=" * 60)
    print("Spider 2.0-DBT Benchmark Evaluation")
    print("=" * 60)

    # Add eval_utils to path
    add_eval_utils_to_path()

    # Load results
    results_path = Path(args.results) if args.results else find_latest_results()
    print(f"  Results file: {results_path}")
    benchmark = json.loads(results_path.read_text())

    # Load gold standard
    gold = load_gold_standard()
    print(f"  Gold entries: {len(gold)}")

    task_results = benchmark.get("task_results", [])
    print(f"  Tasks to evaluate: {len(task_results)}")
    print()

    # Evaluate each task
    evaluations = []
    passed = 0
    failed = 0
    errors = 0

    for i, task_result in enumerate(task_results, 1):
        instance_id = task_result["instance_id"]
        gold_entry = gold.get(instance_id)

        if gold_entry is None:
            print(f"  [{i}/{len(task_results)}] {instance_id} — NO GOLD (skipped)")
            evaluations.append({
                "instance_id": instance_id,
                "passed": False,
                "error": "No gold standard entry",
                "method": "skipped",
            })
            errors += 1
            continue

        eval_result = evaluate_task(instance_id, gold_entry)
        evaluations.append(eval_result)

        if eval_result["passed"]:
            status = "PASS"
            passed += 1
        elif eval_result["error"]:
            status = f"ERROR: {eval_result['error'][:50]}"
            errors += 1
        else:
            status = "FAIL"
            failed += 1

        print(f"  [{i}/{len(task_results)}] {instance_id} — {status}")

    total = len(task_results)
    pass_rate = (passed / total * 100) if total > 0 else 0.0

    # Domain breakdown
    domain_stats: dict[str, dict[str, int]] = {}
    for eval_r, task_r in zip(evaluations, task_results):
        domain = get_task_domain(task_r["instance_id"])
        if domain not in domain_stats:
            domain_stats[domain] = {"total": 0, "passed": 0, "failed": 0, "errors": 0}
        domain_stats[domain]["total"] += 1
        if eval_r["passed"]:
            domain_stats[domain]["passed"] += 1
        elif eval_r.get("error"):
            domain_stats[domain]["errors"] += 1
        else:
            domain_stats[domain]["failed"] += 1

    # Save evaluation results
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    evaluation = {
        "timestamp": timestamp,
        "source_results": str(results_path),
        "model": benchmark.get("model", "unknown"),
        "total": total,
        "passed": passed,
        "failed": failed,
        "errors": errors,
        "pass_rate": round(pass_rate, 2),
        "domain_stats": domain_stats,
        "evaluations": evaluations,
    }

    eval_path = RESULTS_DIR / f"evaluation_{timestamp}.json"
    eval_path.write_text(json.dumps(evaluation, indent=2))

    # Latest symlink
    latest = RESULTS_DIR / "evaluation_latest.json"
    if latest.is_symlink() or latest.exists():
        latest.unlink()
    latest.symlink_to(eval_path.name)

    # Print summary
    print()
    print("=" * 60)
    print("Evaluation Summary")
    print("=" * 60)
    print(f"  Total:     {total}")
    print(f"  Passed:    {passed}")
    print(f"  Failed:    {failed}")
    print(f"  Errors:    {errors}")
    print(f"  Pass Rate: {pass_rate:.2f}%")
    print()

    print("Domain Breakdown:")
    for domain, stats in sorted(domain_stats.items()):
        dr = (stats["passed"] / stats["total"] * 100) if stats["total"] > 0 else 0
        print(f"  {domain:20s}  {stats['passed']}/{stats['total']} ({dr:.1f}%)")

    print()
    print(f"  Evaluation saved: {eval_path}")
    print()
    print("Next: python report.py")


if __name__ == "__main__":
    main()
