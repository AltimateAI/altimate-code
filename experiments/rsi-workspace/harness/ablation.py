#!/usr/bin/env python3
"""ablation.py --run-dir D [--from-loop D2] : the no-feedback arm.

Same as loop iteration 1 (train tasks run with no playbook, then `learn reflect` on each), except the
reflector is given "No external feedback available." instead of the verifier JSON. No gating. Produces
<run_dir>/playbook-nofeedback.md. If the loop's iteration-1 trajectories exist they are reused (those
runs also had no playbook), so the only difference to the loop is the feedback text.
"""
import argparse
import os
import shutil

import common as C
import loop as L

NO_FEEDBACK = "No external feedback available."


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir")
    ap.add_argument("--run-id")
    ap.add_argument("--from-loop", help="run dir whose loop.jsonl iteration-1 train trajectories to reuse (default: run dir)")
    ap.add_argument("--train-limit", type=int)
    ap.add_argument("--parallel", type=int, default=4)
    ap.add_argument("--model", default=C.AGENT_MODEL)
    ap.add_argument("--reflector-model", default=C.REFLECTOR_MODEL)
    a = ap.parse_args()
    run_dir = C.run_dir_for(a.run_dir, a.run_id)
    log_p = os.path.join(run_dir, "ablation.jsonl")
    train = C.select_tasks(["train"], a.train_limit)
    C.setup_users(run_dir, None)  # no workspace is used; real creds are copied only to give the CLI a valid home
    C.warm_users(run_dir)
    model, reflector = C.resolve_models(run_dir, a.model, a.reflector_model)

    src = a.from_loop or run_dir  # sessions live in <run>/home-a, so reuse only works inside the same run dir
    if os.path.abspath(src) != run_dir:
        raise SystemExit("--from-loop must be the run dir itself (its sessions are stored in that run's home-a)")
    reuse = {r["task"]: r for r in C.read_jsonl(os.path.join(src, "loop.jsonl"))
             if r.get("phase") == "train" and r.get("iter") == 1 and r.get("session_id")
             and not r.get("playbook_sha")}
    if all(t["id"] in reuse for t in train):
        recs = [reuse[t["id"]] for t in train]
        C.log("reusing loop iteration-1 train trajectories")
    else:
        specs = [{"run_dir": run_dir, "task": t, "arm": "ablation-train", "user": "a", "run_idx": 0, "playbook": None,
                  "workspace": False, "model": model, "tag": "abl-"} for t in train]
        recs = C.run_many(specs, a.parallel, on_done=lambda r: C.append_jsonl(log_p, dict(r, phase="train")))
    maint = L.maintainer(run_dir, "maint-ablation")
    _, cand_p = L.learn_paths(maint)
    for r in recs:
        # The feedback is NOT derived from the verifier here, which is the point of the arm.
        res = L.reflect(run_dir, maint, r, reflector, NO_FEEDBACK, "abl")
        C.append_jsonl(log_p, {"type": "reflect", "task": r["task"], **res})
        C.log(f"reflect {r['task']}: {(res.get('result') or {}).get('summary') or res.get('raw')}")
    cand = L.read(cand_p)
    out = os.path.join(run_dir, "playbook-nofeedback.md")
    if cand is None:
        C.log("no-feedback reflector staged nothing; writing an empty playbook")
        cand = C.wrap_skill("<!-- no lessons were produced without feedback -->")
    open(out, "w").write(cand)
    hist = os.path.join(maint, ".altimate-code", "learn")
    if os.path.isdir(hist):
        shutil.copytree(hist, os.path.join(run_dir, "learn-history-ablation"), dirs_exist_ok=True)
    C.log(f"wrote {out}")


if __name__ == "__main__":
    main()
