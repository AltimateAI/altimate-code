#!/usr/bin/env python3
"""Generate the learn-v1 lesson pools (stdlib only, deterministic).

  python3 pool.py            -> lessons-1000.jsonl, pool-50.jsonl, pool-300.jsonl, real-long.jsonl, pool-review.md

Record: {"id","text","tags":[...],"trigger":{"paths":[...]}?,"kind":"real|distractor|near"}.
Real lessons: the 4 learned bullets (short <=140 chars here; long originals in real-long.jsonl, same ids).
"""
import hashlib
import json
import os
import random
import re

from pool_data import CATS
from pool_near import NEAR

HERE = os.path.dirname(os.path.abspath(__file__))
BUDGET = os.path.join(HERE, "..", "budget")
MAXLEN = 140
TOTAL = 1000
SEED = 20260930

# Vocabulary a regular distractor must not contain (staging work + the control tasks' vocabulary).
BANNED = re.compile(r"cents|to_utc|\butc\b|staging|stg_|_is_deleted|soft.?delet|timestamp|renam|\bsources?\b|"
                    r"dollar|\bmoney\b|\bcurrenc|cents_to_dollars|\bstage\b", re.I)
# Nobody (not even near distractors) may carry these: the four real rules or the control answers.
HARD_BANNED = re.compile(r"cents|to_utc|stg_|_is_deleted|soft.?delet|cents_to_dollars|"
                         r"`?_at`? suffix|total_cents|payments_by_month|is_vip", re.I)

REAL_SHORT = [
 ("L-2fe6", "In staging, convert `*_cents` with `{{ cents_to_dollars('x_cents') }}` and drop `_cents` from output names (`amount`).",
  ["dbt", "staging", "money", "cents"], ["models/staging/**", "seeds/raw_*.csv", "macros/cents_to_dollars.sql"]),
 ("L-8536", "If the source has `_is_deleted`, add `where not _is_deleted` in the renamed CTE and do not select the column.",
  ["dbt", "staging", "soft-delete"], ["models/staging/**", "seeds/raw_*.csv"]),
 ("L-8201", "In staging models, wrap timestamps in `{{ to_utc('col') }}` and alias with `_at`; leave plain `date` columns alone.",
  ["dbt", "staging", "timestamp", "timezone"], ["models/staging/**", "seeds/_seeds.yml", "macros/to_utc.sql"]),
 ("L-8aba", "A new staging source must be in the sources yml; the model yml lists only final-select columns, by aliased name.",
  ["dbt", "staging", "yml", "sources"], ["models/staging/**/_*__sources.yml", "models/staging/**/_*__models.yml"]),
]
# Which of the 4 each heldout/control task needs (columns present in its raw seed); L-8aba is never required.
NEEDS = {
 "heldout-disputes": ["L-2fe6", "L-8536", "L-8201"],
 "heldout-invoices": ["L-2fe6", "L-8536", "L-8201"],
 "heldout-ledger-entries": ["L-2fe6", "L-8201"],
 "heldout-support-tickets": ["L-8536", "L-8201"],
 "control-customers-vip": [],
 "control-payments-by-month": [],
}


def lid(text):
    return "L-" + hashlib.sha1(text.encode()).hexdigest()[:6]


def compress_existing(t):
    return re.sub(r",? (because|so|since) .*$", "", t).rstrip(". ") + "."


AUTO_WHY = {
    "L-0c7d": "Snapshot strategy choice in snapshots/; mentions an `updated_at` timestamp only as snapshot input, nothing about staging output columns.",
    "L-382f": "Hard-delete handling for snapshots of tables that physically delete rows; unrelated to the `_is_deleted` flag filter in a staging model, and not a snapshot task.",
    "L-7659": "Migration note for snapshot columns in a PR; a new staging model touches no snapshot.",
    "L-909e": "Code-list formatting for lookup seeds under seeds/lookups/; no staging model is asked to convert or format such values.",
}


