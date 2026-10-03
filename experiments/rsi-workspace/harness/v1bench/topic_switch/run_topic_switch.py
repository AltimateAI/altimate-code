#!/usr/bin/env python3
"""run_topic_switch.py --arm <none|lessons:POOL[;opts]> --out results.jsonl [--run-id R] [--vague] [--parallel N]
                       [--sessions id,id] [--model M]

Arms are v1bench/lib.py arm strings (see eval_v1.py): the pool is installed as approved.json (NO skill file) and
the limits go in as ALTIMATE_LEARN_* env for BOTH turns. Per-request additions are governed by retrieved_lessons, so:
  enabled   lessons:POOL;core=0;retrieved=15   request 1 retrieves for its text, request 2 may add more (tier request/file)
  frozen    lessons:POOL;core=3;retrieved=0    only session-start core lessons; no retrieval at start or per request
                                               (the file hook can still add `file` lessons: check tier in the record)
  always-on lessons:POOL;only=real;pin=real;core=4;retrieved=0   old behaviour, the 4 real lessons pinned
Not yet run against a model. Per session in tasks.json:
  1. setup: request 2's task `setup` argv (the project is identical for every task) in a fresh workdir; lessons installed
  2. request 1: `run --format json -m M --max-turns 40 --yolo "<prompt1>"` (common.run_task with a synthetic task whose
     verify is a no-op, so only the agent turn is measured) -> session id from the events
  3. request 2: the SAME command plus `--session <sid>` and prompt 2 (cli/cmd/run.ts:305 option, :562 resume),
     same cwd, same HOME/XDG env (user a), same pattern as loop_corrections.followup (loop_corrections.py:136)
  4. score: request 2 task's verifier on the final workdir (C.run_verify)
Record = request-2 verifier result + per-turn tokens/cost/duration + t_req2_start (epoch ms; split trace spans on it)
+ retrieval for request 2: `shown` (shown.jsonl of the workdir for this session, with tier and time), and
  retrieval.recall_any         needed lessons (needs.json of request 2) shown at any point of the session
  retrieval.recall_turn2       needed lessons first shown AFTER request 2 started (tier request = request-2 note,
                               file = file hook), the per-request additions
  retrieval.in_context_from_turn1  needed lessons shown during turn 1 (session start tier core/retrieved or turn-1 file hook)
"""
import argparse
import json
import os
import shlex
import signal
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))  # v1bench (lib.py puts harness/ on sys.path)
import lib  # noqa: E402,F401  (patches common: lessons token + clean ALTIMATE_LEARN_* env)
import tasks_lib  # noqa: E402
import common as C  # noqa: E402

NOOP_VERIFY = ["python3", "-c", "print('{}')"]


def agent_turn(env, workdir, events_path, model, prompt, session=None, timeout=C.AGENT_TIMEOUT):
    cmd = shlex.split(C.ALTIMATE_CMD) + ["run", "--format", "json", "-m", model, "--max-turns", str(C.MAX_TURNS), "--yolo"]
    if session:
        cmd += ["--session", session]
    cmd.append(prompt.lstrip("-").strip())
    timed_out = False
    for attempt in range(4):
        with open(events_path, "w") as so, open(events_path.replace(".events.jsonl", ".stderr.txt"), "w") as se:
            with C._spawn_lock:
                p = subprocess.Popen(cmd, cwd=workdir, env=env, stdout=so, stderr=se, stdin=subprocess.DEVNULL,
                                     start_new_session=True)
                time.sleep(C.STAGGER_SECONDS)
            try:
                p.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(p.pid, signal.SIGKILL)
                p.wait()
        err = open(events_path.replace(".events.jsonl", ".stderr.txt"), errors="replace").read()
        if not timed_out and p.returncode != 0 and os.path.getsize(events_path) < 200 and "database is locked" in err:
            time.sleep(3 + 3 * attempt)
            continue
        break
    return p.returncode, timed_out


