#!/usr/bin/env python3
"""report.py runs/<run_id> [--out report.md]

Reads <run>/eval/*.jsonl (final arms: one file per arm label), <run>/loop.jsonl (learning curve, gate
decisions), playbooks, and writes a markdown report. Raw counts first; a percentage only ever appears next
to its count, and n is stated everywhere.
"""
import argparse
import difflib
import glob
import json
import os
import re

import common as C

ARM_ORDER = ["none", "learned", "workspace-B", "gold", "nofeedback"]


def frac(k, n):
    return f"{k}/{n} ({100 * k / n:.0f}%)" if n else "0/0"


def mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def table(rows, header):
    out = ["| " + " | ".join(header) + " |", "|" + "|".join("---" for _ in header) + "|"]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def arm_split_rows(recs):
    """One row per (arm, split) over records `recs`."""
    keys = sorted({(r["arm"], r["split"]) for r in recs}, key=lambda k: (
        ARM_ORDER.index(k[0]) if k[0] in ARM_ORDER else 99, k[0], k[1]))
    rows, checks_by_split = [], {}
    for arm, split in keys:
        rs = [r for r in recs if r["arm"] == arm and r["split"] == split]
        ids = sorted({c for r in rs for c in r.get("checks", {})})
        checks_by_split[split] = sorted(set(checks_by_split.get(split, [])) | set(ids))
        per = {c: sum(1 for r in rs if r.get("checks", {}).get(c)) for c in ids}
        rows.append({
            "arm": arm, "split": split, "tasks": len({r["task"] for r in rs}), "n": len(rs),
            "pass": sum(1 for r in rs if r.get("pass")),
            "score": mean([r.get("score", 0) for r in rs]), "per": per,
            "tokens": mean([r.get("tokens", {}).get("total", 0) for r in rs]),
            "cost": mean([r.get("cost", 0) for r in rs]), "tools": mean([r.get("tool_calls", 0) for r in rs]),
            "dur": mean([r.get("duration", 0) for r in rs]), "leaks": sum(1 for r in rs if r.get("leak")),
            "timeouts": sum(1 for r in rs if r.get("timed_out")), "errors": sum(1 for r in rs if r.get("error")),
            "ws": sum(1 for r in rs if r.get("ws_arrived")), "skill": sum(1 for r in rs if r.get("playbook_in_context")),
            "has_pb": any(r.get("playbook_in_context") is not None for r in rs),
        })
    return rows, checks_by_split


def render_eval(recs):
    rows, cbs = arm_split_rows(recs)
    out = []
    for split in sorted({r["split"] for r in rows}, key=lambda s: ["heldout", "control", "val", "train"].index(s)
                        if s in ("heldout", "control", "val", "train") else 9):
        cols = cbs[split]
        hdr = ["arm", "tasks", "runs (n)", "pass k/n", "mean check score"] + [f"{c}" for c in cols] + [
            "mean tokens", "mean cost $", "mean tool calls", "mean s", "playbook seen in prompt", "leaks"]
        body = []
        for r in rows:
            if r["split"] != split:
                continue
            body.append([r["arm"], r["tasks"], r["n"], frac(r["pass"], r["n"]), f"{r['score']:.2f}"]
                        + [f"{r['per'].get(c, 0)}/{r['n']}" for c in cols]
                        + [f"{r['tokens']:.0f}", f"{r['cost']:.2f}", f"{r['tools']:.1f}",
                           f"{r['dur']:.0f}", (f"{r['skill']}/{r['n']}" if r["has_pb"] else "-"),f"{r['leaks']}/{r['n']}"])
        out.append(f"### Split: {split}\n\n" + table(body, hdr) + "\n")
        flags = [f"{r['arm']}: {r['timeouts']} timeouts, {r['errors']} errored runs" for r in rows
                 if r["split"] == split and (r["timeouts"] or r["errors"])]
        if flags:
            out.append("Failures to note: " + "; ".join(flags) + "\n")
    return "\n".join(out)


