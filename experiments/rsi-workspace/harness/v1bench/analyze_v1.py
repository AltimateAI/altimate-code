#!/usr/bin/env python3
"""analyze_v1.py RUN_DIR [RUN_DIR ...] [--labels a,b] > report.md   (stdlib only)

Markdown tables for the learn-v1 benchmark. Each RUN_DIR is auto-detected:
  eval/*.jsonl records with `task`      -> outcomes, per-check, retrieval, tokens/cache/cost  (eval_v1, eval.py)
  eval/*.jsonl records with `request2`  -> topic-switch tables (request 2 only; turn 2 tokens/cost)
  loop.jsonl                            -> drift tables (corrections per session, stale lessons retired, reflect wall time)
  bootstrap.json                        -> bootstrap tables (signals, candidates, tokens/cost, recovery)
Conventions (as budget/analyze.py): heldout headline excludes support-tickets (`heldout-support-tickets` and
`vague-support-tickets`), shown separately; controls separately. Trace metrics come from rec["trace_path"] when the
trace file still exists. Costs are the sum of step_finish cost (run records) or the product's own estimate (bootstrap).
"""
import argparse
import glob
import importlib.util
import json
import os
from statistics import mean, median

HERE = os.path.dirname(os.path.abspath(__file__))
CHECKS = ["C1", "C2", "C3", "C4", "C5", "C6"]
KCHECKS = ["K1", "K2", "K3", "K4"]
EXCLUDED = ("heldout-support-tickets", "vague-support-tickets")
TIERS = ["core", "retrieved", "request", "file"]

_spec = importlib.util.spec_from_file_location("budget_analyze", os.path.join(HERE, "..", "budget", "analyze.py"))
_ba = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_ba)
trace_stats = _ba.trace_stats


def jl(path):
    return [json.loads(l) for l in open(path) if l.strip()]


def table(rows, head):
    out = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out) + "\n"


def fmt(v, nd=0):
    return "-" if v is None else f"{v:,.{nd}f}"


def avg(xs, nd=0):
    xs = [x for x in xs if x is not None]
    return fmt(mean(xs), nd) if xs else "-"


def frac(k, n):
    return f"{k}/{n}" if n else "-"


def pct(k, n):
    return f"{100 * k / n:.0f}%" if n else "-"


def is_heldout(r):
    return r.get("split") in ("heldout", "vague") and r.get("task") not in EXCLUDED


def ck(r):
    return sum(1 for v in (r.get("checks") or {}).values() if v)


def ct(r):
    return len(r.get("checks") or {}) or 6


def group(recs, key, labels=None):
    out = {}
    for r in recs:
        out.setdefault(key(r), []).append(r)
    return {k: out[k] for k in (labels or sorted(out)) if k in out}


