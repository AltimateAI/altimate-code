#!/usr/bin/env python3
"""eval_v1.py --run-dir D --arm ARM --label L --runs 3 --out D/eval/L.jsonl [--split heldout,control] [--parallel 4]

Like eval.py, for the learn-v1 lesson store. ARM:
  none
  lessons:<pool.jsonl|approved.json|playbook.md>[;core=N][;retrieved=N][;budget=N][;session_max=N][;nopaths][;pin=real|ids][;only=real]
  vague:<pool|none>[same options]      vague prompts (v1bench/vague_tasks) + the 2 original controls
The run starts with the pool installed as approved.json (NO skill file). The limits are set per run through
ALTIMATE_LEARN_CORE_LESSONS / _RETRIEVED_LESSONS / _BUDGET_TOKENS / _SESSION_MAX_LESSONS; omitted ones keep the product
defaults. ALTIMATE_CMD comes from the environment (point it at the rsi worktree).

Per run (one JSON line, common.run_task's record plus):
  pass, checks, tokens{input,output,cache_read,cache_write}, cost, tool_calls, steps   (from run_task)
  shown      [{id, tier, at}]  lessons the product showed (shown.jsonl of the run's workdir, this session)
  retrieval  {needed, found, recall, recall_by_tier, tiers, n_shown, precision, shown_by_tier, shown_kinds}
             recall = needed lesson ids (needs.json, keyed by the ORIGINAL task id) that appear in shown.jsonl / needed;
             None for tasks that need nothing (controls). tiers = the tier each needed lesson came from.
Watchdog: after 3 runs with tool_calls == 0 the arm stops and the exit code is 3 (as run_baselines.sh).
"""
import argparse
import json
import os
import sys

import lib  # noqa: F401  (patches common; must come first)
import tasks_lib
import common as C

NEEDS = tasks_lib.NEEDS


def run_one(spec):
    arm = spec["arm_obj"]
    rec = C.run_task(spec)
    task = spec["task"]
    base = task.get("base_task") or task["id"]
    rec.update(arm_spec=arm.label, base_task=base, limits=arm.env)
    sid, wd = rec.get("session_id"), rec.get("workdir")
    shown = lib.read_shown(wd, sid) if (arm.lessons and sid and wd and os.path.isdir(wd)) else []
    rec["shown"] = shown
    rec["retrieval"] = lib.retrieval_metrics(NEEDS.get(base) or [], shown, arm.kinds)
    rec["n_lessons"] = len(arm.lessons)
    return rec


def evaluate(run_dir, arm_str, label, splits=None, runs=3, out=None, parallel=4, model=C.AGENT_MODEL, only=None):
    """-> (records, tripped). A full retry replaces `out`; records stream as they finish."""
    C.validate_id(label, "arm label")
    if runs < 1:
        raise ValueError("runs must be positive")
    tasks_lib.install(tasks_lib.VAGUE_DIR)
    arm = lib.parse_arm(arm_str)
    splits = splits or arm.splits
    tasks = C.select_tasks(splits, only=only)
    if not tasks:
        sys.exit(f"no tasks for splits {splits}")
    if out:
        C.reset_output(out, run_dir)
    token = arm.token
    # run_idx outermost so a partial result still has balanced runs
    specs = [{"run_dir": run_dir, "task": t, "arm": label, "user": "a", "run_idx": i, "playbook": token,
              "workspace": False, "model": model, "env_extra": dict(arm.env), "arm_obj": arm}
             for i in range(runs) for t in tasks]
    C.log(f"arm {label}: {arm_str} -> {len(arm.lessons)} lessons, env {arm.env}, {len(specs)} runs")
    return lib.run_specs(specs, parallel, on_done=(lambda r: C.append_jsonl(out, r)) if out else None, fn=run_one)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", required=True)
    ap.add_argument("--label")
    ap.add_argument("--split", help="default: heldout,control (vague: vague,control)")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--out", required=True)
    ap.add_argument("--run-dir")
    ap.add_argument("--run-id")
    ap.add_argument("--parallel", type=int, default=4)
    ap.add_argument("--model", default=C.AGENT_MODEL)
    ap.add_argument("--tasks", help="comma-separated task ids")
    a = ap.parse_args()
    lib.preflight()
    C.require_dbt()
    run_dir = C.run_dir_for(a.run_dir, a.run_id)
    C.setup_users(run_dir, None)  # isolated fake-backend config; no SaaS credentials
    C.warm_users(run_dir)
    C.resolve_models(run_dir, a.model, a.model)
    records, tripped = evaluate(run_dir, a.arm, a.label or lib.parse_arm(a.arm).kind, a.split.split(",") if a.split else None, a.runs, a.out,
                          a.parallel, a.model, set(a.tasks.split(",")) if a.tasks else None)
    sys.exit(3 if tripped else (1 if any(r.get("error") or r.get("completed") is False for r in records) else 0))


if __name__ == "__main__":
    main()