def load_existing():
    why = {}
    for l in open(os.path.join(BUDGET, "distractors-review.md")):
        m = re.match(r"- `(L-[0-9a-f]+)` triggers", l)
        if m:
            cur = m.group(1)
        m2 = re.search(r"Why it cannot change a staging answer: (.*)", l)
        if m2:
            why[cur] = m2.group(1)
    out = []
    for l in open(os.path.join(BUDGET, "distractors.jsonl")):
        if not l.strip():
            continue
        d = json.loads(l)
        text = compress_existing(d["text"])
        text = text.replace("add it to the intermediate layer first, then select it.", "add it to the intermediate layer first.")
        out.append({"old_id": d["id"], "text": text, "tags": ["dbt"], "paths": d["trigger"], "near": bool(d.get("near")),
                    "why": why.get(d["id"])})
    return out


EXISTING_TAGS = [  # (path prefix, tags) used to give the reused 96 realistic tags
    ("models/marts", ["dbt", "marts"]), ("snapshots", ["dbt", "snapshots"]), ("seeds", ["dbt", "seeds"]),
    ("macros", ["dbt", "macros"]), ("analyses", ["dbt", "analyses"]), ("dags", ["airflow"]),
    ("scripts", ["python"]), ("*.ipynb", ["notebooks"]), (".github", ["ci"]), ("terraform", ["terraform", "snowflake"]),
    ("lookml", ["bi"]), ("**/*.lkml", ["bi"]), ("contracts", ["data-contracts"]), ("models/", ["dbt"]),
    ("dbt_project.yml", ["dbt", "ops"]), ("**/*.yml", ["dbt", "yml"]),
]


def tags_for(paths):
    for pre, tg in EXISTING_TAGS:
        if paths and paths[0].startswith(pre):
            return tg
    return ["practices"]


def build():
    recs, why = [], {}
    seen, texts, skipped = set(), set(), []

    def add(text, tags, paths, kind, rid=None, w=None):
        assert len(text) <= MAXLEN, (len(text), text)
        rid = rid or lid(text)
        if rid in seen or text in texts:
            assert kind != "real" and not rid.startswith("L-") or rid in seen and kind != "real", text
            skipped.append(text)
            return False
        seen.add(rid)
        texts.add(text)
        r = {"id": rid, "text": text, "tags": sorted(set(tags)), "kind": kind}
        if paths:
            r["trigger"] = {"paths": paths}
        recs.append(r)
        if w:
            why[rid] = w
        return True

    for rid, text, tags, paths in REAL_SHORT:
        add(text, tags, paths, "real", rid)
    for e in load_existing():
        near = e["near"] or bool(BANNED.search(e["text"]))
        w = e["why"]
        if near and not w:
            w = AUTO_WHY.get(e["old_id"]) or "Scoped to snapshots/lookup seeds/CI; its wording touches staging vocabulary but gives no instruction for staging models, analyses or the controls."
        add(e["text"], tags_for(e["paths"]) + (["near"] if near else []), e["paths"], "near" if near else "distractor",
            rid=e["old_id"], w=w if near else None)
    for text, tags, paths, w in NEAR:
        add(text, tags, paths, "near", w=w)
    n_fixed = len(recs)
    pool = []
    for name, (tags, paths, items) in CATS.items():
        for t in items:
            pool.append((t, tags, paths))
    need = TOTAL - n_fixed
    rng = random.Random(SEED)
    clean = [p for p in pool if not BANNED.search(p[0])]
    dropped = [p[0] for p in pool if BANNED.search(p[0])]
    rng.shuffle(clean)
    for t, tags, paths in clean:
        if len(recs) >= TOTAL:
            break
        add(t, tags, paths, "distractor")
    if skipped:
        print("skipped duplicates:", skipped)
    return recs, why, dropped, len(clean)


