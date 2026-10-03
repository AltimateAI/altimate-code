#!/usr/bin/env python3
"""report_corrections.py runs/<run_id> [--compare runs/saas-v2] [--out report-corrections.md]

Report for the corrections-only loop (loop_corrections.py): corrections per session by iteration (the online
metric), captured signals vs correction rounds (capture recall), the learned playbook, eval-only first-attempt
verifier scores, and the held-out/control table next to the saas-v2 arms (none, learned-from-CI, gold).
Raw counts first; a percentage only ever appears next to its count.
"""
import argparse
import glob
import os

import common as C
import report as R

EXCLUDED = "heldout-support-tickets"  # its prompt changed after saas-v2 ran `none`; reported separately
COMPARE_ARMS = {"none": "none (saas-v2)", "learned": "learned-from-CI (saas-v2)", "gold": "gold (saas-v2)"}
ORDER = ["none (saas-v2)", "learned-from-CI (saas-v2)", "gold (saas-v2)", "corrections-learned",
         "corrections-workspace-B", "workspace-B"]


def load_arms(rd, rename=None, only=None):
    recs = []
    for f in sorted(glob.glob(os.path.join(rd, "eval", "*.jsonl"))):
        for r in C.read_jsonl(f):
            if only and r["arm"] not in only:
                continue
            if rename:
                r = dict(r, arm=rename.get(r["arm"], r["arm"]))
            recs.append(r)
    return recs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dir")
    ap.add_argument("--compare", default=os.path.join(C.RUNS, "saas-v2"))
    ap.add_argument("--out")
    a = ap.parse_args()
    rd = os.path.abspath(a.run_dir)
    out = a.out or os.path.join(rd, "report-corrections.md")
    loop = C.read_jsonl(os.path.join(rd, "loop.jsonl"))
    eval_only = C.read_jsonl(os.path.join(rd, "eval_only.jsonl"))
    sessions = [r for r in loop if r.get("type") == "session"]
    iters = sorted({r["iter"] for r in sessions})
    tasks = sorted({r["task"] for r in sessions})

    L = ["# RSI corrections-only learning report", "", f"Run: `{os.path.basename(rd)}`", "",
         "Training signal: a simulated teammate (Sonnet 4.6, knows the team conventions, never sees verifier output) "
         "types review corrections in chat. No CI, no verifier, no check names anywhere in `learn`. The hidden "
         "verifier scores the agent's first attempt for evaluation only. n is small throughout; read counts, not "
         "percentages.", ""]

    # ---- online metric
    L += ["## Online metric: corrections per train session", ""]
    rows = []
    for it in iters:
        ss = [s for s in sessions if s["iter"] == it]
        n, corr = len(ss), sum(s["rounds"] for s in ss)
        rows.append([it, n, corr, f"{corr / n:.2f}" if n else "-", f"{sum(1 for s in ss if s.get('lgtm_first'))}/{n}",
                     ", ".join(f"{s['task'].replace('train-', '')}:{s['rounds']}" for s in sorted(ss, key=lambda s: s["task"])),
                     f"${sum(s.get('agent_cost', 0) for s in ss):.2f}", f"${sum(s.get('review_cost', 0) for s in ss):.2f}"])
    L += [R.table(rows, ["iteration", "sessions", "correction rounds", "corrections / session", "first review LGTM",
                         "rounds by task", "agent cost", "teammate cost"]), "",
          "Correction rounds per session are capped at 2. Lower across iterations = the teammate has to correct less "
          "(codex-engineer style online metric, no verifier).", ""]

    # ---- capture recall
    L += ["## Capture: product-recorded signals vs correction rounds", ""]
    rows, rounds_total, with_sig = [], 0, 0
    for s in sorted(sessions, key=lambda s: (s["iter"], s["task"])):
        cap = s.get("captured") or {}
        rounds_total += s["rounds"]
        with_sig += 1 if (s["rounds"] and cap.get("user_correction")) else 0
        rows.append([s["iter"], s["task"], s["rounds"], cap.get("user_correction", "-"), cap.get("tool_retry", "-"),
                     cap.get("n", "-"), cap.get("source", "-")])
    L += [R.table(rows, ["iter", "task", "correction rounds sent", "user_correction signals", "tool_retry signals",
                         "all signals", "read via"]), ""]
    with_rounds = sum(1 for s in sessions if s["rounds"])
    sig_total = sum((s.get("captured") or {}).get("user_correction", 0) for s in sessions)
    L += [f"Capture recall: {with_sig}/{with_rounds} sessions with at least one correction have at least one "
          f"`user_correction` signal; {sig_total} `user_correction` signals for {rounds_total} correction rounds sent.", ""]
    caps = [r for r in loop if r.get("type") == "product_caps"]
    if caps:
        L += [f"Product interface probe: `learn reflect --signals-from` supported = {caps[0].get('signals_from')}, "
              f"`learn signals` supported = {caps[0].get('signals_cmd')}. " + (
              "" if caps[0].get("signals_from") else
              "Product gap: signals are per project directory, so a maintainer cannot pull a teammate's signals; the "
              "harness copied each workdir's `signals.jsonl` into the maintainer checkout before `learn reflect --session`."), ""]
    refl = [r for r in loop if r.get("type") == "reflect"]
    L += [f"Reflections: {sum(1 for r in refl if r.get('ok'))} ok, {sum(1 for r in refl if r.get('ok') is False)} failed, "
          f"{sum(1 for r in refl if r.get('skipped'))} skipped (no signals).", ""]

    # ---- review texts
    L += ["## What the teammate said", ""]
    for s in sorted(sessions, key=lambda s: (s["iter"], s["task"])):
        for r in s["reviews"]:
            txt = "LGTM" if r["lgtm"] else r["text"].replace("\n", " ")
            L.append(f"- it{s['iter']} {s['task']} review {r['round']}: {txt}")
    L.append("")

    # ---- eval only
    L += ["## Evaluation only: hidden-verifier score of the agent's first attempt (never reaches learn)", ""]
    first = [r for r in eval_only if r.get("stage") == "first_attempt"]
    rows = []
    for it in iters:
        fs = [r for r in first if r["iter"] == it]
        n = len(fs)
        rows.append([it, n, R.frac(sum(1 for r in fs if r["pass"]), n), sum(sum(1 for v in (r.get("checks") or {}).values() if v) for r in fs),
                     ", ".join(f"{r['task'].replace('train-', '')}:{r['score']:.2f}" for r in sorted(fs, key=lambda r: r["task"]))])
    L += [R.table(rows, ["iteration", "n", "first attempt pass k/n", "checks passed", "score by task"]), ""]
    post = [r for r in eval_only if r.get("stage") == "post_correction"]
    if post:
        L += [f"After the teammate's corrections were applied in-session: {R.frac(sum(1 for r in post if r['pass']), len(post))} "
              f"of the {len(post)} corrected sessions pass the verifier (for context only).", ""]

    # ---- gate / publish
    L += ["## Gate and publish", ""]
    for g in [r for r in loop if r.get("type") == "gate"]:
        L.append(f"- iteration {g['iter']}: gate = {g.get('gate')}; decision: **{g.get('decision')}**"
                 f"{' (' + g['reason'] + ')' if g.get('reason') else ''}")
    for p in [r for r in loop if r.get("type") == "publish"]:
        L.append(f"- publish ({p.get('backend')}, workspace {p.get('workspace_id')}): rc={p['rc']}, previous skill detached="
                 f"{p.get('detached_previous')}, visible to B={p.get('as_b', {}).get('found')}, backend content equals "
                 f"promoted={p.get('backend_content_matches_promoted')}, backend sha={p.get('backend_sha')}")
        for gap in p.get("gaps", []):
            L.append(f"  - product gap: {gap}")
    L.append("")

    # ---- playbook
    fp = os.path.join(rd, "playbooks", "final.md")
    learned = open(fp).read() if os.path.isfile(fp) else None
    L += ["## Learned playbook (from corrections only)", ""]
    L += ["```markdown", learned.strip(), "```", ""] if learned else ["(nothing was promoted)", ""]
    gold = open(os.path.join(C.VERIFIER, "gold_playbook.md")).read()
    if learned:
        L += ["### Keyword coverage of the gold conventions", "", R.convention_diff(learned, gold), ""]

    # ---- held-out vs saas-v2
    recs = load_arms(rd, rename={"corrections-learned": "corrections-learned",
                                 "corrections-workspace-B": "corrections-workspace-B", "workspace-B": "workspace-B"})
    recs = [r for r in recs if r["arm"] != "none"]
    cmp_dir = os.path.abspath(a.compare)
    cmp = load_arms(cmp_dir, rename=COMPARE_ARMS, only=set(COMPARE_ARMS)) if os.path.isdir(cmp_dir) else []
    base = [r for r in C.read_jsonl(os.path.join(rd, "eval", "none.jsonl"))]
    if base:  # the reused baseline copied into this run dir
        cmp = [r for r in cmp if r["arm"] != "none (saas-v2)"] + [dict(r, arm="none (saas-v2)") for r in base]
    allr = cmp + recs
    R.ARM_ORDER[:] = ORDER
    main_recs = [r for r in allr if r["task"] != EXCLUDED]
    L += ["## Held-out and control vs saas-v2 arms", "",
          f"`none`, `learned-from-CI` and `gold` are the saas-v2 runs (same tasks, model, verifier). `{EXCLUDED}` is "
          "excluded from this headline (its prompt was changed after the saas-v2 baseline ran, and it has a second "
          "naming ambiguity); it is shown separately below.", "",
          R.render_eval(main_recs) if main_recs else "(no eval records yet)", ""]
    sep = [r for r in allr if r["task"] == EXCLUDED]
    if sep:
        L += [f"### {EXCLUDED} (separate)", "", R.render_eval(sep), "",
              "Note: the saas-v2 `none` baseline for this task used the earlier prompt; compare only the arms run "
              "after the prompt change.", ""]
    L += ["### Per task", "", R.per_task(main_recs) if main_recs else "", ""]
    ws = [r for r in recs if r["arm"] in ("corrections-workspace-B", "workspace-B")]
    if ws:
        L += [f"workspace-B: skill arrived by sync in {sum(1 for r in ws if r.get('ws_arrived'))}/{len(ws)} runs; workdir "
              f"copy equals backend copy in {sum(1 for r in ws if r.get('ws_matches_backend'))}/{len(ws)} runs.", ""]

    # ---- integrity
    leaks = [r for r in recs if r.get("leak")]
    L += ["## Integrity", "",
          f"- Eval-arm runs flagged `leak` (tool input naming verifier/gold/demo/repo root): {len(leaks)}/{len(recs)}.",
          "- Before every reflect the harness asserted that no verifier message fragment (`Team rule:`, "
          "`reconciliation`, every failed-check message of that iteration) occurs in any workdir `signals.jsonl`, "
          "the maintainer `signals.jsonl`, `history.jsonl`, the candidate, or a teammate review text; a hit aborts "
          "the run. The run finished, so none occurred.",
          "- The teammate ran as isolated reviewer user `r` in a copy of the workdir without `.altimate-code`; it "
          "was given the ticket and the conventions only.", ""]
    open(out, "w").write("\n".join(L))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
