#!/usr/bin/env python3
"""Simulated teammate: a senior dbt engineer who reviews the agent's changes and types a chat message.

The teammate knows the team conventions (demo/verifier/gold_playbook.md, i.e. the human's own knowledge). It
NEVER sees verifier output, check names or scores: it only gets the ticket text, the conventions, and a private
copy of the agent's workdir (without .altimate-code, so it cannot see the agent's playbook or learn state).

usage (smoke test): teammate.py <workdir> <task_id> [--run-dir D]
"""
import argparse
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import time
import uuid

import common as C

REVIEWER = "r"
REVIEWER_MODEL = os.environ.get("REVIEWER_MODEL", "google-vertex-anthropic/claude-sonnet-4-6@default")
REVIEWER_MAX_TURNS = 10
REVIEWER_TIMEOUT = int(os.environ.get("REVIEWER_TIMEOUT", "300"))

PERSONA = """You are a senior analytics engineer on the acme-shop dbt team, reviewing a teammate's work in chat.
A developer was given the ticket below and has just made changes in the repository in your current directory.

Ticket the developer was given: {ticket}

These are the team's conventions, from your own experience of how this team works:

{conventions}

Your job:
1. Inspect what changed. Run `git status` and `git diff` (and `git diff --no-index /dev/null <file>` or just read the file
   for new untracked files) and read every new or changed file under `models/`. You may read other files in the repo
   for context. Do not modify anything and do not run dbt.
2. Decide whether the changes follow the team conventions above, for this kind of change.
3. Reply ONLY with the chat message you would send to the developer:
   - If something violates the conventions: 1 to 3 sentences, natural and conversational, like a quick Slack message
     from a colleague. Be specific about what is wrong in their change (name the file/column/behaviour) and what
     you would expect instead. Do not number rules or mention rule IDs, do not mention tests, CI, checks or graders,
     and do not praise or pad.
   - If nothing violates the conventions: reply with exactly: LGTM
Do not narrate your inspection, do not write a checklist, no emojis, no preamble. Any text you write after your last tool
call is sent verbatim to the developer, so after inspecting, write only the chat message (or LGTM)."""


def setup_reviewer(run_dir):
    """Isolated HOME for the reviewer user `r`: same credentials and sandbox config as user a, separate data dir."""
    home = os.path.join(run_dir, f"home-{REVIEWER}")
    src = os.path.join(run_dir, "home-a")
    for rel in (os.path.join(".altimate", "altimate.json"), os.path.join(".config", "altimate-code", "altimate-code.json")):
        dest = os.path.join(home, rel)
        if os.path.isfile(dest):
            continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copyfile(os.path.join(src, rel), dest)
        os.chmod(dest, 0o600)


def snapshot(workdir, dest):
    """Private copy of the workdir for the reviewer: keeps .git (so git diff works), drops the agent's
    .altimate-code (playbook, learn state, signals), build output and logs."""
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    shutil.copytree(workdir, dest, symlinks=True,
                    ignore=shutil.ignore_patterns(".altimate-code", "target", "logs", "dbt_packages", "*.duckdb*"))
    return dest


def final_text(events_path):
    """The assistant's last text block: all text events after the final tool call."""
    buf = []
    for line in open(events_path, errors="replace"):
        if not line.startswith("{"):
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("type") == "tool_use":
            buf = []
        elif e.get("type") == "text":
            t = ((e.get("part") or {}).get("text") or "").strip()
            if t:
                buf.append(t)
    return "\n".join(buf).strip()


def clean_message(text):
    t = re.sub(r"^```\w*\n?|\n?```$", "", text.strip()).strip()
    if len(t) >= 2 and t[0] == t[-1] and t[0] in "\"'":
        t = t[1:-1].strip()
    return t


def is_lgtm(text):
    """Exactly LGTM, or a verbose approval whose last line is LGTM (the reviewer narrated before approving)."""
    lines = [l for l in (text or "").strip().splitlines() if l.strip()]
    return bool(lines) and bool(re.fullmatch(r"\W*LGTM\W*", lines[-1], re.I))


def review(run_dir, workdir, task, tag="", model=REVIEWER_MODEL):
    """Return {"text", "lgtm", "cost", "error", "events"} for the agent's current workdir state."""
    setup_reviewer(run_dir)
    name = f"{tag}{task['id']}.review.{uuid.uuid4().hex[:6]}"
    snap = snapshot(workdir, os.path.join(run_dir, "review", name))
    logdir = os.path.join(run_dir, "logs")
    os.makedirs(logdir, exist_ok=True)
    events_path = os.path.join(logdir, name + ".events.jsonl")
    conventions = open(os.path.join(C.VERIFIER, "gold_playbook.md")).read().strip()
    prompt = PERSONA.format(ticket=task["prompt"], conventions=conventions)
    cmd = shlex.split(C.ALTIMATE_CMD) + ["run", "--format", "json", "-m", model, "--max-turns",
                                         str(REVIEWER_MAX_TURNS), "--yolo", prompt]
    env = C.user_env(run_dir, REVIEWER)
    out = {"text": "", "lgtm": False, "cost": 0.0, "error": None, "events": os.path.relpath(events_path, run_dir)}
    for attempt in range(3):
        with open(events_path, "w") as so, open(os.path.join(logdir, name + ".stderr.txt"), "w") as se:
            with C._spawn_lock:
                proc = subprocess.Popen(cmd, cwd=snap, env=env, stdout=so, stderr=se, stdin=subprocess.DEVNULL,
                                        start_new_session=True)
                time.sleep(C.STAGGER_SECONDS)
            try:
                proc.wait(timeout=REVIEWER_TIMEOUT)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
                out["error"] = "reviewer timed out"
        err = open(os.path.join(logdir, name + ".stderr.txt"), errors="replace").read()
        if proc.returncode != 0 and os.path.getsize(events_path) < 200 and "database is locked" in err:
            time.sleep(3 + 3 * attempt)
            continue
        break
    ev = C.parse_events(events_path)
    out["cost"] = round(ev["cost"], 5)
    out["text"] = clean_message(final_text(events_path))
    if not out["text"] and not out["error"]:
        out["error"] = f"reviewer produced no text (rc={proc.returncode}): {err[-200:]}"
    out["lgtm"] = is_lgtm(out["text"])
    shutil.rmtree(snap, ignore_errors=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workdir")
    ap.add_argument("task_id")
    ap.add_argument("--run-dir", help="a run dir with home-a (default: this workdir's run dir)")
    a = ap.parse_args()
    wd = os.path.abspath(a.workdir)
    run_dir = os.path.abspath(a.run_dir) if a.run_dir else os.path.dirname(os.path.dirname(wd))
    task = C.load_tasks()[a.task_id]
    r = review(run_dir, wd, task, tag="smoke-")
    print(json.dumps(r, indent=2))


if __name__ == "__main__":
    main()
