#!/usr/bin/env python3
"""drift_v1.py --run-dir D --reflector-model M [--iterations 2] [--label L]   (benchmark item 6, new lesson store)

Outdated lessons -> teammate corrections -> reflect -> promote, for K iterations, then evaluate the final approved set.

  seed       maintainer checkout gets budget/arms/stale-seed.md as approved.json (4 stale lessons, no SKILL.md)
  per iter   every train task: the agent starts with the maintainer's CURRENT approved lessons (installed as
             approved.json in its workdir), ALTIMATE_LEARN_CAPTURE=1; the simulated teammate (teammate.py) reviews and
             sends up to 2 correction rounds in the same session (loop_corrections.train_session / followup flow,
             followup variant with ALTIMATE_LEARN_AUTO off so nothing reflects behind the harness's back)
  learn      the workdirs' signals.jsonl are copied into the maintainer checkout (open), then
             `learn reflect --pending -m <reflector> --json`  (stages candidate.json), then
             `learn promote --yes` (gate: maintainer approval, no verifier; a failed promote -> `learn reject`)
  final      approved.json of the maintainer -> playbooks/final-approved.json, evaluated with eval_v1 on
             heldout+control as `<label>-final` (use eval_v1 directly with --arm lessons:budget/arms/stale-seed.md for
             the no-learning baseline)
Logs: loop.jsonl (sessions, online metric = corrections per session, reflect results with wall time, gate, retirement
diff vs the stale seed), eval_only.jsonl (verifier first-attempt results; never given to learn; assert_no_verifier_text
scans every learn input). Reflection tokens/dollars are NOT reported by `learn reflect` (only bootstrap prints a
summary); the harness records wall time and the JSON result. Reviewer env as budget/run_drift.sh:
REVIEWER_MODEL=google-vertex/gemini-3.1-pro-preview REVIEWER_MAX_TURNS=20.
"""
import argparse
import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import lib  # noqa: F401  (patches common)
import common as C
import loop_corrections as LC
import teammate as T
from loop import maintainer

import eval_v1

SEED = os.path.join(lib.HARNESS, "budget", "arms", "stale-seed.md")


def signals_path(workdir):
    return os.path.join(lib.learn_dir(workdir), "signals.jsonl")


def copy_signals(workdir, maint):
    """A maintainer cannot pull a teammate's signals: append this workdir's records (one session each) to the
    maintainer checkout's store as open signals."""
    src, dst = signals_path(workdir), signals_path(maint)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    have = {r.get("id") for r in C.read_jsonl(dst)}
    new = 0
    with open(dst, "a") as f:
        for r in C.read_jsonl(src):
            if not isinstance(r, dict) or r.get("id") in have:
                continue
            r["status"] = "open"
            r.pop("consumedBy", None)
            f.write(json.dumps(r) + "\n")
            new += 1
    return new


def followup_no_auto(run_dir, rec, text, model, reflector, tag):
    """loop_corrections.followup with capture on and auto-reflect OFF (the harness reflects with --pending)."""
    name = f"{tag}{rec['task']}.followup.{os.path.basename(rec['workdir']).split('.')[-1]}.{int(time.time())}"
    logdir = os.path.join(run_dir, "logs")
    ev_path = os.path.join(logdir, name + ".events.jsonl")
    env = C.user_env(run_dir, "a")
    env.update(ALTIMATE_LEARN_CAPTURE="1")
    cmd = shlex.split(C.ALTIMATE_CMD) + ["run", "--format", "json", "-m", model, "--max-turns", str(C.MAX_TURNS),
                                         "--yolo", "--session", rec["session_id"], text.lstrip("-").strip()]
    timed_out = False
    for attempt in range(4):
        with open(ev_path, "w") as so, open(os.path.join(logdir, name + ".stderr.txt"), "w") as se:
            with C._spawn_lock:
                proc = subprocess.Popen(cmd, cwd=rec["workdir"], env=env, stdout=so, stderr=se,
                                        stdin=subprocess.DEVNULL, start_new_session=True)
                time.sleep(C.STAGGER_SECONDS)
            try:
                proc.wait(timeout=C.AGENT_TIMEOUT)
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
        err = open(os.path.join(logdir, name + ".stderr.txt"), errors="replace").read()
        if not timed_out and proc.returncode != 0 and os.path.getsize(ev_path) < 200 and "database is locked" in err:
            time.sleep(3 + 3 * attempt)
            continue
        break
    ev = C.parse_events(ev_path)
    return {"rc": proc.returncode, "timed_out": timed_out, "cost": round(ev["cost"], 5), "tool_calls": ev["tool_calls"],
            "same_session": ev["session_id"] == rec["session_id"], "events": os.path.relpath(ev_path, run_dir),
            "stderr_tail": err[-300:] if proc.returncode else ""}