def eval_tables(groups):
    out = []
    rows, per, ctl = [], [], []
    for lab, rs in groups.items():
        held = [r for r in rs if is_heldout(r)]
        supp = [r for r in rs if r.get("task") in EXCLUDED]
        ctrl = [r for r in rs if r.get("split") == "control"]
        leaks = sum(1 for r in rs if r.get("leak"))
        rows.append([lab, len(rs), frac(sum(1 for r in held if r.get("pass")), len(held)),
                     frac(sum(ck(r) for r in held), sum(ct(r) for r in held)),
                     frac(sum(1 for r in supp if r.get("pass")), len(supp)),
                     frac(sum(ck(r) for r in supp), sum(ct(r) for r in supp)),
                     frac(sum(1 for r in ctrl if r.get("pass")), len(ctrl)), leaks, sum(1 for r in rs if r.get("error"))])
        per.append([lab] + [frac(sum(1 for r in held if (r.get("checks") or {}).get(c)),
                                 sum(1 for r in held if c in (r.get("checks") or {}))) for c in CHECKS])
        ctl.append([lab] + [frac(sum(1 for r in ctrl if (r.get("checks") or {}).get(c)),
                                 sum(1 for r in ctrl if c in (r.get("checks") or {}))) for c in KCHECKS])
    out.append("### Outcomes (heldout headline excludes support-tickets)\n")
    out.append(table(rows, ["arm", "runs", "heldout pass", "heldout checks", "support-tickets pass",
                            "support-tickets checks", "control pass", "leaks", "errors"]))
    out.append("### Per-check pass, heldout (excl. support-tickets)\n")
    out.append(table(per, ["arm"] + CHECKS))
    out.append("### Per-check pass, controls (K4 = cents kept, K3 = existing columns intact)\n")
    out.append(table(ctl, ["arm"] + KCHECKS))

    # retrieval
    rrows, trows = [], []
    for lab, rs in groups.items():
        rr = [r for r in rs if r.get("retrieval")]
        if not rr:
            continue
        need = [r for r in rr if (r["retrieval"].get("needed"))]
        slots = sum(len(r["retrieval"]["needed"]) for r in need)
        found = sum(len(r["retrieval"]["found"]) for r in need)
        tier_n = {t: sum(r["retrieval"]["recall_by_tier"].get(t, 0) for r in need) for t in TIERS}
        shown_t = {t: [r["retrieval"]["shown_by_tier"].get(t, 0) for r in rr] for t in TIERS}
        kinds = lambda k: [r["retrieval"]["shown_kinds"].get(k, 0) for r in rr]
        rrows.append([lab, len(need), pct(found, slots), frac(sum(1 for r in need if r["retrieval"]["recall"] == 1), len(need)),
                      avg([r["retrieval"]["recall"] for r in need], 2)] + [pct(tier_n[t], slots) for t in TIERS]
                     + [pct(slots - found, slots), avg([r["retrieval"]["n_shown"] for r in rr], 1),
                        avg([r["retrieval"]["precision"] for r in need], 2), avg(kinds("near"), 1), avg(kinds("distractor"), 1)])
        trows.append([lab] + [avg(shown_t[t], 1) for t in TIERS])
    if rrows:
        out.append("### Retrieval recall (needed lessons, from needs.json, found in shown.jsonl; controls need none)\n")
        out.append(table(rrows, ["arm", "runs w/ needs", "recall (lesson slots)", "runs with all needed", "mean per-run recall"]
                         + [f"from {t}" for t in TIERS] + ["missed", "lessons shown/run", "precision", "near shown", "distractors shown"]))
        out.append("### Lessons shown per run, by tier (mean)\n")
        out.append(table(trows, ["arm"] + TIERS))
        miss = {}
        for lab, rs in groups.items():
            for r in rs:
                if r.get("retrieval") and r["retrieval"].get("needed"):
                    for n in r["retrieval"]["needed"]:
                        if n not in r["retrieval"]["found"]:
                            miss.setdefault((lab, r.get("base_task") or r["task"]), set()).add(n)
        if miss:
            out.append("Missed needed lessons (arm, task: ids missed in at least one run)\n")
            out.append("\n".join(f"- {lab}, {t}: {', '.join(sorted(v))}" for (lab, t), v in sorted(miss.items())) + "\n")

    # tokens, cache, cost
    krows = []
    for lab, rs in groups.items():
        ok = [r for r in rs if r.get("tokens") and r.get("steps")]
        ts = [t for t in (trace_stats(r) for r in rs) if t]
        krows.append([lab, len(ok), avg([r["tokens"]["input"] / r["steps"] for r in ok]),
                      avg([r["tokens"]["output"] / r["steps"] for r in ok]),
                      avg([r["tokens"]["cache_read"] / r["steps"] for r in ok]),
                      avg([r["tokens"]["cache_read"] for r in ok]),
                      avg([r["tokens"]["cache_write"] for r in ok]),
                      avg([t["first_input"] for t in ts]), avg([t["cache_read"] for t in ts]), avg([r["steps"] for r in ok], 1),
                      avg([r.get("tool_calls") for r in ok], 1), avg([r.get("duration") for r in ok], 0),
                      avg([r.get("cost") for r in ok], 3), fmt(sum(r.get("cost") or 0 for r in rs), 2)])
    out.append("### Tokens per call, cache reads, cost (means per run; call = generation/step)\n")
    out.append(table(krows, ["arm", "runs", "input tok/call", "output tok/call", "cache read tok/call", "cache read tok/run",
                             "cache write tok/run", "1st-gen input (trace)", "cacheRead/gen (trace)", "calls/run",
                             "tool calls/run", "wall s", "cost $/run", "cost $ total"]))
    return "\n".join(out)


