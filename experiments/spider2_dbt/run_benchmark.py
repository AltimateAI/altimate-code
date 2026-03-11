"""Run Spider 2.0-DBT benchmark: invoke altimate-code per task.

Usage:
    python run_benchmark.py                          # All tasks
    python run_benchmark.py --tasks 5                # First N tasks
    python run_benchmark.py --tasks ga4_001 sf_002   # Specific tasks
    python run_benchmark.py --no-resume              # Force re-run all
    python run_benchmark.py --timeout 300            # Custom timeout
    python run_benchmark.py --parallel 4             # Run 4 tasks concurrently
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from config import (
    ALTIMATE_CODE_BIN,
    DEFAULT_MODEL,
    DEFAULT_PARALLEL,
    DEFAULT_TIMEOUT,
    EXAMPLES_DIR,
    FAST_EXIT_THRESHOLD_S,
    INCREMENTAL_DIR,
    MAX_RETRIES,
    RESULTS_DIR,
    TASK_JSONL,
    WORKSPACE_DIR,
    get_task_domain,
)
from prompt_template import build_task_prompt


def load_tasks(task_jsonl: Path) -> list[dict[str, Any]]:
    """Load tasks from the Spider2-DBT JSONL file."""
    tasks = []
    for line in task_jsonl.read_text().strip().splitlines():
        line = line.strip()
        if line:
            tasks.append(json.loads(line))
    return tasks


def filter_tasks(
    tasks: list[dict[str, Any]],
    task_filter: list[str] | None,
) -> list[dict[str, Any]]:
    """Filter tasks by name or limit count.

    Args:
        tasks: Full task list.
        task_filter: Either a list of instance_ids, or a single-element list
                     with a number (e.g., ["5"]) to take first N tasks.
    """
    if not task_filter:
        return tasks

    # If single numeric argument, take first N
    if len(task_filter) == 1 and task_filter[0].isdigit():
        n = int(task_filter[0])
        return tasks[:n]

    # Otherwise filter by instance_id
    filter_set = set(task_filter)
    return [t for t in tasks if t["instance_id"] in filter_set]


def prepare_workspace(instance_id: str) -> Path:
    """Copy dbt project from examples to workspace."""
    src = EXAMPLES_DIR / instance_id
    dst = WORKSPACE_DIR / instance_id

    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)

    return dst


def _should_retry(result: dict[str, Any]) -> bool:
    """Determine if a task result indicates a transient failure worth retrying.

    Only retry fast exits (<FAST_EXIT_THRESHOLD_S with ≤1 events) — these
    indicate an API/init failure where no work was done at all.

    Do NOT retry timeouts (even with 0 events): these are either legitimately
    slow tasks that need more time, or resource-starved tasks where retrying
    just doubles the wait without helping.
    """
    if result["timed_out"]:
        return False
    if result["elapsed_s"] < FAST_EXIT_THRESHOLD_S and result["event_count"] <= 1:
        return True
    return False


def _run_single_attempt(
    instance_id: str,
    instruction: str,
    model: str,
    agent: str | None,
    timeout: int,
) -> dict[str, Any]:
    """Execute one attempt of altimate-code on a task."""
    # Prepare workspace
    workspace = prepare_workspace(instance_id)

    # Build prompt
    prompt = build_task_prompt(
        instance_id=instance_id,
        instruction=instruction,
        project_dir=str(workspace),
    )

    # Output file for agent's text response
    output_file = workspace / "agent_output.md"

    # Build command
    cmd = [
        ALTIMATE_CODE_BIN,
        "run",
        prompt,
        "--format", "json",
        "--dir", str(workspace),
        "--output", str(output_file),
        "--model", model,
    ]
    if agent:
        cmd.extend(["--agent", agent])

    # Execute
    start = time.perf_counter()
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(workspace),
        )
        exit_code = proc.returncode
        stdout = proc.stdout
        stderr = proc.stderr
        timed_out = False
    except subprocess.TimeoutExpired:
        exit_code = -1
        stdout = ""
        stderr = f"Task timed out after {timeout}s"
        timed_out = True

    elapsed_s = time.perf_counter() - start

    # Read agent output if available
    agent_output = ""
    if output_file.exists():
        agent_output = output_file.read_text()

    # Parse JSON events from stdout
    events = []
    for line in stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                pass

    # Check if dbt run succeeded (search events for successful bash output)
    dbt_success = False
    for event in events:
        if event.get("type") == "tool_use":
            output = json.dumps(event.get("output", ""))
            if "Completed successfully" in output or "Done." in output:
                dbt_success = True

    return {
        "instance_id": instance_id,
        "domain": get_task_domain(instance_id),
        "instruction": instruction,
        "exit_code": exit_code,
        "timed_out": timed_out,
        "dbt_success": dbt_success,
        "elapsed_s": round(elapsed_s, 2),
        "agent_output": agent_output[:5000],  # Truncate for storage
        "event_count": len(events),
        "stderr_tail": stderr[-2000:] if stderr else "",
    }


def run_single_task(
    task: dict[str, Any],
    model: str,
    agent: str | None,
    timeout: int,
) -> dict[str, Any]:
    """Run altimate-code on a single Spider2-DBT task with auto-retry.

    Automatically retries on transient failures (fast exits, startup hangs).
    Returns:
        Result dict with task metadata, exit_code, elapsed_s, agent_output.
    """
    instance_id = task["instance_id"]
    instruction = task.get("instruction", task.get("question", ""))

    for attempt in range(1, MAX_RETRIES + 1):
        result = _run_single_attempt(instance_id, instruction, model, agent, timeout)
        result["attempt"] = attempt

        if attempt < MAX_RETRIES and _should_retry(result):
            retry_reason = "fast exit" if result["elapsed_s"] < FAST_EXIT_THRESHOLD_S else "timeout with 0 events"
            print(f"    ↳ Retry {attempt}/{MAX_RETRIES} for {instance_id} ({retry_reason})")
            continue

        break

    return result


def _run_task_wrapper(args: tuple) -> dict[str, Any]:
    """Wrapper for ProcessPoolExecutor — unpacks args tuple."""
    task, model, agent, timeout = args
    return run_single_task(task, model, agent, timeout)


def save_incremental(instance_id: str, result: dict[str, Any]) -> None:
    """Save per-task result for resumability."""
    path = INCREMENTAL_DIR / f"{instance_id}.json"
    path.write_text(json.dumps(result, indent=2))


def load_incremental(instance_id: str) -> dict[str, Any] | None:
    """Load a previously saved incremental result."""
    path = INCREMENTAL_DIR / f"{instance_id}.json"
    if path.exists():
        return json.loads(path.read_text())
    return None


def run_sequential(
    tasks_to_run: list[dict[str, Any]],
    all_tasks_count: int,
    model: str,
    agent: str | None,
    timeout: int,
    resume: bool,
) -> list[dict[str, Any]]:
    """Run tasks one at a time (original behavior)."""
    results = []
    skipped = 0

    for i, task in enumerate(tasks_to_run, 1):
        instance_id = task["instance_id"]

        if resume:
            existing = load_incremental(instance_id)
            if existing is not None:
                print(f"  [{i}/{len(tasks_to_run)}] {instance_id} — SKIPPED (cached)")
                results.append(existing)
                skipped += 1
                continue

        print(f"  [{i}/{len(tasks_to_run)}] {instance_id} — running...", end="", flush=True)

        result = run_single_task(task, model, agent, timeout)
        save_incremental(instance_id, result)
        results.append(result)

        status = "OK" if result["exit_code"] == 0 else "FAIL"
        if result["timed_out"]:
            status = "TIMEOUT"
        print(f" {status} ({result['elapsed_s']}s)")

    return results


def run_parallel(
    tasks_to_run: list[dict[str, Any]],
    all_tasks_count: int,
    model: str,
    agent: str | None,
    timeout: int,
    resume: bool,
    workers: int,
) -> list[dict[str, Any]]:
    """Run tasks concurrently using a process pool."""
    results_map: dict[str, dict[str, Any]] = {}
    to_submit: list[dict[str, Any]] = []

    # Separate cached vs need-to-run
    for task in tasks_to_run:
        instance_id = task["instance_id"]
        if resume:
            existing = load_incremental(instance_id)
            if existing is not None:
                print(f"  {instance_id} — SKIPPED (cached)")
                results_map[instance_id] = existing
                continue
        to_submit.append(task)

    if not to_submit:
        return [results_map[t["instance_id"]] for t in tasks_to_run]

    print(f"\n  Running {len(to_submit)} tasks with {workers} workers...\n")

    with ProcessPoolExecutor(max_workers=workers) as pool:
        future_to_id = {}
        for task in to_submit:
            future = pool.submit(_run_task_wrapper, (task, model, agent, timeout))
            future_to_id[future] = task["instance_id"]

        completed = 0
        for future in as_completed(future_to_id):
            instance_id = future_to_id[future]
            completed += 1
            try:
                result = future.result()
                save_incremental(instance_id, result)
                results_map[instance_id] = result

                status = "OK" if result["exit_code"] == 0 else "FAIL"
                if result["timed_out"]:
                    status = "TIMEOUT"
                print(f"  [{completed}/{len(to_submit)}] {instance_id} — {status} ({result['elapsed_s']}s)")
            except Exception as e:
                print(f"  [{completed}/{len(to_submit)}] {instance_id} — ERROR: {e}")
                error_result = {
                    "instance_id": instance_id,
                    "domain": get_task_domain(instance_id),
                    "instruction": "",
                    "exit_code": -1,
                    "timed_out": False,
                    "dbt_success": False,
                    "elapsed_s": 0,
                    "agent_output": "",
                    "event_count": 0,
                    "stderr_tail": str(e)[:2000],
                }
                save_incremental(instance_id, error_result)
                results_map[instance_id] = error_result

    # Return in original task order
    return [results_map[t["instance_id"]] for t in tasks_to_run]


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Spider 2.0-DBT benchmark")
    parser.add_argument(
        "--tasks", nargs="*", default=None,
        help="Task filter: number (first N) or space-separated instance_ids",
    )
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="Timeout per task in seconds")
    parser.add_argument("--model", type=str, default=DEFAULT_MODEL, help="Model to use")
    parser.add_argument("--agent", type=str, default=None, help="Agent to use")
    parser.add_argument("--no-resume", action="store_true", help="Force re-run all tasks")
    parser.add_argument("--dry-run", action="store_true", help="Print tasks without running")
    parser.add_argument("--parallel", type=int, default=DEFAULT_PARALLEL, help=f"Number of concurrent tasks (default: {DEFAULT_PARALLEL})")
    args = parser.parse_args()

    # Auto-setup: download Spider2 files if not available
    if not TASK_JSONL.exists():
        print("Spider2 files not found. Running automatic setup...")
        from setup_spider2 import clone_spider2, download_databases, run_spider2_setup, create_directories
        clone_spider2()
        download_databases()
        run_spider2_setup()
        create_directories()
        if not TASK_JSONL.exists():
            print(f"ERROR: Task file still not found after setup: {TASK_JSONL}")
            sys.exit(1)

    all_tasks = load_tasks(TASK_JSONL)
    tasks = filter_tasks(all_tasks, args.tasks)

    print("=" * 60)
    print("Spider 2.0-DBT Benchmark Runner")
    print("=" * 60)
    print(f"  Tasks: {len(tasks)} / {len(all_tasks)}")
    print(f"  Model: {args.model}")
    print(f"  Timeout: {args.timeout}s")
    print(f"  Resume: {'disabled' if args.no_resume else 'enabled'}")
    print(f"  Parallel: {args.parallel} worker{'s' if args.parallel > 1 else ''}")
    print()

    if args.dry_run:
        for t in tasks:
            print(f"  {t['instance_id']}: {t.get('instruction', t.get('question', ''))[:80]}...")
        return

    # Ensure directories exist
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    INCREMENTAL_DIR.mkdir(parents=True, exist_ok=True)

    total_start = time.perf_counter()
    resume = not args.no_resume

    if args.parallel > 1:
        results = run_parallel(tasks, len(all_tasks), args.model, args.agent, args.timeout, resume, args.parallel)
    else:
        results = run_sequential(tasks, len(all_tasks), args.model, args.agent, args.timeout, resume)

    total_elapsed = time.perf_counter() - total_start
    skipped = sum(1 for r in results if load_incremental(r["instance_id"]) is not None and r.get("_cached", False))

    # Aggregate results
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    completed_count = sum(1 for r in results if r["exit_code"] == 0)
    failed_count = sum(1 for r in results if r["exit_code"] != 0 and not r["timed_out"])
    timed_out_count = sum(1 for r in results if r["timed_out"])

    aggregate = {
        "timestamp": timestamp,
        "model": args.model,
        "agent": args.agent,
        "timeout": args.timeout,
        "parallel_workers": args.parallel,
        "total_tasks": len(results),
        "completed": completed_count,
        "failed": failed_count,
        "timed_out": timed_out_count,
        "total_elapsed_s": round(total_elapsed, 2),
        "avg_elapsed_s": round(sum(r["elapsed_s"] for r in results) / max(len(results), 1), 2),
        "task_results": results,
    }

    # Save aggregate
    output_path = RESULTS_DIR / f"spider2_benchmark_{timestamp}.json"
    output_path.write_text(json.dumps(aggregate, indent=2))

    # Also save as "latest" symlink
    latest_path = RESULTS_DIR / "latest.json"
    if latest_path.is_symlink() or latest_path.exists():
        latest_path.unlink()
    latest_path.symlink_to(output_path.name)

    # Print summary
    print()
    print("=" * 60)
    print("Benchmark Complete")
    print("=" * 60)
    print(f"  Total tasks:  {aggregate['total_tasks']}")
    print(f"  Completed:    {aggregate['completed']}")
    print(f"  Failed:       {aggregate['failed']}")
    print(f"  Timed out:    {aggregate['timed_out']}")
    print(f"  Wall time:    {aggregate['total_elapsed_s']}s")
    print(f"  Avg per task: {aggregate['avg_elapsed_s']}s")
    print(f"  Results:      {output_path}")
    print()
    print("Next: python evaluate_results.py")


if __name__ == "__main__":
    main()