def per_task(recs):
    rows = []
    for (arm, split, task) in sorted({(r["arm"], r["split"], r["task"]) for r in recs}):
        rs = [r for r in recs if (r["arm"], r["split"], r["task"]) == (arm, split, task)]
        ids = sorted({c for r in rs for c in r.get("checks", {})})
        rows.append([task, arm, len(rs), frac(sum(1 for r in rs if r.get("pass")), len(rs)),
                     " ".join(f"{c}:{sum(1 for r in rs if r.get('checks', {}).get(c))}" for c in ids)])
    rows.sort(key=lambda r: (r[0], ARM_ORDER.index(r[1]) if r[1] in ARM_ORDER else 99))
    return table(rows, ["task", "arm", "n", "pass k/n", "per-check passes"])


def bullets(text):
    out = []
    for l in (text or "").splitlines():
        m = re.match(r"^- \[(L-[0-9a-f]+)\] (.*?) <!-- h:(\d+) x:(\d+) -->$", l)
        if m:
            out.append((m.group(1), m.group(2), int(m.group(3)), int(m.group(4))))
    return out


CONVENTIONS = [
    ("C1 location/naming `stg_<source>__<entity>`", r"stg_\w*<?\w*>?__|staging/"),
    ("C2 PK `<singular>_id`, unique + not_null in `_<source>__models.yml`", r"not_null|unique|_id\b"),
    ("C3 `cents_to_dollars`, drop `_cents`", r"cents_to_dollars"),
    ("C4 `to_utc` + `_at` suffix", r"to_utc|_at\b"),
    ("C5 soft delete `where not _is_deleted`, hide column", r"_is_deleted"),
    ("C6 verify with `dbt build --select`", r"dbt build"),
    ("Scope: not for analyses / existing models", r"analys|existing model|do not apply|don't apply|only (apply|when)"),
]


