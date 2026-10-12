"""Helpers shared by the learn-v1 benchmark drivers (stdlib only; imports ../common.py).

  load_dir(path)        -> {task_id: task} for every *.json task file in a directory
  install(extra_dirs)   -> make common.select_tasks()/load_tasks() also see v1bench tasks, so
                           `eval.py --split vague` style selection works from a driver script
Vague tasks keep `setup`/`verify` argv of the ORIGINAL task id (the product-independent verifier reads
demo/verifier/tasks/<id>.json), only `id`, `split` and `prompt` differ.
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import common as C  # noqa: E402

VAGUE_DIR = os.path.join(HERE, "vague_tasks")


def load_dir(path):
    out = {}
    for f in sorted(glob.glob(os.path.join(path, "*.json"))):
        t = json.load(open(f))
        if "id" in t and "verify" in t:
            out[t["id"]] = t
    return out


def install(*dirs):
    base = C.load_tasks

    def load_tasks():
        d = base()
        for p in dirs:
            d.update(load_dir(p))
        return d
    C.load_tasks = load_tasks
    return load_tasks


def read_pool(path):
    return [json.loads(l) for l in open(path) if l.strip()]


NEEDS = json.load(open(os.path.join(HERE, "needs.json"))) if os.path.isfile(os.path.join(HERE, "needs.json")) else {}
BASE_TASKS = {t["id"]: t.get("base_task", t["id"]) for t in load_dir(VAGUE_DIR).values()}


def shown_lessons(trace_path, lessons):
    """Retrieval evidence for playbook arms: ids of `lessons` whose `[L-id]` marker (or first 60 chars of text) appears in
    the session trace (system prompt + generation inputs). For retrieval arms prefer the product's own selection record."""
    try:
        text = open(trace_path, errors="replace").read()
    except OSError:
        return None
    return [l["id"] for l in lessons if f"[{l['id']}]" in text or l["text"][:60] in text]


def recall(task_id, shown):
    """Fraction of the lessons the task needs (needs.json) that were shown; None when the task needs none."""
    need = NEEDS.get(BASE_TASKS.get(task_id, task_id)) or []
    if not need or shown is None:
        return None
    return sum(1 for n in need if n in shown) / len(need)
