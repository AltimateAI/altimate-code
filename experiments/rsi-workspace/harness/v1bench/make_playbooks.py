#!/usr/bin/env python3
"""Write SKILL.md playbooks (the format common.install_playbook expects) from the pools; stdlib only.

Arms that can run TODAY with `eval.py --arm playbook:<file>` (old behaviour: everything is in the system prompt):
  playbooks/real4-short.md   the 4 real lessons, <=140 chars
  playbooks/real4-long.md    the 4 real lessons, original long form (== harness/runs/corr-main/playbooks/final.md bullets)
  playbooks/all-50.md  all-300.md  all-1000.md   every lesson of the pool, short form, shuffled order of the pool file
  playbooks/n50-long.md  n50-short.md            compression pair: the same 50 lessons (4 real + 46 reused budget
                                                 distractors), long vs <=140-char form
Retrieval arms need the product (tiered retrieval, file hook); they consume the pool-*.jsonl files directly.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import common as C  # noqa: E402

OUT = os.path.join(HERE, "playbooks")
HDR = "<!-- learned-playbook v1; managed by `altimate-code learn`. Edit via `learn`, not by hand. -->"


def bullets(rs):
    return "\n".join(f"- [{r['id']}] {r['text']} <!-- h:0 x:0 -->" for r in rs)


def write(name, rs):
    text = C.wrap_skill(HDR + "\n" + bullets(rs))
    open(os.path.join(OUT, name), "w").write(text)
    print(f"{name:20} lessons={len(rs):4d} bytes={len(text.encode())}")


def rd(p):
    return [json.loads(l) for l in open(os.path.join(HERE, p)) if l.strip()]


def main():
    os.makedirs(OUT, exist_ok=True)
    real_short = [r for r in rd("lessons-1000.jsonl") if r["kind"] == "real"]
    real_long = rd("real-long.jsonl")
    order = [r["id"] for r in real_short]
    real_short.sort(key=lambda r: order.index(r["id"]))
    write("real4-short.md", real_short)
    write("real4-long.md", real_long)
    for n in (50, 300):
        write(f"all-{n}.md", rd(f"pool-{n}.jsonl"))
    write("all-1000.md", rd("lessons-1000.jsonl"))
    # compression pair: reuse the first 46 budget distractors (same ids as in the pool) in long and short form
    long_d = [json.loads(l) for l in open(os.path.join(HERE, "..", "budget", "distractors.jsonl")) if l.strip()][:46]
    pool = {r["id"]: r for r in rd("lessons-1000.jsonl")}
    short_d = [pool[d["id"]] for d in long_d]
    longs = [{"id": d["id"], "text": d["text"]} for d in long_d]

    def spread(real, dis):
        n = len(real) + len(dis)
        pos = [round(i * n / 4) + n // 8 for i in range(4)]
        out, di, ri = [], iter(dis), iter(real)
        for k in range(n):
            out.append(next(ri) if k in pos else next(di))
        return out
    write("n50-long.md", spread(real_long, longs))
    write("n50-short.md", spread(real_short, short_d))


if __name__ == "__main__":
    main()