LC.followup = followup_no_auto  # train_session resolves followup() in its module globals


def learn(run_dir, maint, args, timeout=900):
    return C.altimate(["learn"] + args, maint, C.user_env(run_dir, "a"), timeout=timeout)


def json_out(text):
    try:
        i = min(x for x in (text.find("{"), text.find("[")) if x >= 0)
        return json.loads(text[i:])
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--iterations", type=int, default=2)
    ap.add_argument("--train-limit", type=int)
    ap.add_argument("--parallel", type=int, default=4)
    ap.add_argument("--run-dir")
    ap.add_argument("--run-id")
    ap.add_argument("--label", help="eval label prefix (default: run dir name)")
    ap.add_argument("--model", default=C.AGENT_MODEL)
    ap.add_argument("--reflector-model", default=C.REFLECTOR_MODEL)
    ap.add_argument("--seed", default=SEED, help="outdated lessons (.md playbook, .jsonl or approved .json)")
    ap.add_argument("--runs", type=int, default=3, help="final eval runs per task")
    ap.add_argument("--skip-eval", action="store_true")
    a = ap.parse_args()
    lib.preflight()
    run_dir = C.run_dir_for(a.run_dir, a.run_id)
    label = a.label or os.path.basename(run_dir.rstrip("/"))
    log = os.path.join(run_dir, "loop.jsonl")
    eval_only = os.path.join(run_dir, "eval_only.jsonl")
    pb_dir = os.path.join(run_dir, "playbooks")
    os.makedirs(pb_dir, exist_ok=True)
    train = C.select_tasks(["train"], a.train_limit)
    C.setup_users(run_dir, None)
    C.warm_users(run_dir)
    T.setup_reviewer(run_dir)
    model, reflector = C.resolve_models(run_dir, a.model, a.reflector_model)
    maint = maintainer(run_dir)
    seed = lib.load_lessons(a.seed)
    if not lib.read_approved(maint):
        lib.install_lessons(maint, seed)
    seed_ids = [l["id"] for l in seed]
    C.append_jsonl(log, {"type": "seed", "source": a.seed, "ids": seed_ids, "reflector": reflector, "agent": model,
                         "train": [t["id"] for t in train]})
    C.log(f"drift: run dir {run_dir}; seed {len(seed)} lessons; reflector {reflector}")
    learn_dir = lib.learn_dir(maint)

    for it in range(1, a.iterations + 1):
        approved = lib.read_approved(maint)
        token = lib.lessons_token(approved)
        C.log(f"=== iteration {it}: {len(approved)} approved lessons")
        with ThreadPoolExecutor(max_workers=max(1, a.parallel)) as ex:
            sessions = list(ex.map(lambda t: LC.train_session(run_dir, t, token, model, reflector, it, eval_only), train))
        frags = LC.verifier_fragments([v for s in sessions for v in (s.get("_verify_first"), s.get("_verify_post"))])
        for s in sessions:
            s.pop("_verify_first", None)
            s.pop("_verify_post", None)
        texts = [(f"review:{s['task']}", r["text"]) for s in sessions for r in s["reviews"]]
        guard = [signals_path(s["workdir"]) for s in sessions] + [signals_path(maint), os.path.join(learn_dir, "history.jsonl"),
                                                                  os.path.join(learn_dir, "candidate.json")]
        LC.assert_no_verifier_text(guard, texts, frags, f"iter {it} pre-reflect")
        n = len(sessions)
        corr = sum(s["rounds"] for s in sessions)
        for s in sessions:
            C.append_jsonl(log, dict(s, type="session", phase="train"))
        C.append_jsonl(log, {"type": "online_metric", "iter": it, "sessions": n, "corrections": corr,
                             "corrections_per_session": round(corr / n, 3) if n else None,
                             "lgtm_first": sum(1 for s in sessions if s.get("lgtm_first")),
                             "with_user_correction_signal": sum(1 for s in sessions
                                                                if (s.get("captured") or {}).get("user_correction")),
                             "approved_ids": [l["id"] for l in approved]})
        C.log(f"online metric it{it}: {corr} corrections over {n} sessions; "
              f"first-attempt LGTM {sum(1 for s in sessions if s.get('lgtm_first'))}/{n}")

        copied = sum(copy_signals(s["workdir"], maint) for s in sessions if s.get("session_id"))
        if not copied:
            C.append_jsonl(log, {"type": "reflect", "iter": it, "skipped": "no signals"})
            continue
        t0 = time.time()
        p = learn(run_dir, maint, ["reflect", "--pending", "--name", C.PLAYBOOK_NAME, "-m", reflector, "--json"])
        res = {"type": "reflect", "iter": it, "signals_copied": copied, "rc": p.returncode,
               "wall_s": round(time.time() - t0, 1), "result": json_out(p.stdout), "stderr_tail": p.stderr[-400:]}
        C.append_jsonl(log, res)
        C.log(f"reflect it{it}: rc={p.returncode} {res['wall_s']}s")
        LC.assert_no_verifier_text([signals_path(maint), os.path.join(learn_dir, "history.jsonl"),
                                    os.path.join(learn_dir, "candidate.json")], [], frags, f"iter {it} post-reflect")

        cand_p = os.path.join(learn_dir, "candidate.json")
        cand = lib.read_json_array(cand_p) if os.path.isfile(cand_p) else None
        if cand is None or cand == approved:
            C.append_jsonl(log, {"type": "gate", "iter": it, "decision": "skip",
                                 "reason": "no candidate staged or candidate equals approved"})
            continue
        shutil.copyfile(cand_p, os.path.join(pb_dir, f"iter{it}-candidate.json"))
        pr = learn(run_dir, maint, ["promote", "--yes", "--name", C.PLAYBOOK_NAME])
        if pr.returncode == 0:
            action = "promote"
        else:
            action = f"promote failed: {(pr.stdout + pr.stderr)[-300:]}"
            learn(run_dir, maint, ["reject", "--name", C.PLAYBOOK_NAME])
        after = lib.read_approved(maint)
        shutil.copyfile(os.path.join(learn_dir, "approved.json"), os.path.join(pb_dir, f"iter{it}-approved.json"))
        C.append_jsonl(log, {"type": "gate", "iter": it, "decision": action, "n_before": len(approved), "n_after": len(after),
                             "stale_remaining": [i for i in seed_ids if i in {l["id"] for l in after}],
                             "added": [l for l in after if l["id"] not in {x["id"] for x in approved}]})
        C.log(f"GATE it{it}: {action}; stale remaining {[i for i in seed_ids if i in {l['id'] for l in after}]}")

    final = os.path.join(pb_dir, "final-approved.json")
    json.dump(lib.read_approved(maint), open(final, "w"), indent=2)
    for f in ("retired.json", "history.jsonl"):
        if os.path.isfile(os.path.join(learn_dir, f)):
            shutil.copyfile(os.path.join(learn_dir, f), os.path.join(run_dir, f"learn-{f}"))
    C.append_jsonl(log, {"type": "final", "ids": [l["id"] for l in lib.read_approved(maint)],
                         "stale_remaining": [i for i in seed_ids if i in {l["id"] for l in lib.read_approved(maint)}],
                         "retired": [r.get("id") for r in lib.read_json_array(os.path.join(learn_dir, "retired.json"))]})
    if a.skip_eval:
        return
    os.makedirs(os.path.join(run_dir, "eval"), exist_ok=True)
    _, tripped = eval_v1.evaluate(run_dir, f"lessons:{final}", f"{label}-final", None, a.runs,
                                  os.path.join(run_dir, "eval", f"{label}-final.jsonl"), a.parallel, model)
    sys.exit(3 if tripped else 0)


if __name__ == "__main__":
    main()
