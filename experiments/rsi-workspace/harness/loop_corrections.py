#!/usr/bin/env python3
"""loop_corrections.py --iterations K : corrections-only learning loop (no CI, no verifier in training).

Per iteration and train task (parallel across tasks):
  1. the agent works with the current promoted playbook installed, ALTIMATE_LEARN_CAPTURE=1
  2. the simulated teammate (teammate.py) reviews the workdir and types a chat message (or LGTM)
  3. if not LGTM, the message is sent as a follow-up in the SAME session (run --session), capture + auto-reflect on;
     at most 2 correction rounds
  4. record rounds, whether a user_correction signal was captured, and the review texts
Learning: `learn reflect --session <id>` (no --feedback) from the maintainer checkout for every session with
captured signals. Gate: maintainer approval, no verifier (promote when lint passes and the candidate differs).

Evaluation only: the agent's FIRST-attempt output is scored by the hidden verifier (eval_only.jsonl, written outside
loop.jsonl). The verifier JSON never reaches learn; `assert_no_verifier_text` scans every learn input before each
reflect. After the last iteration: detach the previous workspace skill, publish as A, verify as B.

Product interface assumed (see packages/opencode/src/cli/cmd/learn.ts, altimate/learn/signals.ts when they land):
  ALTIMATE_LEARN_CAPTURE=1  -> <project>/.altimate-code/learn/team-playbook/signals.jsonl (user_correction / tool_retry)
  ALTIMATE_LEARN_AUTO=1 + ALTIMATE_LEARN_MODEL -> `run` reflects the session's open signals at exit
  learn signals --session <id> --json ; learn reflect --session <id> [--signals-from <dir>]
"""
import argparse
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import common as C
import teammate as T
from loop import maintainer, learn_paths, read, learn, export_approved

MAX_REVIEW_ROUNDS = 2
GATE_LABEL = "maintainer approval (no verifier)"
# Verifier message fragments that must never appear in anything `learn` reads.
STATIC_FRAGMENTS = ["Team rule:", "reconciliation", "finance calendar", "should not reach analytics",
                    "values do not equal", "not timezone-normalized", "returned columns"]


# ------------------------------------------------------------ signals

def signals_file(root):
    return os.path.join(root, ".altimate-code", "learn", C.PLAYBOOK_NAME, "signals.jsonl")


def sig_kind(s):
    return str(s.get("type") or s.get("kind") or s.get("signal") or "")


def captured_signals(run_dir, workdir, sid):
    """What the product captured for this session: `learn signals --json`, falling back to the file."""
    out = {"source": "none", "n": 0, "user_correction": 0, "tool_retry": 0, "cli_ok": False}
    sigs = None
    p = C.altimate(["learn", "signals", "--session", sid, "--all", "--json"], workdir, C.user_env(run_dir, "a"), timeout=120)
    if p.returncode == 0:
        try:
            start = min(i for i in (p.stdout.find("{"), p.stdout.find("[")) if i >= 0)
            d = json.loads(p.stdout[start:])
            sigs = d if isinstance(d, list) else (d.get("signals") or d.get("items") or [])
            out["cli_ok"], out["source"] = True, "cli"
        except Exception:
            sigs = None
    if sigs is None:
        sigs = C.read_jsonl(signals_file(workdir))
        out["source"] = "file" if sigs else "none"
    # The CLI query is session-filtered; each fallback workdir holds one session.
    sigs = [s for s in sigs if isinstance(s, dict)]
    out["n"] = len(sigs)
    out["user_correction"] = sum(1 for s in sigs if sig_kind(s) == "user_correction")
    out["tool_retry"] = sum(1 for s in sigs if sig_kind(s) == "tool_retry")
    return out


_caps = {}


