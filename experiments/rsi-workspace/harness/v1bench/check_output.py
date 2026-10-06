#!/usr/bin/env python3
"""Cheap restart check: exact, unique configured keys and no incomplete agent turns.

Usage: check_output.py FILE LABEL eval|vague|topic [RUNS]
Exit 0 means the arm is complete; malformed, duplicate, missing, leaked, or failed-run output exits 1.
Verifier failures are valid completed observations and do not make an arm incomplete.
"""
import json
import os
import sys

import tasks_lib
import common as C


def complete(path, label, kind, runs=3):
    if runs < 1:
        return False
    if kind == "topic":
        cfg = json.load(open(os.path.join(os.path.dirname(__file__), "topic_switch", "tasks.json")))
        indexes = {r["id"]: i for i, r in enumerate(cfg["request1"])}
        expected = {(r["id"], indexes[r["request1"]]) for r in cfg["sessions"]}
        key = lambda r: (r.get("session"), r.get("run_idx")) if type(r.get("run_idx")) is int else None
    else:
        tasks = C.load_tasks()
        if kind == "vague":
            tasks.update(tasks_lib.load_dir(tasks_lib.VAGUE_DIR))
        splits = {"vague", "control"} if kind == "vague" else {"heldout", "control"}
        expected = {(t["id"], i) for t in tasks.values() if t.get("split") in splits for i in range(runs)}
        key = lambda r: (r.get("task"), r.get("run_idx")) if type(r.get("run_idx")) is int else None
    try:
        records = C.read_jsonl(path)
        keys = [key(r) for r in records]
        return (len(keys) == len(expected) and set(keys) == expected
                and all(r.get("arm") == label and r.get("completed") is True and not r.get("error")
                        and not r.get("leak")
                        for r in records))
    except (OSError, ValueError, TypeError, KeyError):
        return False


if __name__ == "__main__":
    if len(sys.argv) not in (4, 5):
        sys.exit(__doc__)
    sys.exit(0 if complete(*sys.argv[1:4], int(sys.argv[4]) if len(sys.argv) == 5 else 3) else 1)
