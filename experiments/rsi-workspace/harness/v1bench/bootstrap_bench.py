#!/usr/bin/env python3
"""bootstrap_bench.py --run-dir D -m MODEL [--source-run runs/corr-main] [--max-reflections 20] [--label bootstrap]
                     (benchmark item 7 and the bootstrap part of item 9)

Mine lessons from the history of an earlier benchmark run, then evaluate held-out pass with them.

 1. Copy the XDG data dir of <source-run>/home-a (the user that ran the TRAIN sessions and their teammate corrections;
    home-r holds only the reviewer's sessions) into a fresh home, together with the credentials/config.
 2. In the copy's session table keep ONLY the train sessions (workdir .../work/i<N>-train-*) and re-point them to ONE
    fresh project directory (bootstrap scope = project id AND directory; each train workdir has its own directory, and
    they share the project id because the demo repo has one root commit). Heldout/control/eval sessions are deleted
    from the copy, so held-out stays held out. The source run is never modified.
 3. `learn bootstrap --dry-run` -> record the scope and signals found; `learn bootstrap --yes -m MODEL
    --max-reflections N --max-seconds S` -> record its summary (signals, reflections, candidates added/edited,
    tokens and estimated cost). Then `learn promote --yes`.
 4. Recovery of the real lessons: heuristic keyword match of the promoted lessons against L-2fe6 (cents), L-8536
    (soft delete), L-8201 (timestamps/UTC); the full texts are saved for hand review.
 5. Evaluate heldout+control with the promoted set (`<label>-lessons`, eval_v1) and, for reference, with nothing is
    done here: use eval_v1 `none` / baselines.
Writes <run-dir>/bootstrap.json (everything above) and <run-dir>/eval/<label>-lessons.jsonl.
"""
import argparse
import glob
import json
import os
import re
import shutil
import sqlite3
import sys
import time

import lib  # noqa: F401  (patches common)
import common as C
import eval_v1

TRAIN_DIR_LIKE = "%/work/i_-train-%"
RECOVERY_KEYS = {  # heuristic only; hand review is the record
    "L-2fe6": ["cents"],
    "L-8536": ["_is_deleted", "soft-delete", "soft delete", "soft_delete"],
    "L-8201": ["utc", "to_utc", "_ts", "timestamp"],
}


def reject_overlap(source, destination):
    source, destination = os.path.realpath(source), os.path.realpath(destination)
    if os.path.commonpath([source, destination]) in (source, destination):
        raise ValueError("bootstrap source and destination paths must not overlap")


def prepare_home(source_home, dest_home, new_dir):
    """Copy data dir + credentials/config; keep only train sessions and move them to new_dir. -> counts."""
    reject_overlap(source_home, dest_home)
    if os.path.exists(dest_home):
        C.safe_rmtree(dest_home, os.path.dirname(dest_home))
    os.makedirs(dest_home)
    for rel in (".altimate", ".config"):
        if os.path.isdir(os.path.join(source_home, rel)):
            shutil.copytree(os.path.join(source_home, rel), os.path.join(dest_home, rel))
    src_data = os.path.join(source_home, ".local", "share", "altimate-code")
    dst_data = os.path.join(dest_home, ".local", "share", "altimate-code")
    os.makedirs(dst_data)
    # consistent snapshot of the WAL-mode db, without touching the source
    src = sqlite3.connect(f"file:{os.path.join(src_data, 'opencode-local.db')}?mode=ro", uri=True)
    dst = sqlite3.connect(os.path.join(dst_data, "opencode-local.db"))
    src.backup(dst)
    src.close()
    n0 = dst.execute("select count(*) from session").fetchone()[0]
    dst.execute("pragma foreign_keys=on")
    dst.execute("delete from session where directory not like ?", (TRAIN_DIR_LIKE,))
    dst.execute("update session set directory=? where directory like ?", (new_dir, TRAIN_DIR_LIKE))
    dst.commit()
    kept = dst.execute("select count(*), count(distinct project_id) from session where parent_id is null").fetchone()
    leftovers = dst.execute("select count(*) from session where directory != ?", (new_dir,)).fetchone()[0]
    dst.close()
    if leftovers:
        sys.exit(f"{leftovers} sessions outside the train set remained in the copied database (child sessions?)")
    return {"sessions_before": n0, "root_sessions_kept": kept[0], "projects": kept[1]}


