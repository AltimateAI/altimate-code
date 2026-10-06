#!/usr/bin/env python3
"""eval.py --split heldout,control --arm <arm> --runs N --out results.jsonl [--run-dir D] [--label L]

Arms: none | playbook:<path> | gold | workspace-B
workspace-B runs as user B with ALTIMATE_WORKSPACE=1 and no local playbook; the skill must arrive by the
real workspace sync. Needs a run dir whose backend-state.json holds A's published skill (the loop's).
"""
import argparse
import os
import sys

import common as C


def arm_config(arm):
    """-> (playbook_text|None, user, workspace)"""
    if arm == "none":
        return None, "a", False
    if arm == "gold":
        return C.gold_playbook(), "a", False
    if arm.startswith("playbook:"):
        return open(arm.split(":", 1)[1]).read(), "a", False
    if arm == "workspace-B":
        return None, "b", True
    sys.exit(f"unknown arm {arm}")


def evaluate(run_dir, arm, splits, runs, out, parallel=4, model=C.AGENT_MODEL, label=None, only=None,
             limit=None, backend=None):
    """backend: a started C.Backend (required for workspace-B)."""
    text, user, ws = arm_config(arm)
    label = label or arm
    tasks = C.select_tasks(splits, limit=limit, only=only)
    if runs < 1 or not tasks:
        raise ValueError("evaluation requires positive runs and at least one task")
    C.reset_output(out, run_dir)
    # run_idx outermost so a partial result still has balanced runs
    specs = [{"run_dir": run_dir, "task": t, "arm": label, "user": user, "run_idx": i, "playbook": text,
              "workspace": ws, "model": model} for i in range(runs) for t in tasks]
    pub = backend.published_skill("b") if (arm == "workspace-B" and backend) else {}

    def done(r):  # record both sides' hashes before the record is written
        if arm == "workspace-B":
            r["backend_sha"] = pub.get("sha")
            r["ws_matches_backend"] = bool(r.get("ws_arrived")) and all(x["sha"] == pub.get("sha") for x in r["ws_skills"])
        C.append_jsonl(out, r)
    recs = C.run_many(specs, parallel, on_done=done)
    if arm == "workspace-B":
        missing = [r for r in recs if not r.get("ws_matches_backend")]
        versions = sorted({s["sha"] for r in recs for s in r.get("ws_skills", [])})
        C.log(f"workspace-B: skill arrived in {len(recs) - len(missing)}/{len(recs)} runs; versions(sha) {versions}; "
              f"backend (as B) sha {pub.get('sha')}; matching {sum(r['ws_matches_backend'] for r in recs)}/{len(recs)}")
        if missing:
            sys.exit(f"ASSERTION FAILED: target workspace skill missing or stale in {len(missing)} run(s)")
    if any(not r.get("completed") or r.get("error") for r in recs):
        raise RuntimeError("evaluation contains incomplete agent/setup runs; see output records")
    return recs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="heldout,control")
    ap.add_argument("--arm", required=True)
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--out", required=True)
    ap.add_argument("--run-dir")
    ap.add_argument("--run-id")
    ap.add_argument("--label", help="arm label stored in records (default: the arm)")
    ap.add_argument("--parallel", type=int, default=4)
    ap.add_argument("--model", default=C.AGENT_MODEL)
    ap.add_argument("--tasks", help="comma-separated task ids")
    ap.add_argument("--limit", type=int, help="max tasks per split")
    ap.add_argument("--backend", choices=["saas", "fake"], default="saas")
    ap.add_argument("--workspace-id", type=int, help="saas: id of the workspace bound to the demo remote")
    a = ap.parse_args()
    C.require_dbt()
    run_dir = C.run_dir_for(a.run_dir, a.run_id)
    only = set(a.tasks.split(",")) if a.tasks else None
    splits = a.split.split(",")
    if a.arm == "workspace-B":
        with C.Backend(run_dir, a.backend, a.workspace_id) as be:
            if not be.published_skill("b").get("found"):
                sys.exit("workspace-B: the workspace holds no team-playbook skill (run the loop's publish step first)")
            C.warm_users(run_dir)
            C.resolve_models(run_dir, a.model, a.model, user="b")
            recs = evaluate(run_dir, a.arm, splits, a.runs, a.out, a.parallel, a.model, a.label, only, a.limit, be)
    else:
        C.setup_users(run_dir, saas=a.backend == "saas", workspace_id=a.workspace_id)
        C.warm_users(run_dir)
        C.resolve_models(run_dir, a.model, a.model)
        evaluate(run_dir, a.arm, splits, a.runs, a.out, a.parallel, a.model, a.label, only, a.limit)


if __name__ == "__main__":
    main()