def product_caps(run_dir, maint):
    """Probe once what the installed product supports."""
    if not _caps:
        env = C.user_env(run_dir, "a")
        h = C.altimate(["learn", "reflect", "--help"], maint, env, timeout=120)
        _caps["signals_from"] = "--signals-from" in (h.stdout + h.stderr)
        s = C.altimate(["learn", "signals", "--help"], maint, env, timeout=120)
        _caps["signals_cmd"] = s.returncode == 0 and "signals" in (s.stdout + s.stderr)
    return _caps


def copy_signals(workdir, maint):
    """Product gap: signals are per project dir, a maintainer cannot pull a teammate's signals. Append this
    workdir's records (each workdir holds exactly one session) to the maintainer checkout's signals file."""
    src, dst = signals_file(workdir), signals_file(maint)
    recs = [r for r in C.read_jsonl(src) if isinstance(r, dict)]
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    have = {r.get("id") for r in C.read_jsonl(dst)}
    new = 0
    with open(dst, "a") as f:
        for r in recs:
            if r.get("id") in have:
                continue
            # ALTIMATE_LEARN_AUTO already consumed these in the workdir; they are open for the maintainer
            r["status"] = "open"
            r.pop("consumedBy", None)
            f.write(json.dumps(r) + "\n")
            have.add(r.get("id"))
            new += 1
    return new


# ------------------------------------------------------------ verifier-text assertion

def verifier_fragments(verify_jsons):
    frags = list(STATIC_FRAGMENTS)
    for v in verify_jsons:
        for c in (v or {}).get("checks", []):
            if not c.get("ok") and len(c.get("message", "")) >= 30:
                frags.append(c["message"])
    return frags


def assert_no_verifier_text(paths, texts, fragments, where):
    """Hard guard: no verifier message fragment in any file or text `learn` can read."""
    hay = [(p, open(p, errors="replace").read()) for p in paths if os.path.isfile(p)] + list(texts)
    for name, body in hay:
        low = body.lower()
        for f in fragments:
            if f.lower() in low:
                raise SystemExit(f"LEAKAGE ({where}): verifier text {f!r} found in learn input {name}")


# ------------------------------------------------------------ one train session

def followup(run_dir, rec, text, model, reflector, tag):
    """`run --session <sid> "<review>"` in the same workdir, capture + auto-reflect on."""
    name = f"{tag}{rec['task']}.followup.{os.path.basename(rec['workdir']).split('.')[-1]}.{int(time.time())}"
    logdir = os.path.join(run_dir, "logs")
    ev_path = os.path.join(logdir, name + ".events.jsonl")
    env = C.user_env(run_dir, "a")
    env.update(ALTIMATE_LEARN_CAPTURE="1", ALTIMATE_LEARN_AUTO="1", ALTIMATE_LEARN_MODEL=reflector)
    cmd = shlex.split(C.ALTIMATE_CMD) + ["run", "--format", "json", "-m", model, "--max-turns", str(C.MAX_TURNS),
                                         "--yolo", "--session", rec["session_id"], C.completion_prompt(text.lstrip("-").strip())]
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
    return {"rc": proc.returncode, "timed_out": timed_out, "completed": C.agent_completed(ev, proc.returncode, timed_out),
            "cost": round(ev["cost"], 5), "tool_calls": ev["tool_calls"],
            "same_session": ev["session_id"] == rec["session_id"], "events": os.path.relpath(ev_path, run_dir),
            "stderr_tail": err[-300:] if proc.returncode else ""}