def topic_tables(groups):
    out = ["### Topic switch: request 2 outcome and retrieval (scored on request 2 only)\n"]
    rows, trows = [], []
    for lab, rs in groups.items():
        held = [r for r in rs if r["request2"].startswith("heldout") and r["request2"] not in EXCLUDED]
        ctrl = [r for r in rs if r["request2"].startswith("control")]
        rr = [r for r in rs if r.get("retrieval") and r["retrieval"].get("needed")]
        slots = sum(len(r["retrieval"]["needed"]) for r in rr)
        anyf = sum(len(r["retrieval"]["found"]) for r in rr)
        late = sum(round((r["retrieval"].get("recall_turn2") or 0) * len(r["retrieval"]["needed"])) for r in rr)
        early = sum(len(r["retrieval"].get("in_context_from_turn1") or []) for r in rr)
        rows.append([lab, len(rs), frac(sum(1 for r in held if r.get("pass")), len(held)),
                     frac(sum(ck(r) for r in held), sum(ct(r) for r in held)),
                     frac(sum(1 for r in ctrl if r.get("pass")), len(ctrl)),
                     frac(sum(1 for r in rs if r.get("same_session")), len(rs)),
                     pct(anyf, slots) if rr else "-", pct(early, slots) if rr else "-", pct(late, slots) if rr else "-"])
        t1 = [r["turn1"] for r in rs if r.get("turn1", {}).get("tokens")]
        t2 = [r["turn2"] for r in rs if r.get("turn2", {}).get("tokens")]
        trows.append([lab, avg([x["tokens"]["input"] / max(1, x["steps"]) for x in t1]), avg([x["tokens"]["input"] / max(1, x["steps"]) for x in t2]),
                      avg([x["tokens"]["cache_read"] for x in t2]), avg([x["tokens"]["cache_write"] for x in t2]),
                      avg([x["tool_calls"] for x in t2], 1), avg([x["duration"] for x in t2]), avg([x["cost"] for x in t1], 3),
                      avg([x["cost"] for x in t2], 3)])
    out.append(table(rows, ["arm", "sessions", "req2 heldout pass", "req2 heldout checks", "req2 control pass", "same session",
                            "recall (any time)", "already shown in turn 1", "added after request 2 (request/file tier)"]))
    out.append("### Topic switch: per-turn tokens and cost (means)\n")
    out.append(table(trows, ["arm", "turn1 input tok/call", "turn2 input tok/call", "turn2 cache read tok", "turn2 cache write tok",
                             "turn2 tool calls", "turn2 wall s", "turn1 cost $", "turn2 cost $"]))
    return "\n".join(out)


