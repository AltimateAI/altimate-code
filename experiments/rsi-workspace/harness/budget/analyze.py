#!/usr/bin/env python3
"""analyze.py --run-dir D --labels a,b,c   (stdlib only; markdown table to stdout)

Reads D/eval/*.jsonl (records written by eval.py/common.run_task, one per run, rec["arm"] = label) and, for each
rec's trace (rec["trace_path"], a v2 trace json with spans of kind session/generation/tool), reports per label:
heldout (excluding heldout-support-tickets, like report_corrections.py) fully-passing runs and checks passed,
support-tickets separately, control pass, per-check C1..C6, and trace metrics (first generation input tokens, mean
cacheRead/cacheWrite per generation, generations, wall time, cost, `skill` tool calls).
"""
import argparse
import glob
import json
import os
import re
from statistics import mean

EXCLUDED = "heldout-support-tickets"
CHECKS = ["C1", "C2", "C3", "C4", "C5", "C6"]


def load(run_dir):
    recs = []
    for f in sorted(glob.glob(os.path.join(run_dir, "eval", "*.jsonl"))):
        for l in open(f):
            if l.strip():
                recs.append(json.loads(l))
    return recs


def trace_stats(rec):
    p = rec.get("trace_path")
    if not p or not os.path.isfile(p):
        return None
    try:
        spans = json.load(open(p)).get("spans", [])
    except Exception:
        return None
    gens = sorted((s for s in spans if s.get("kind") == "generation"), key=lambda s: int(s.get("startTime") or 0))
    tk = lambda g, k: (g.get("tokens") or {}).get(k) or 0
    skills = []
    for s in spans:
        if s.get("kind") == "tool" and s.get("name") == "skill":
            inp = s.get("input")
            if isinstance(inp, str):
                try:
                    inp = json.loads(inp)
                except Exception:
                    inp = {"raw": inp}
            skills.append((inp or {}).get("name") or json.dumps(inp)[:40])
    return {
        "first_input": tk(gens[0], "input") if gens else None,
        "cache_read": mean(tk(g, "cacheRead") for g in gens) if gens else None,
        "cache_write": mean(tk(g, "cacheWrite") for g in gens) if gens else None,
        "gens": len(gens),
        "skills": skills,
    }


def frac(k, n):
    return f"{k}/{n}"


def fmt(v, nd=0):
    return "-" if v is None else f"{v:,.{nd}f}"


def avg(xs, nd=0):
    xs = [x for x in xs if x is not None]
    return fmt(mean(xs), nd) if xs else "-"


def table(rows, head):
    out = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--labels", required=True)
    a = ap.parse_args()
    recs = load(a.run_dir)
    labels = [x for x in a.labels.split(",") if x]

    outcome, per_check, trace = [], [], []
    for lab in labels:
        rs = [r for r in recs if r.get("arm") == lab]
        held = [r for r in rs if r.get("split") == "heldout" and r["task"] != EXCLUDED]
        supp = [r for r in rs if r["task"] == EXCLUDED]
        ctrl = [r for r in rs if r.get("split") == "control"]
        ck = lambda r: sum(1 for v in (r.get("checks") or {}).values() if v)
        ct = lambda r: len(r.get("checks") or {}) or 6
        outcome.append([lab, frac(sum(1 for r in held if r.get("pass")), len(held)),
                        frac(sum(ck(r) for r in held), sum(ct(r) for r in held)),
                        frac(sum(1 for r in supp if r.get("pass")), len(supp)),
                        frac(sum(ck(r) for r in supp), sum(ct(r) for r in supp)),
                        frac(sum(1 for r in ctrl if r.get("pass")), len(ctrl))])
        per_check.append([lab] + [frac(sum(1 for r in held if (r.get("checks") or {}).get(c)),
                                       sum(1 for r in held if c in (r.get("checks") or {}))) for c in CHECKS])
        ts = [(r, trace_stats(r)) for r in rs]
        have = [(r, t) for r, t in ts if t]
        calls = [s for _, t in have for s in t["skills"]]
        runs_with = sum(1 for _, t in have if t["skills"])
        names = ", ".join(f"{n} x{calls.count(n)}" for n in sorted(set(calls))) or "none"
        trace.append([lab, f"{len(have)}/{len(rs)}", avg([t["first_input"] for _, t in have]),
                      avg([t["cache_read"] for _, t in have]), avg([t["cache_write"] for _, t in have]),
                      avg([t["gens"] for _, t in have], 1), avg([r.get("duration") for r in rs], 1),
                      avg([r.get("cost") for r in rs], 3), f"{runs_with}/{len(have)} runs ({names})"])

    print("## Outcomes (heldout excludes `%s`)\n" % EXCLUDED)
    print(table(outcome, ["label", "heldout pass", "heldout checks", "support-tickets pass", "support-tickets checks",
                          "control pass"]))
    print("\n## Per-check pass, heldout (excl. support-tickets)\n")
    print(table(per_check, ["label"] + CHECKS))
    print("\n## Trace / cost (means per run; tokens per generation)\n")
    print(table(trace, ["label", "traces found", "1st gen input tok", "mean cacheRead/gen", "mean cacheWrite/gen",
                        "generations", "wall s", "cost $", "`skill` tool calls"]))


if __name__ == "__main__":
    main()