def convention_diff(learned, gold):
    rows = []
    for name, rx in CONVENTIONS:
        l = [b for b in bullets(learned) if re.search(rx, b[1], re.I)]
        g = bool(re.search(rx, gold, re.I))
        rows.append([name, "yes" if g else "no", f"yes ({len(l)} bullet{'s' if len(l) != 1 else ''})" if l else "NO"])
    return table(rows, ["convention", "in gold", "in learned"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dir")
    ap.add_argument("--out")
    a = ap.parse_args()
    rd = os.path.abspath(a.run_dir)
    out = a.out or os.path.join(rd, "report.md")

    evals = []
    for f in sorted(glob.glob(os.path.join(rd, "eval", "*.jsonl"))):
        evals += C.read_jsonl(f)
    loop = C.read_jsonl(os.path.join(rd, "loop.jsonl"))
    L = ["# RSI workspace-learning experiment report", "", f"Run: `{os.path.basename(rd)}`", "",
         "Counts are raw; percentages appear only beside their counts. The demo is small (a handful of tasks, "
         "few runs per arm) and is not powered for percentage or significance claims: differences of one or two "
         "runs are within noise. `n` below is the number of agent runs behind each row.", ""]

    L += ["## Final arms (agent: held-out and control tasks)", ""]
    if evals:
        L += [render_eval(evals), "", "### Per task", "", per_task(evals), ""]
        ws = [r for r in evals if r["arm"] == "workspace-B"]
        if ws:
            vers = sorted({s["sha"] for r in ws for s in r.get("ws_skills", [])})
            L += [f"workspace-B: skill arrived by sync in {sum(1 for r in ws if r.get('ws_arrived'))}/{len(ws)} runs; "
                  f"versions (sha256 prefix of SKILL.md) that arrived: {', '.join(vers) or 'none'}; backend copy (GET /skills as B) "
                  f"sha: {', '.join(sorted({str(r.get('backend_sha')) for r in ws}))}; workdir copy equals backend copy in "
                  f"{sum(1 for r in ws if r.get('ws_matches_backend'))}/{len(ws)} runs", ""]
        leaks = [r for r in evals if r.get("leak")]
        L += [f"Integrity: {len(leaks)}/{len(evals)} runs flagged `leak` "
              "(tool input naming verifier, gold, demo/ or the repo root)."]
        for r in leaks[:10]:
            L.append(f"- {r['arm']} {r['task']} #{r['run_idx']}: {r['leak_hits'][:2]}")
        L.append("")
    else:
        L += ["(no eval results found in `eval/*.jsonl`)", ""]

    gates = [r for r in loop if r.get("type") == "gate"]
    L += ["## Learning curve on val (gate numbers)", ""]
    if gates:
        rows = []
        for g in gates:
            if g.get("decision") == "skip":
                rows.append([g["iter"], "-", "-", "-", "skipped: " + g["reason"]])
                continue
            rows.append([g["iter"], f"{g['cur_total']} ({g['cur_pass']}/{g['n_cur']} runs pass)",
                         f"{g['cand_total']} ({g['cand_pass']}/{g['n_cand']} runs pass)",
                         f"{len(g['val_tasks'])} tasks x {g['val_runs']} runs", g["action"]])
        L += [table(rows, ["iteration", "current: checks passed", "candidate: checks passed", "val size", "action"]), "",
              "Checks passed = sum over val runs of per-check passes (max = checks per task x runs; staging tasks have 6, "
              "controls 4). Val results never reach the reflector.", ""]
        trains = [r for r in loop if r.get("phase") == "train"]
        if trains:
            L += ["Train-run outcome per iteration (agent with the then-promoted playbook; n = train tasks):", "",
                  table([[it, len([r for r in trains if r["iter"] == it]),
                          frac(sum(1 for r in trains if r["iter"] == it and r["pass"]), len([r for r in trains if r["iter"] == it])),
                          sum(sum(1 for v in r["checks"].values() if v) for r in trains if r["iter"] == it)]
                         for it in sorted({r["iter"] for r in trains})],
                        ["iteration", "n", "pass k/n", "checks passed"]), ""]
    L += ["## Gate decisions", ""]
    for g in gates:
        if g.get("decision") == "skip":
            L.append(f"- iteration {g['iter']}: no gate ({g['reason']}).")
            continue
        L.append(f"- iteration {g['iter']}: candidate {g['cand_total']} vs current {g['cur_total']} checks "
                 f"(margin {g['margin']}), regressions {len(g['losses'])} -> **{g['action']}**"
                 f"{' (current val results reused)' if g.get('current_reused') else ''}")
        for x in g["losses"]:
            L.append(f"  - lost: {x['task']} {x['check']} current {x['current']} candidate {x['candidate']}")
    pubs = [r for r in loop if r.get("type") == "publish"]
    for p in pubs:
        L.append(f"- publish ({p.get('backend')}, workspace {p.get('workspace_id')}): rc={p['rc']}, visible to B="
                 f"{p.get('as_b', {}).get('found')}, attached to workspace={p.get('attached_to_workspace')}, backend content "
                 f"equals promoted={p.get('backend_content_matches_promoted')}, backend sha={p.get('backend_sha')}, "
                 f"local promoted sha={p.get('local_promoted_sha')}")
    L.append("")

    learned_p = os.path.join(rd, "playbooks", "final.md")
    learned = open(learned_p).read() if os.path.isfile(learned_p) else None
    L += ["## Final learned playbook", ""]
    L += ["```markdown", learned.strip(), "```", ""] if learned else ["(nothing was promoted)", ""]
    nf_p = os.path.join(rd, "playbook-nofeedback.md")
    if os.path.isfile(nf_p):
        L += ["## No-feedback ablation playbook", "", "```markdown", open(nf_p).read().strip(), "```", ""]

    gold = open(os.path.join(C.VERIFIER, "gold_playbook.md")).read()
    L += ["## Learned vs gold conventions", ""]
    if learned:
        L += [convention_diff(learned, gold), "", "Keyword coverage only (a bullet may mention a rule without stating it "
              "correctly); read the playbook text above for substance.", ""]
        lb = [b[1] for b in bullets(learned)]
        L += ["Unified diff, gold body (-) vs learned bullets (+):", "", "```diff"]
        L += list(difflib.unified_diff([l for l in gold.splitlines() if l.strip()], lb, "gold", "learned", lineterm="", n=0))
        L += ["```", ""]
    else:
        L += ["(no learned playbook)", ""]
    open(out, "w").write("\n".join(L))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