def parse_dry(text):
    m = re.search(r"Signals found: (\d+) \((\d+) corrections, (\d+) tool failures", text)
    s = re.search(r"Bootstrap scope: (\d+) root session", text)
    e = re.search(r"Estimated input tokens: (\d+) for up to (\d+) reflection", text)
    return {"sessions": int(s.group(1)) if s else None,
            "signals": int(m.group(1)) if m else None, "corrections": int(m.group(2)) if m else None,
            "tool_failures": int(m.group(3)) if m else None,
            "estimated_input_tokens": int(e.group(1)) if e else None,
            "estimated_reflections": int(e.group(2)) if e else None}


def parse_summary(text):
    m = re.search(r"Bootstrap summary: (\d+) signals found, (\d+) added; (\d+) reflections run; candidate lessons: "
                  r"(\d+) added, (\d+) edited", text)
    t = re.search(r"Tokens(?: \(estimated\))?: (\d+) input, (\d+) output\. Estimated cost: (\$[\d.]+|unavailable)", text)
    return {"signals_found": int(m.group(1)) if m else None, "signals_added": int(m.group(2)) if m else None,
            "reflections_run": int(m.group(3)) if m else None, "candidates_added": int(m.group(4)) if m else None,
            "candidates_edited": int(m.group(5)) if m else None,
            "input_tokens": int(t.group(1)) if t else None, "output_tokens": int(t.group(2)) if t else None,
            "tokens_estimated": bool(re.search(r"Tokens \(estimated\)", text)),
            "cost_usd": float(t.group(3)[1:].rstrip(".")) if t and t.group(3).startswith("$") else None}


