"""Recompute the integrity fields of every eval record in a run dir from the saved events and traces.

usage: rescore.py runs/<run_id>

Rewrites eval/*.jsonl in place (originals kept as *.jsonl.orig) with:
  leak / leak_hits      -- re-scanned with the current leak_scan (workdir-basename stripping)
  playbook_in_context   -- re-checked with playbook_in_trace (wrapper marker, not a body line)
Needed for runs recorded before those two detectors were fixed; both fixes are documented in common.py.
"""
import glob
import json
import os
import shutil
import sys

import common as C


def trace_for(run_dir, rec):
    sid = rec.get("session_id")
    if not sid:
        return None
    if rec.get("trace_path") and os.path.isfile(rec["trace_path"]):
        return rec["trace_path"]
    hits = glob.glob(os.path.join(run_dir, f"home-{rec['user']}", ".local", "share", "altimate-code", "traces", sid + ".json"))
    return hits[0] if hits else None


def main(run_dir):
    for path in sorted(glob.glob(os.path.join(run_dir, "eval", "*.jsonl"))):
        recs = [json.loads(l) for l in open(path) if l.strip()]
        changed = 0
        for r in recs:
            before = (r.get("leak"), r.get("playbook_in_context"))
            ev_path = os.path.join(run_dir, r["events"]) if r.get("events") else None
            if ev_path and not os.path.isfile(ev_path) and r.get("workdir"):
                source_run = os.path.dirname(os.path.dirname(r["workdir"]))
                ev_path = os.path.join(source_run, r["events"])
            if ev_path and os.path.isfile(ev_path):
                hits = C.leak_scan(C.parse_events(ev_path)["tool_inputs"], r["workdir"])
                r["leak"], r["leak_hits"] = bool(hits), hits[:5]
                r.pop("rescore_error", None)
            else:
                r["leak"], r["leak_hits"] = None, []
                r["rescore_error"] = "saved events unavailable; integrity could not be rescored"
            tr = trace_for(run_dir, r)
            r["playbook_in_context"] = C.playbook_in_trace(open(tr, errors="replace").read()) if tr else None
            changed += before != (r.get("leak"), r.get("playbook_in_context"))
        if not os.path.exists(path + ".orig"):
            shutil.copy(path, path + ".orig")
        with open(path, "w") as f:
            for r in recs:
                f.write(json.dumps(r) + "\n")
        in_ctx = sum(1 for r in recs if r.get("playbook_in_context"))
        leaks = sum(1 for r in recs if r.get("leak"))
        print(f"{os.path.basename(path):22} n={len(recs):2} playbook_in_context={in_ctx:2} leak={leaks} changed={changed}")


if __name__ == "__main__":
    main(sys.argv[1])
