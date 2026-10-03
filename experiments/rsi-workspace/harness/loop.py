#!/usr/bin/env python3
"""loop.py --iterations K --runs-val N : the autonomous self-improvement loop.

Per iteration: run train tasks with the promoted playbook (or none), verify, `learn reflect` every train
run (successes too) with the verifier JSON as feedback, then GATE the staged candidate against the current
promoted version on the val split (per-check counts, margin, no-regression rule) -> `learn promote --yes`
or `learn reject`. After the last iteration, publish A's promoted playbook to the workspace and verify
via the backend API as B (default backend: fake; SaaS requires explicit opt-in and --workspace-id; the binding of the
demo remote is verified, never created).

Leakage guard: only split == "train" records may be turned into reflect feedback (assert in
`feedback_for_reflect`); val results are gate numbers only; heldout/control are never run here.
"""
import argparse
import json
import os
import shutil
import sys

import common as C


# ------------------------------------------------------------ learn helpers

def maintainer(run_dir, name="maint"):
    """A prepared workdir for user A where `learn` state lives (no task is run in it)."""
    C.validate_id(name, "maintainer name")
    path = os.path.join(run_dir, "work", name)
    if not os.path.isdir(path):
        t = C.load_tasks()["train-refunds"]
        p = C.subprocess.run([a.replace("{workdir}", path) for a in t["setup"]], cwd=C.DEMO, capture_output=True,
                             text=True, env=dict(os.environ, DBT_BIN=C.DBT_BIN))
        if p.returncode:
            sys.exit("maintainer setup failed: " + p.stdout + p.stderr)
    return path


def learn_paths(maint, name=C.PLAYBOOK_NAME):
    C.validate_id(name, "lesson store")
    store = os.path.join(maint, ".altimate-code", "learn", name)
    return os.path.join(store, "approved.json"), os.path.join(store, "candidate.json")


def read(p):
    if not os.path.isfile(p):
        return None
    if p.endswith(".json"):
        lessons = json.load(open(p))
        if not isinstance(lessons, list):
            raise ValueError(f"expected lesson array: {p}")
        return C.wrap_skill("\n".join(f"- [{l['id']}] {l['text']}" for l in lessons)) if lessons else None
    return open(p).read()


def export_approved(maint):
    """Promotion updates approved.json; explicitly export it for local skill/publish arms."""
    current = read(learn_paths(maint)[0])
    if current:
        C.install_playbook(maint, current)
    return current


def learn(run_dir, maint, args, workspace=False, timeout=600):
    return C.altimate(["learn"] + args, maint, C.user_env(run_dir, "a", workspace=workspace), timeout=timeout)


def feedback_for_reflect(rec):
    """Leakage guard: the ONLY way feedback text is produced for `learn reflect`."""
    assert rec["split"] == "train", f"LEAKAGE: refusing to use {rec['split']} feedback ({rec['task']}) for reflect"
    return (f"Task given to the agent: {C.load_tasks()[rec['task']]['prompt']}\n"
            f"Hidden CI result (verifier JSON):\n{json.dumps(rec.get('verify') or {'error': rec.get('error', 'run incomplete')}, indent=2)}\n")


def reflect(run_dir, maint, rec, reflector_model, feedback_text, tag):
    fb = os.path.join(run_dir, "feedback", f"{tag}-{rec['task']}.txt")
    os.makedirs(os.path.dirname(fb), exist_ok=True)
    open(fb, "w").write(feedback_text)
    # `--session` resolves sessions from the maintainer checkout (looked up by id in user A's data dir, whatever
    # the cwd), so no --trajectory export is needed. (`trajectory export` is not registered in this build.)
    if not rec.get("session_id") or not rec.get("completed", False):
        return {"ok": False, "skipped": True, "error": "run did not complete"}
    p = learn(run_dir, maint, ["reflect", "--session", rec["session_id"], "--feedback", fb, "--feedback-kind", "verifier",
                               "--name", C.PLAYBOOK_NAME, "--model", reflector_model, "--json"])
    out = {"ok": p.returncode == 0, "rc": p.returncode}
    try:
        out["result"] = json.loads(p.stdout[p.stdout.index("{"):])
    except Exception:
        out["raw"] = (p.stdout + p.stderr)[-600:]
    return out