def validate(recs):
    for r in recs:
        if r["kind"] == "real":
            continue
        assert not HARD_BANNED.search(r["text"]), r["text"]
        if r["kind"] == "distractor":
            assert not BANNED.search(r["text"]), r["text"]
        assert "staging" not in r["text"].lower() or r["kind"] == "near", r["text"]
    ids = [r["id"] for r in recs]
    assert len(set(ids)) == len(ids)


def subset(recs, n, rng_seed):
    real = [r for r in recs if r["kind"] == "real"]
    near = [r for r in recs if r["kind"] == "near"]
    dis = [r for r in recs if r["kind"] == "distractor"]
    rng = random.Random(rng_seed)
    rng.shuffle(near)
    rng.shuffle(dis)
    k_near = max(4, round(n * len(near) / len(recs)))
    pick = real + near[:k_near] + dis[: n - len(real) - k_near]
    return pick


def order(rs, seed):
    rs = list(rs)
    random.Random(seed).shuffle(rs)
    return rs


def dump(path, rs):
    with open(os.path.join(HERE, path), "w") as f:
        for r in rs:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def main():
    recs, why, dropped, n_clean = build()
    validate(recs)
    assert len(recs) == TOTAL, (len(recs), n_clean, "short by", TOTAL - len(recs))
    near = [r for r in recs if r["kind"] == "near"]
    dump("lessons-1000.jsonl", order(recs, SEED))
    p300 = subset(recs, 300, SEED + 1)
    p50_ids = {r["id"] for r in subset(recs, 50, SEED + 1)}  # same shuffles -> nested prefixes
    p50 = [r for r in p300 if r["id"] in p50_ids]
    assert len(p50) == 50 and len(p300) == 300
    dump("pool-300.jsonl", order(p300, SEED + 2))
    dump("pool-50.jsonl", order(p50, SEED + 3))
    long = json.load(open(os.path.join(HERE, "real-long-src.json")))
    dump("real-long.jsonl", [{"id": x["id"], "text": x["text"], "tags": next(r["tags"] for r in recs if r["id"] == x["id"]),
                              "trigger": next(r.get("trigger") for r in recs if r["id"] == x["id"]), "kind": "real",
                              "form": "long"} for x in long])
    json.dump(NEEDS, open(os.path.join(HERE, "needs.json"), "w"), indent=1)
    with open(os.path.join(HERE, "pool-review.md"), "w") as f:
        f.write(f"# Near distractors ({len(near)})\n\nThey share vocabulary with staging work (model, column, rename, "
                "timestamp, yml, source, staging) but each names another layer or system. A new staging model is judged by "
                "verifier checks C1-C6 (location/name, key rename plus unique/not_null, money conversion, UTC timestamps "
                "named `_at`, `_is_deleted` filtering, build); the controls by K1-K4 (add a column to an existing model "
                "without touching others; an analysis in `analyses/` that keeps cents). None of the lessons below sets "
                "units, names, filters or tests for staging models, analyses or the files the verifier restores.\n\n")
        for r in near:
            f.write(f"- `{r['id']}` {r['text']}\n  - paths: {r.get('trigger', {}).get('paths')}\n  - cannot change a staging answer because: {why[r['id']]}\n")
        f.write("\n## Broad-path regular distractors\n\nThe `sql_style` and `docs` families match `**/*.sql` or `**/*.md` "
                "so they surface for staging work too. They are formatting/process rules (keyword case, CTE naming, link checks, "
                "Markdown formatting) that no verifier check reads, and none states a unit, a column name, a filter or a test.\n")
    c = lambda rs, k: sum(r["kind"] == k for r in rs)
    for name, rs in (("1000", recs), ("300", p300), ("50", p50)):
        print(name, len(rs), "real", c(rs, "real"), "near", c(rs, "near"), "distractor", c(rs, "distractor"),
              "with-paths", sum("trigger" in r for r in rs))
    print("dropped by ban filter:", len(dropped))
    for d in dropped:
        print("  DROPPED:", d)


if __name__ == "__main__":
    main()