def recovered(lessons):
    out = {}
    for lid, keys in RECOVERY_KEYS.items():
        out[lid] = [l["id"] for l in lessons if any(k in l["text"].lower() for k in keys)]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir")
    ap.add_argument("--run-id")
    ap.add_argument("--source-run", default=os.path.join(C.RUNS, "corr-main"))
    ap.add_argument("--source-user", default="a")
    ap.add_argument("-m", "--model", required=True, help="bootstrap reflector provider/model")
    ap.add_argument("--agent-model", default=C.AGENT_MODEL)
    ap.add_argument("--max-reflections", type=int, default=20)
    ap.add_argument("--max-seconds", type=int, default=900)
    ap.add_argument("--since", default="2026-01-01", help="ISO date or duration for learn bootstrap --since")
    ap.add_argument("--label", default="bootstrap")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--parallel", type=int, default=4)
    ap.add_argument("--skip-eval", action="store_true")
    a = ap.parse_args()
    C.validate_id(a.label, "bootstrap label")
    C.validate_id(a.source_user, "source user")
    lib.preflight()
    if a.run_id is not None:
        C.validate_id(a.run_id, "run id")
    if not a.run_dir and a.run_id is None:
        a.run_id = C.new_run_id()
    destination = a.run_dir or os.path.join(C.RUNS, a.run_id)
    reject_overlap(a.source_run, destination)
    reject_overlap(a.source_run, os.path.join(destination, "work", "bootstrap-project"))
    reject_overlap(a.source_run, os.path.join(destination, "home-a"))
    run_dir = C.run_dir_for(a.run_dir, a.run_id)
    eval_out = os.path.join(run_dir, "eval", f"{a.label}-lessons.jsonl")
    C.reset_output(eval_out, run_dir)  # invalidate old attribution before this attempt can fail
    C.require_dbt()
    result = {"source_run": os.path.abspath(a.source_run), "model": a.model, "max_reflections": a.max_reflections}
    # fresh project dir (a prepared demo workdir) and home
    project = os.path.join(run_dir, "work", "bootstrap-project")
    # Always prepare fresh state so an older approved.json cannot contaminate bootstrap.
    t = C.load_tasks()["train-refunds"]
    p = C.subprocess.run([x.replace("{workdir}", project) for x in t["setup"]], cwd=C.DEMO, capture_output=True,
                         text=True, env=dict(os.environ, DBT_BIN=C.DBT_BIN))
    if p.returncode:
        sys.exit("project setup failed: " + p.stdout + p.stderr)
    # pin the project id: a train workdir's .git/opencode holds the id its sessions were stored under
    src_wd = sorted(glob.glob(os.path.join(a.source_run, "work", "i[0-9]-train-*")))
    if not src_wd or not os.path.isfile(os.path.join(src_wd[0], ".git", "opencode")):
        sys.exit(f"no train workdir with .git/opencode under {a.source_run}/work")
    shutil.copyfile(os.path.join(src_wd[0], ".git", "opencode"), os.path.join(project, ".git", "opencode"))
    home = os.path.join(run_dir, "home-a")
    result["home"] = prepare_home(os.path.join(a.source_run, f"home-{a.source_user}"), home, os.path.realpath(project))
    C.setup_users(run_dir, None)  # does not touch home-a's data dir; refreshes credentials/config
    C.warm_users(run_dir)
    C.resolve_models(run_dir, a.agent_model, a.model)
    env = C.user_env(run_dir, "a")

    dry = C.altimate(["learn", "bootstrap", "--dry-run", "--since", a.since, "--limit", "200"], project, env, timeout=300)
    result["dry_run"] = dict(parse_dry(dry.stdout), rc=dry.returncode)
    open(os.path.join(run_dir, "bootstrap-dry-run.txt"), "w").write(dry.stdout + dry.stderr)
    C.log(f"dry run: {result['dry_run']}")
    if dry.returncode or not result["dry_run"]["signals"]:
        json.dump(result, open(os.path.join(run_dir, "bootstrap.json"), "w"), indent=2)
        sys.exit("dry run found no signals; see bootstrap-dry-run.txt (session scope or --since?)")

    t0 = time.time()
    real = C.altimate(["learn", "bootstrap", "--yes", "-m", a.model, "--since", a.since, "--limit", "200",
                       "--max-reflections", str(a.max_reflections), "--max-seconds", str(a.max_seconds)],
                      project, env, timeout=a.max_seconds + 300)
    open(os.path.join(run_dir, "bootstrap-run.txt"), "w").write(real.stdout + real.stderr)
    result["bootstrap"] = dict(parse_summary(real.stdout), rc=real.returncode, wall_s=round(time.time() - t0, 1))
    C.log(f"bootstrap: {result['bootstrap']}")

    if real.returncode:
        json.dump(result, open(os.path.join(run_dir, "bootstrap.json"), "w"), indent=2)
        sys.exit("bootstrap failed; partial candidates were not promoted")
    pr = C.altimate(["learn", "promote", "--yes"], project, env, timeout=300)
    result["promote"] = {"rc": pr.returncode, "output": (pr.stdout + pr.stderr)[-400:]}
    if pr.returncode:
        json.dump(result, open(os.path.join(run_dir, "bootstrap.json"), "w"), indent=2)
        sys.exit("bootstrap promotion failed; evaluation skipped")
    lessons = lib.read_approved(project)
    result["lessons"] = lessons
    result["n_lessons"] = len(lessons)
    result["recovered_real_lessons_heuristic"] = recovered(lessons)
    out_path = os.path.join(run_dir, "playbooks", "bootstrap-approved.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    json.dump(lessons, open(out_path, "w"), indent=2)
    json.dump(result, open(os.path.join(run_dir, "bootstrap.json"), "w"), indent=2)
    if not lessons or a.skip_eval:
        sys.exit(0 if lessons else "bootstrap promoted no lessons; nothing to evaluate")
    os.makedirs(os.path.join(run_dir, "eval"), exist_ok=True)
    records, tripped = eval_v1.evaluate(run_dir, f"lessons:{out_path}", f"{a.label}-lessons", None, a.runs,
                                  eval_out, a.parallel, a.agent_model)
    sys.exit(3 if tripped else (1 if any(r.get("error") or r.get("completed") is False for r in records) else 0))


if __name__ == "__main__":
    main()