def train_session(run_dir, task, current, model, reflector, it, eval_only_log):
    tag = f"i{it}-"
    spec = {"run_dir": run_dir, "task": task, "arm": "train", "user": "a", "run_idx": 0, "playbook": current,
            "workspace": False, "model": model, "tag": tag, "env_extra": {"ALTIMATE_LEARN_CAPTURE": "1"}}
    first = C.run_task(spec)
    # EVALUATION ONLY: the first-attempt verifier result. It is written to eval_only.jsonl and nowhere else.
    C.append_jsonl(eval_only_log, {"iter": it, "stage": "first_attempt", "task": task["id"], "pass": first.get("pass"),
                                   "score": first.get("score"), "checks": first.get("checks"),
                                   "verify": first.get("verify"), "session_id": first.get("session_id")})
    s = {"task": task["id"], "split": task["split"], "iter": it, "session_id": first.get("session_id"),
         "workdir": first["workdir"], "playbook_sha": first.get("playbook_sha"), "agent_cost": first.get("cost", 0.0),
         "rounds": 0, "reviews": [], "lgtm_first": None, "followups": [], "review_cost": 0.0, "error": first.get("error")}
    s["_verify_first"] = first.get("verify")  # in-memory only, for the leakage assertion; stripped before logging
    if not first.get("session_id") or not first.get("completed"):
        s["error"] = s["error"] or "first turn incomplete"
        return s
    for round_no in range(1, MAX_REVIEW_ROUNDS + 1):
        rv = T.review(run_dir, s["workdir"], task, tag=f"{tag}r{round_no}-")
        s["review_cost"] += rv["cost"]
        s["reviews"].append({"round": round_no, "text": rv["text"], "lgtm": rv["lgtm"], "error": rv["error"]})
        if s["lgtm_first"] is None:
            s["lgtm_first"] = rv["lgtm"]
        C.log(f"{task['id']:22} review {round_no}: {'LGTM' if rv['lgtm'] else rv['text'][:110]!r}")
        if rv["error"]:
            s["error"] = rv["error"]
            break
        if rv["lgtm"] or not rv["text"]:
            break
        fu = followup(run_dir, first, rv["text"], model, reflector, tag)
        s["followups"].append(fu)
        s["rounds"] += 1
        if not fu["completed"] or not fu["same_session"]:
            s["error"] = "correction turn incomplete or did not resume session"
            break
    s["agent_cost"] += sum(f["cost"] for f in s["followups"])
    cap = captured_signals(run_dir, s["workdir"], s["session_id"])
    s["captured"] = cap
    if s["rounds"]:
        post = C.run_verify(task, s["workdir"])  # EVALUATION ONLY: does the correction help the outcome?
        C.append_jsonl(eval_only_log, {"iter": it, "stage": "post_correction", "task": task["id"],
                                       "pass": not s["error"] and bool(post.get("pass")), "score": post.get("score") if not s["error"] else 0,
                                       "checks": {C.check_id(c["name"]): not s["error"] and bool(c["ok"]) for c in post.get("checks", [])},
                                       "verify": post, "session_id": s["session_id"]})
        s["_verify_post"] = post
    return s


# ------------------------------------------------------------ learning

def reflect_session(run_dir, maint, s, reflector, caps):
    args = ["reflect", "--session", s["session_id"], "--name", C.PLAYBOOK_NAME, "--model", reflector, "--json"]
    copied = None
    if caps["signals_from"]:
        args += ["--signals-from", s["workdir"]]
    else:
        copied = copy_signals(s["workdir"], maint)
    p = learn(run_dir, maint, args)
    out = {"ok": p.returncode == 0, "rc": p.returncode, "signals_copied": copied, "signals_from_flag": caps["signals_from"]}
    try:
        out["result"] = json.loads(p.stdout[p.stdout.index("{"):])
    except Exception:
        out["raw"] = (p.stdout + p.stderr)[-600:]
    return out


# ------------------------------------------------------------ publish (A) + verify (B)