def drift_tables(name, d):
    recs = jl(os.path.join(d, "loop.jsonl"))
    out = [f"### Drift: {name}\n"]
    om = [r for r in recs if r.get("type") == "online_metric"]
    out.append(table([[r["iter"], r["sessions"], r["corrections"], r["corrections_per_session"], r["lgtm_first"],
                       r["with_user_correction_signal"], len(r["approved_ids"])] for r in om],
                     ["iteration", "sessions", "corrections", "corrections/session", "first-attempt LGTM", "sessions w/ correction signal", "approved lessons at start"]))
    rf = [r for r in recs if r.get("type") == "reflect"]
    gate = [r for r in recs if r.get("type") == "gate"]
    out.append(table([[r["iter"], r.get("rc", "-"), r.get("wall_s", "-"), r.get("signals_copied", r.get("skipped", "-"))] for r in rf],
                     ["iteration", "reflect rc", "reflect wall s (tokens/cost not reported by `learn reflect`)", "signals"]))
    out.append(table([[r["iter"], r["decision"][:40], r.get("n_before", "-"), r.get("n_after", "-"),
                       ",".join(r.get("stale_remaining", [])) or "none", len(r.get("added", []))] for r in gate],
                     ["iteration", "gate", "lessons before", "after", "stale lessons remaining", "new lessons"]))
    fin = next((r for r in recs if r.get("type") == "final"), None)
    if fin:
        seed = next((r for r in recs if r.get("type") == "seed"), {})
        out.append(f"Final approved: {len(fin['ids'])} lessons; stale seed {', '.join(seed.get('ids', []))}; "
                   f"remaining stale: {', '.join(fin['stale_remaining']) or 'none'}; retired: {', '.join(map(str, fin['retired'])) or 'none'}.\n")
    return "\n".join(out)


def bootstrap_tables(name, d):
    b = json.load(open(os.path.join(d, "bootstrap.json")))
    dry, run = b.get("dry_run", {}), b.get("bootstrap", {})
    out = [f"### Bootstrap: {name} (source {b.get('source_run')}, model {b.get('model')})\n"]
    out.append(table([[dry.get("sessions"), dry.get("signals"), dry.get("corrections"), dry.get("tool_failures"),
                       dry.get("estimated_input_tokens"), run.get("reflections_run"), run.get("candidates_added"),
                       run.get("candidates_edited"), b.get("n_lessons"), run.get("input_tokens"), run.get("output_tokens"),
                       run.get("cost_usd"), run.get("wall_s")]],
                     ["sessions", "signals", "corrections", "tool failures", "est. input tok (dry run)", "reflections",
                      "candidates added", "edited", "promoted lessons", "input tok", "output tok", "est. cost $", "wall s"]))
    rec = b.get("recovered_real_lessons_heuristic") or {}
    out.append("Real lessons recovered (keyword heuristic, verify by hand): " +
               "; ".join(f"{k}: {', '.join(v) or 'none'}" for k, v in rec.items()) + "\n")
    out.append("\n".join(f"- `{l['id']}` {l['text']}" for l in b.get("lessons", [])) + "\n")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dirs", nargs="+")
    ap.add_argument("--labels", help="comma-separated arm labels to include/order")
    a = ap.parse_args()
    labels = [x for x in (a.labels or "").split(",") if x] or None
    multi = len(a.run_dirs) > 1
    ev, topic = [], []
    sections = []
    for d in a.run_dirs:
        name = os.path.basename(d.rstrip("/"))
        for f in sorted(glob.glob(os.path.join(d, "eval", "*.jsonl"))):
            for r in jl(f):
                r["_dir"] = name
                (topic if "request2" in r else ev).append(r)
        if os.path.isfile(os.path.join(d, "loop.jsonl")):
            sections.append(drift_tables(name, d))
        if os.path.isfile(os.path.join(d, "bootstrap.json")):
            sections.append(bootstrap_tables(name, d))
    key = (lambda r: f"{r['_dir']}/{r.get('arm')}") if multi else (lambda r: r.get("arm"))
    print("# learn v1 benchmark tables\n")
    if ev:
        print("## Eval arms\n")
        print(eval_tables(group(ev, key, labels)))
    if topic:
        print("## Topic switch\n")
        print(topic_tables(group(topic, key, labels)))
    for s in sections:
        print(s)


if __name__ == "__main__":
    main()