# ------------------------------------------------------------ gate

def per_check_counts(recs):
    """{task: {check: passes}} and {task: n_runs}"""
    counts, n = {}, {}
    for r in recs:
        n[r["task"]] = n.get(r["task"], 0) + 1
        for c, ok in r.get("checks", {}).items():
            counts.setdefault(r["task"], {}).setdefault(c, 0)
            counts[r["task"]][c] += 1 if ok else 0
    return counts, n


def gate(cand_recs, cur_recs, margin):
    """Promote iff candidate total checks >= current + margin AND no val task regresses.

    A task regresses when its total passed checks drop, or when a check the current version passed on
    every run is passed on no candidate run (a full reversal). A single-run dip on one check is noise at
    these run counts: the first saas run rejected a +16-check candidate over one 2/2 -> 1/2 dip."""
    cc, cn = per_check_counts(cand_recs)
    uc, un = per_check_counts(cur_recs)
    cand_total = sum(sum(v.values()) for v in cc.values())
    cur_total = sum(sum(v.values()) for v in uc.values())
    losses = []
    for task, checks in uc.items():
        cand_task = cc.get(task, {})
        if sum(cand_task.values()) < sum(checks.values()):
            losses.append({"task": task, "check": "*", "current": sum(checks.values()), "candidate": sum(cand_task.values())})
        for chk, k in checks.items():
            if k == un[task] and cand_task.get(chk, 0) == 0:
                losses.append({"task": task, "check": chk, "current": f"{k}/{un[task]}",
                               "candidate": f"0/{cn.get(task, 0)}"})
    comparable = bool(cand_recs and cur_recs) and cn == un and all(
        r.get("completed", False) and r.get("checks") and not r.get("error") for r in cand_recs + cur_recs)
    promote = comparable and cand_total >= cur_total + margin and not losses
    return {"promote": promote, "cand_total": cand_total, "cur_total": cur_total, "margin": margin,
            "cand_pass": sum(r.get("pass", False) for r in cand_recs), "cur_pass": sum(r.get("pass", False) for r in cur_recs),
            "n_cand": len(cand_recs), "n_cur": len(cur_recs), "losses": losses,
            "cand_by_task": cc, "cur_by_task": uc}