def api_write(be, user, method, path, body):
    url, tenant, key = be._creds(user)
    req = urllib.request.Request(url + path, data=json.dumps(body).encode(), method=method,
                                 headers={"Authorization": f"Bearer {key}", "x-tenant": tenant,
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read().decode()
    return json.loads(raw) if raw.strip() else {}


def find_skill_by_name(be, user, name, prefer_id=None):
    """Existing skill of that name visible to `user` (all pages)."""
    uid = be.api(user, "/users/me")["id"]
    hits, page = [], 1
    while page <= 20:
        r = be.api(user, "/skills", {"page": page, "size": 50})
        hits += [s for s in r.get("items", []) if s.get("name") == name and s.get("created_by") == uid]
        if page >= (r.get("pages") or 1):
            break
        page += 1
    return next((s for s in hits if s.get("public_id") == prefer_id), hits[0] if hits else None)


def seed_ledger(run_dir, be, maint, public_id):
    """Product gap workaround: write the publish ledger so `skill publish` PATCHes the existing skill."""
    detail = be.api("a", f"/skills/{public_id}")
    created_by = (detail.get("skill") or detail).get("created_by")
    if created_by != be.api("a", "/users/me")["id"]:
        raise ValueError("cannot adopt another user's published skill")
    url, tenant, _ = be._creds("a")
    skill_dir = os.path.realpath(os.path.dirname(C.skill_path(maint)))
    ledger = os.path.join(run_dir, "home-a", ".local", "state", "altimate-code", "altimate-published-skills.json")
    os.makedirs(os.path.dirname(ledger), exist_ok=True)
    key = f"{tenant}|{url}|u{created_by}|{skill_dir}"
    rows = json.load(open(ledger)) if os.path.isfile(ledger) else {}
    rows[key] = {"publicId": public_id, "tenant": tenant, "apiUrl": url, "createdBy": created_by}
    json.dump(rows, open(ledger, "w"))
    return created_by


def publish_command(run_dir, be, maint, previous_id=None):
    """Use supported publish/update; adopt only a same-name skill owned by A on conflict."""
    env = C.user_env(run_dir, "a", workspace=True)
    p = C.altimate(["skill", "publish", C.PLAYBOOK_NAME], maint, env)
    out = p.stdout + p.stderr
    if p.returncode and re.search(r"409|already exists|another|conflict", out, re.I):
        # republishing a name this creator already owns from a fresh HOME: no ledger id -> POST -> 409
        existing = find_skill_by_name(be, "a", C.PLAYBOOK_NAME, previous_id)
        if existing:
            seed_ledger(run_dir, be, maint, existing["public_id"])
            p = C.altimate(["skill", "publish", C.PLAYBOOK_NAME], maint, env)
    return p


def publish(run_dir, be, maint, final, previous_id, log_path):
    rec = {"type": "publish", "backend": be.mode, "workspace_id": be.workspace_id, "previous_skill_id": previous_id}
    p = publish_command(run_dir, be, maint, previous_id)
    out = p.stdout + p.stderr
    rec.update(rc=p.returncode, output=out[-400:], local_promoted_sha=C.sha(final.strip() + "\n"))
    sk = be.published_skill("b")
    rec["as_b"] = {k: v for k, v in sk.items() if k != "content"}
    rec["attached_to_workspace"] = bool(sk.get("found"))
    rec["backend_content_matches_promoted"] = bool(sk.get("found")) and (sk.get("content") or "").strip() == final.strip()
    rec["backend_sha"] = sk.get("sha")
    C.append_jsonl(log_path, rec)
    C.log(f"publish rc={p.returncode} B sees={sk.get('found')} content-matches={rec['backend_content_matches_promoted']} "
          f"sha={sk.get('sha')}")
    if p.returncode or not (rec["attached_to_workspace"] and rec["backend_content_matches_promoted"]):
        sys.exit("publish verification FAILED: " + json.dumps(rec))


# ------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--iterations", type=int, default=2)
    ap.add_argument("--train-limit", type=int)
    ap.add_argument("--parallel", type=int, default=4)
    ap.add_argument("--run-dir")
    ap.add_argument("--run-id")
    ap.add_argument("--model", default=C.AGENT_MODEL)
    ap.add_argument("--reflector-model", default=C.REFLECTOR_MODEL)
    ap.add_argument("--no-publish", action="store_true")
    ap.add_argument("--seed-playbook", help="start from this promoted playbook (e.g. outdated conventions)")
    ap.add_argument("--previous-skill-id", help="prefer this owned skill when adopting a same-name published skill")
    ap.add_argument("--backend", choices=["saas", "fake"], default="fake")
    ap.add_argument("--workspace-id", type=int)
    a = ap.parse_args()
    C.require_learn()
    C.require_dbt()

    run_dir = C.run_dir_for(a.run_dir, a.run_id)
    loop_log = os.path.join(run_dir, "loop.jsonl")
    eval_only_log = os.path.join(run_dir, "eval_only.jsonl")
    pb_dir = os.path.join(run_dir, "playbooks")
    os.makedirs(pb_dir, exist_ok=True)
    train = C.select_tasks(["train"], a.train_limit)
    C.log(f"run dir {run_dir}; corrections-only; train={[t['id'] for t in train]}")

    with C.Backend(run_dir, a.backend, a.workspace_id) as be:
        C.warm_users(run_dir)
        T.setup_reviewer(run_dir)
        C.append_jsonl(loop_log, {"type": "backend", "mode": be.mode, "workspace_id": be.workspace_id,
                                  "binding": be.binding("a"), "preexisting_skill_sha": be.published_skill("b").get("sha"),
                                  "mode_name": "corrections-only"})
        model, reflector = C.resolve_models(run_dir, a.model, a.reflector_model)
        maint = maintainer(run_dir)
        promoted_p, cand_p = learn_paths(maint)
        if a.seed_playbook and not os.path.isfile(promoted_p):
            os.makedirs(os.path.dirname(promoted_p), exist_ok=True)
            rows = []
            for line in open(a.seed_playbook):
                match = re.match(r"^- \[(L-[0-9a-f]+)\] (.*?)(?:\s*<!--.*?-->)?\s*$", line)
                if match:
                    rows.append({"id": match[1], "text": match[2], "tags": [], "scope": "project",
                                 "helpful": 0, "harmful": 0, "applied": 0,
                                 "created": "2026-10-01T00:00:00.000Z", "updated": "2026-10-01T00:00:00.000Z"})
            if not rows:
                raise ValueError("seed playbook contains no [L-id] lesson bullets")
            json.dump(rows, open(promoted_p, "w"), indent=2)
            export_approved(maint)
            C.append_jsonl(loop_log, {"type": "seed_playbook", "path": a.seed_playbook, "sha": C.sha(read(promoted_p))})
        caps = product_caps(run_dir, maint)
        C.append_jsonl(loop_log, {"type": "product_caps", **caps,
                                  "note": "signals_from=False means signals are per project dir and a maintainer "
                                          "cannot pull a teammate's signals: the harness copies them (product gap)"})
        C.log(f"product caps: {caps}")

        for it in range(1, a.iterations + 1):
            current = read(promoted_p)
            C.log(f"=== iteration {it}: current={'v' + C.sha(current) if current else 'none'}")
            with ThreadPoolExecutor(max_workers=max(1, a.parallel)) as ex:
                sessions = list(ex.map(lambda t: train_session(run_dir, t, current, model, reflector, it,
                                                               eval_only_log), train))
            frags = verifier_fragments([v for s in sessions for v in (s.get("_verify_first"), s.get("_verify_post"))])
            for s in sessions:
                s.pop("_verify_first", None)
                s.pop("_verify_post", None)
            # verifier-free guard before anything is reflected: signals, learn history, review texts, candidate
            learn_dir = os.path.join(maint, ".altimate-code", "learn")
            paths = [signals_file(s["workdir"]) for s in sessions] + [signals_file(maint),
                     os.path.join(learn_dir, C.PLAYBOOK_NAME, "history.jsonl"), cand_p]
            texts = [(f"review:{s['task']}", r["text"]) for s in sessions for r in s["reviews"]]
            assert_no_verifier_text(paths, texts, frags, f"iter {it} pre-reflect")

            n = len(sessions)
            corr = sum(s["rounds"] for s in sessions)
            for s in sessions:
                C.append_jsonl(loop_log, dict(s, type="session", phase="train"))
            C.append_jsonl(loop_log, {"type": "online_metric", "iter": it, "sessions": n, "corrections": corr,
                                      "corrections_per_session": round(corr / n, 3) if n else None,
                                      "lgtm_first": sum(1 for s in sessions if s.get("lgtm_first")),
                                      "with_user_correction_signal": sum(1 for s in sessions
                                                                         if (s.get("captured") or {}).get("user_correction")),
                                      "playbook_sha": C.sha(current) if current else None})
            C.log(f"online metric it{it}: {corr} corrections over {n} sessions "
                  f"({corr / n if n else 0:.2f}/session); first-attempt LGTM {sum(1 for s in sessions if s.get('lgtm_first'))}/{n}")

            # learning: reflect every session that has captured signals (no --feedback)
            for s in sessions:
                cap = s.get("captured") or {}
                if s.get("error") or not s.get("session_id") or not cap.get("n"):
                    C.append_jsonl(loop_log, {"type": "reflect", "iter": it, "task": s["task"], "skipped": "no signals"})
                    continue
                res = reflect_session(run_dir, maint, s, reflector, caps)
                C.append_jsonl(loop_log, {"type": "reflect", "iter": it, "task": s["task"], "split": s["split"], **res})
                sm = (res.get("result") or {}).get("summary") or res.get("raw")
                C.log(f"reflect {s['task']}: {sm}")
                if not res["ok"]:
                    raise SystemExit("reflection failed; refusing to promote partial candidates")
            assert_no_verifier_text([signals_file(maint), os.path.join(learn_dir, C.PLAYBOOK_NAME, "history.jsonl"),
                                     cand_p], [], frags, f"iter {it} post-reflect")

            # gate: simulated maintainer approval, no verifier (lint is enforced by `promote`)
            candidate = read(cand_p)
            if candidate is None or candidate == current:
                C.append_jsonl(loop_log, {"type": "gate", "iter": it, "gate": GATE_LABEL, "decision": "skip",
                                          "reason": "no candidate staged or candidate equals promoted"})
                C.log("no new candidate; nothing to promote")
                continue
            open(os.path.join(pb_dir, f"iter{it}-candidate.md"), "w").write(candidate)
            p = learn(run_dir, maint, ["promote", "--yes", "--name", C.PLAYBOOK_NAME])
            if p.returncode == 0:
                action = "promote"
                open(os.path.join(pb_dir, f"iter{it}-promoted.md"), "w").write(export_approved(maint))
            else:
                action = f"lint/promote failed: {(p.stdout + p.stderr)[-300:]}"
                rejected = learn(run_dir, maint, ["reject", "--name", C.PLAYBOOK_NAME])
                if rejected.returncode:
                    raise SystemExit("reject failed: " + (rejected.stdout + rejected.stderr)[-300:])
            C.append_jsonl(loop_log, {"type": "gate", "iter": it, "gate": GATE_LABEL, "decision": action,
                                      "current_sha": C.sha(current) if current else None,
                                      "candidate_sha": C.sha(candidate)})
            C.log(f"GATE it{it} ({GATE_LABEL}): {action}")
            if p.returncode:
                raise SystemExit(action)

        final = export_approved(maint)
        if final:
            open(os.path.join(pb_dir, "final.md"), "w").write(final)
        hist = os.path.join(maint, ".altimate-code", "learn")
        if os.path.isdir(hist):
            shutil.copytree(hist, os.path.join(run_dir, "learn-history"), dirs_exist_ok=True)
        if final and not a.no_publish:
            publish(run_dir, be, maint, final, a.previous_skill_id, loop_log)
        elif not final:
            C.log("nothing promoted; nothing to publish")
    C.log("corrections loop done")


if __name__ == "__main__":
    main()