def _ms(iso):
    from datetime import datetime
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def run_session(spec):
    run_dir, ses, t1, t2, arm = spec["run_dir"], spec["session"], spec["t1"], spec["t2"], spec["arm"]
    # turn 1 through the normal task runner: synthetic task = request 1 prompt + request 2 setup, no-op verifier
    synth = dict(t2, id=ses["id"], prompt=t1["prompt"], verify=NOOP_VERIFY)
    r1 = C.run_task({"run_dir": run_dir, "task": synth, "arm": arm, "user": "a", "run_idx": spec["run_idx"],
                     "playbook": spec["arm_obj"].token, "model": spec["model"], "env_extra": dict(spec["arm_obj"].env)})
    rec = {"session": ses["id"], "request1": t1["id"], "request2": t2["id"], "arm": arm, "run_idx": spec["run_idx"],
           "workdir": r1["workdir"], "session_id": r1.get("session_id"), "model": spec["model"],
           "turn1": {k: r1.get(k) for k in ("tokens", "cost", "tool_calls", "steps", "duration", "timed_out",
                                            "skill_loaded", "playbook_in_context", "events", "error")}}
    if not r1.get("session_id") or r1.get("error"):
        rec.update({"pass": False, "score": 0.0, "checks": {}, "error": r1.get("error") or "turn 1 produced no session id"})
        return rec
    env = C.user_env(run_dir, "a")
    env.update(spec["arm_obj"].env)
    ev_path = os.path.join(run_dir, "logs", f"{ses['id']}.{arm.replace(':', '-').replace('/', '_')}.{spec['run_idx']}.turn2.events.jsonl")
    t0 = time.time()
    rec["t_req2_start"] = int(t0 * 1000)
    rc, timed_out = agent_turn(env, r1["workdir"], ev_path, spec["model"], spec["prompt2"], session=r1["session_id"])
    ev = C.parse_events(ev_path)
    verify = C.run_verify(t2, r1["workdir"])
    arm_obj = spec["arm_obj"]
    if arm_obj.lessons:
        shown = lib.read_shown(r1["workdir"], r1["session_id"])
        need = tasks_lib.NEEDS.get(t2["id"]) or []
        m = lib.retrieval_metrics(need, shown, arm_obj.kinds)
        t2_ms = rec["t_req2_start"]
        late = {x["id"] for x in shown if x["tier"] in ("request", "file") and _ms(x["at"]) >= t2_ms}
        early = {x["id"] for x in shown} - late
        m.update(recall_any=m["recall"],
                 recall_turn2=(sum(1 for n in need if n in late) / len(need)) if need else None,
                 in_context_from_turn1=[n for n in need if n in early])
        rec["shown"], rec["retrieval"] = shown, m
    rec.update({
        "arm_spec": arm_obj.label, "limits": arm_obj.env,
        "pass": bool(verify.get("pass")), "score": verify.get("score", 0.0),
        "checks": {C.check_id(c["name"]): bool(c["ok"]) for c in verify.get("checks", [])}, "verify": verify,
        "same_session": ev["session_id"] == r1["session_id"],
        "turn2": {"tokens": ev["tokens"], "cost": round(ev["cost"], 5), "tool_calls": ev["tool_calls"], "steps": ev["steps"],
                  "duration": round(time.time() - t0, 1), "timed_out": timed_out, "rc": rc, "tools": ev["tools"],
                  "events": os.path.relpath(ev_path, run_dir)},
        "leak": bool(C.leak_scan(ev["tool_inputs"], r1["workdir"])),
        "trace_path": r1.get("trace_path"),
    })
    C.log(f"{ses['id']:50} {arm:10} pass={rec['pass']} same_session={rec['same_session']} "
          f"checks={''.join(k[1] if v else '-' for k, v in sorted(rec['checks'].items()))}")
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--label", help="arm label stored in records (default: the arm string)")
    ap.add_argument("--run-dir")
    ap.add_argument("--run-id")
    ap.add_argument("--vague", action="store_true", help="request 2 uses the vague prompt variant (staging tasks only)")
    ap.add_argument("--parallel", type=int, default=4)
    ap.add_argument("--model", default=C.AGENT_MODEL)
    ap.add_argument("--sessions", help="comma-separated session ids")
    a = ap.parse_args()
    cfg = json.load(open(os.path.join(HERE, "tasks.json")))
    base = C.load_tasks()
    vague = tasks_lib.load_dir(tasks_lib.VAGUE_DIR)
    r1 = {x["id"]: x for x in cfg["request1"]}
    lib.preflight()
    arm_obj = lib.parse_arm(a.arm)
    run_dir = C.run_dir_for(a.run_dir, a.run_id)
    C.setup_users(run_dir, None)
    C.warm_users(run_dir)
    specs = []
    for i, s in enumerate(cfg["sessions"]):
        if a.sessions and s["id"] not in a.sessions.split(","):
            continue
        t2 = base[s["request2"]]
        p2 = t2["prompt"]
        if a.vague:
            v = cfg["request2_vague_variants"].get(s["request2"])
            if not v:
                continue
            p2 = vague[v]["prompt"]
        specs.append({"run_dir": run_dir, "session": s, "t1": r1[s["request1"]], "t2": t2, "prompt2": p2, "arm": a.label or a.arm,
                      "arm_obj": arm_obj, "run_idx": cfg["request1"].index(r1[s["request1"]]), "model": a.model})
    # watchdog: turn 1 with zero tool calls three times means the install/worktree vanished
    wd = lib.Watchdog()

    def one(spec):
        if wd.tripped:
            return None
        rec = run_session(spec)
        wd.note(rec["turn1"])
        C.append_jsonl(a.out, rec)
        return rec
    with ThreadPoolExecutor(max_workers=a.parallel) as ex:
        list(ex.map(one, specs))
    if wd.tripped:
        C.log("ENV-BROKEN: turn 1 made zero tool calls 3 times; arm stopped")
        sys.exit(3)


if __name__ == "__main__":
    main()