# ------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--iterations", type=int, default=2)
    ap.add_argument("--runs-val", type=int, default=2)
    ap.add_argument("--train-limit", type=int)
    ap.add_argument("--val-limit", type=int)
    ap.add_argument("--margin", type=int, default=2)
    ap.add_argument("--parallel", type=int, default=4)
    ap.add_argument("--run-dir")
    ap.add_argument("--run-id")
    ap.add_argument("--model", default=C.AGENT_MODEL)
    ap.add_argument("--reflector-model", default=C.REFLECTOR_MODEL)
    ap.add_argument("--no-publish", action="store_true")
    ap.add_argument("--backend", choices=["saas", "fake"], default="fake")
    ap.add_argument("--workspace-id", type=int, help="saas: id of the pre-created workspace bound to the demo remote")
    a = ap.parse_args()
    C.require_learn()
    C.require_dbt()
    if a.runs_val < 1:
        ap.error("--runs-val must be positive")

    run_dir = C.run_dir_for(a.run_dir, a.run_id)
    loop_log = os.path.join(run_dir, "loop.jsonl")
    pb_dir = os.path.join(run_dir, "playbooks")
    os.makedirs(pb_dir, exist_ok=True)
    train = C.select_tasks(["train"], a.train_limit)
    val = C.select_tasks(["val"], a.val_limit)
    C.log(f"run dir {run_dir}; train={[t['id'] for t in train]} val={[t['id'] for t in val]}")

    with C.Backend(run_dir, a.backend, a.workspace_id) as be:
        C.warm_users(run_dir)
        pre = be.published_skill("b")
        if pre.get("found"):
            C.log(f"WARNING: workspace already holds a '{C.PLAYBOOK_NAME}' skill (sha {pre['sha']}) from an earlier run")
        C.append_jsonl(loop_log, {"type": "backend", "mode": be.mode, "workspace_id": be.workspace_id,
                                  "binding": be.binding("a"), "preexisting_skill_sha": pre.get("sha")})
        model, reflector = C.resolve_models(run_dir, a.model, a.reflector_model)
        maint = maintainer(run_dir)
        promoted_p, cand_p = learn_paths(maint)
        cache = {}  # sha(current) -> val records (reused while the promoted version is unchanged)
        promoted_any = False

        def rec_log(phase, it):
            def f(r):
                r2 = dict(r, phase=phase, iter=it)
                r2.pop("verify", None) if phase.startswith("gate") else None
                C.append_jsonl(loop_log, r2)
            return f

        for it in range(1, a.iterations + 1):
            current = read(promoted_p)
            C.log(f"=== iteration {it}: current={'v' + C.sha(current) if current else 'none'}")
            # a. train runs with the current promoted playbook (candidates are always resolved at the gate)
            specs = [{"run_dir": run_dir, "task": t, "arm": "train", "user": "a", "run_idx": 0, "playbook": current,
                      "workspace": False, "model": model, "tag": f"i{it}-"} for t in train]
            train_recs = C.run_many(specs, a.parallel, on_done=rec_log("train", it))
            # b. reflect on every train run (successes too: HELPFUL counters need them)
            reflection_failed = False
            for r in train_recs:
                fb = feedback_for_reflect(r)  # asserts split == train
                res = reflect(run_dir, maint, r, reflector, fb, f"i{it}")
                C.append_jsonl(loop_log, {"type": "reflect", "iter": it, "task": r["task"], "split": r["split"],
                                          "train_pass": r["pass"], "train_checks": r["checks"], **res})
                s = (res.get("result") or {}).get("summary") or res.get("raw") or res.get("error")
                C.log(f"reflect {r['task']}: {s}")
                reflection_failed |= not res.get("ok") and not res.get("skipped")
            if reflection_failed:
                raise SystemExit("reflection failed; refusing to gate partial candidates")
            candidate = read(cand_p)
            if candidate is None or candidate == current:
                C.append_jsonl(loop_log, {"type": "gate", "iter": it, "decision": "skip", "reason": "no candidate staged"})
                C.log("no candidate staged; nothing to gate")
                continue
            open(os.path.join(pb_dir, f"iter{it}-candidate.md"), "w").write(candidate)
            # c. gate on val: candidate vs current, N runs each (paired by run index; the CLI has no seed flag)
            def vspecs(arm, text):
                return [{"run_dir": run_dir, "task": t, "arm": arm, "user": "a", "run_idx": i, "playbook": text,
                         "workspace": False, "model": model, "tag": f"i{it}-"} for i in range(a.runs_val) for t in val]
            key = C.sha(current)
            reused = key in cache
            # one pool, candidate/current interleaved so each pair runs side by side
            cs = vspecs("val-candidate", candidate)
            us = [] if reused else vspecs("val-current", current)
            both = [s for pair in zip(cs, us) for s in pair] + (cs[len(us):] if us else cs)
            res_all = C.run_many(both, a.parallel, on_done=lambda r: rec_log(
                "gate-candidate" if r["arm"] == "val-candidate" else "gate-current", it)(r))
            cand_recs = [r for r in res_all if r["arm"] == "val-candidate"]
            if not reused:
                cache[key] = [r for r in res_all if r["arm"] == "val-current"]
            cur_recs = cache[key]
            g = gate(cand_recs, cur_recs, a.margin)
            for r in cand_recs + cur_recs:  # val verifier output never reaches reflect
                assert r["split"] == "val"
            if g["promote"]:
                p = learn(run_dir, maint, ["promote", "--yes", "--name", C.PLAYBOOK_NAME])
                g["action"] = "promote" if p.returncode == 0 else f"promote-failed: {(p.stdout + p.stderr)[-300:]}"
                promoted_any = promoted_any or p.returncode == 0
                if p.returncode == 0:
                    open(os.path.join(pb_dir, f"iter{it}-promoted.md"), "w").write(export_approved(maint))
            else:
                p = learn(run_dir, maint, ["reject", "--name", C.PLAYBOOK_NAME])
                g["action"] = "reject" if p.returncode == 0 else f"reject-failed: {(p.stdout + p.stderr)[-300:]}"
            C.append_jsonl(loop_log, {"type": "gate", "iter": it, "current_sha": key if current else None,
                                      "candidate_sha": C.sha(candidate), "current_reused": reused,
                                      "val_runs": a.runs_val, "val_tasks": [t["id"] for t in val], **g})
            C.log(f"GATE it{it}: candidate checks {g['cand_total']} vs current {g['cur_total']} (+{a.margin} needed), "
                  f"losses={len(g['losses'])} -> {g['action']}")
            if p.returncode:
                raise SystemExit(g["action"])

        final = export_approved(maint)
        if final:
            open(os.path.join(pb_dir, "final.md"), "w").write(final)
        # learn history for the report
        hist = os.path.join(maint, ".altimate-code", "learn")
        if os.path.isdir(hist):
            shutil.copytree(hist, os.path.join(run_dir, "learn-history"), dirs_exist_ok=True)

        # 4. publish as A with the workspace flag; verify through the backend API as B (what a teammate sees)
        if final and not a.no_publish:
            from loop_corrections import publish_command
            p = publish_command(run_dir, be, maint)
            pub = {"type": "publish", "backend": be.mode, "workspace_id": be.workspace_id, "rc": p.returncode,
                   "output": (p.stdout + p.stderr)[-400:], "local_promoted_sha": C.sha(final.strip() + "\n")}
            seen = {}
            for u in ("a", "b"):
                sk = be.published_skill(u)
                sk.pop("content", None) if u == "a" else None
                seen[u] = sk
            sk_b = seen["b"]
            pub["as_b"] = {k: v for k, v in sk_b.items() if k != "content"}
            pub["as_a"] = {k: v for k, v in seen["a"].items() if k != "content"}
            # Found via GET /skills?datamate_id=<ws> (the sync's own query) means attached. The real SaaS honours the
            # filter (verified: workspace 17 lists only this skill) but exposes no attached-ids field on the record.
            pub["attached_to_workspace"] = bool(sk_b.get("found")) and (
                sk_b.get("attached_datamate_ids") is None or be.workspace_id in sk_b["attached_datamate_ids"])
            pub["backend_content_matches_promoted"] = sk_b.get("found") and (sk_b.get("content") or "").strip() == final.strip()
            pub["backend_sha"] = sk_b.get("sha")
            C.append_jsonl(loop_log, pub)
            C.log(f"publish rc={p.returncode} B sees skill={sk_b.get('found')} attached={pub['attached_to_workspace']} "
                  f"content-matches={pub['backend_content_matches_promoted']} sha={sk_b.get('sha')}")
            if p.returncode or not (pub["attached_to_workspace"] and pub["backend_content_matches_promoted"]):
                sys.exit("publish verification FAILED: " + json.dumps(pub))
        elif not final:
            C.log("nothing promoted; nothing to publish")
    C.log("loop done")


if __name__ == "__main__":
    main()
