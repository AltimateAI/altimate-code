#!/usr/bin/env python3
"""make_arms.py: write the rule-budget playbook arms into budget/arms/ (stdlib only).

n25/n50/n100: the 4 real learned bullets + first (N-4) distractors; real bullets evenly spread.
tiered:       real bullets + distractors whose trigger globs match a file in a prepared task workdir (cap 8 total).
pull:         real bullets, frontmatter without applyPaths/alwaysApply (listed in <available_skills>, not auto-loaded).
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
EXP = os.path.abspath(os.path.join(HERE, "..", ".."))
REAL_FILE = os.environ.get("BUDGET_REAL_FILE", os.path.join(HERE, "..", "runs", "corr-main", "playbooks", "final.md"))
ARMS = os.path.join(HERE, "arms")
TIERED_CAP = 8
PREP_TASK = "heldout-disputes"


def parse_final(path):
    text = open(path).read()
    m = re.match(r"(---\n.*?\n---\n)(.*)", text, re.S)
    front, body = m.group(1), m.group(2)
    lines = body.splitlines()
    header = [l for l in lines if l.startswith("<!--")][0]
    bullets = [l for l in lines if l.startswith("- [L-")]
    return front, header, bullets


def bullet(d):
    return f"- [{d['id']}] {d['text']} <!-- h:0 x:0 -->"


def write(name, front, header, bullets):
    text = front + header + "\n" + "\n".join(bullets) + "\n"
    open(os.path.join(ARMS, name), "w").write(text)
    return len(bullets), len(text.encode())


def spread(real, dis, n):
    """n bullets: real ones at round(i*n/4)+n//8, the first n-4 distractors elsewhere."""
    pos = [round(i * n / 4) + n // 8 for i in range(4)]
    assert len(set(pos)) == 4 and max(pos) < n, pos
    out, di, ri = [], iter(dis[: n - 4]), iter(real)
    for k in range(n):
        out.append(next(ri) if k in pos else bullet(next(di)))
    return out


def glob_re(g):
    """Glob -> regex over '/'-separated relative paths: ** spans dirs (and may match none), * and ? stay in a segment."""
    i, out = 0, ""
    while i < len(g):
        if g.startswith("**/", i):
            out += "(?:.*/)?"; i += 3
        elif g.startswith("**", i):
            out += ".*"; i += 2
        elif g[i] == "*":
            out += "[^/]*"; i += 1
        elif g[i] == "?":
            out += "[^/]"; i += 1
        else:
            out += re.escape(g[i]); i += 1
    return re.compile("^" + out + "$")


def workdir_files():
    """Files present when a task starts (dotfiles/dirs skipped, like the harness's dot:false glob scan)."""
    tmp = tempfile.mkdtemp(prefix="budget_prep_")
    wd = os.path.join(tmp, "wd")
    src = "prepare_workdir.py"
    p = subprocess.run([sys.executable, os.path.join(EXP, "demo", "prepare_workdir.py"), PREP_TASK, wd],
                       capture_output=True, text=True)
    if p.returncode != 0:
        print("prepare_workdir failed, listing demo/project instead:", (p.stdout + p.stderr)[-200:], file=sys.stderr)
        wd, src = os.path.join(EXP, "demo", "project"), "demo/project (fallback)"
    files = []
    for dp, dns, fns in os.walk(wd):
        dns[:] = [d for d in dns if not d.startswith(".") and d not in ("target", "logs")]
        for f in fns:
            if not f.startswith(".") and not f.endswith((".duckdb", ".wal")):
                files.append(os.path.relpath(os.path.join(dp, f), wd).replace("\\", "/"))
    # tmp is created exclusively by mkdtemp; reject replacement with a link before cleanup.
    if os.path.islink(tmp) or not os.path.basename(tmp).startswith("budget_prep_"):
        raise ValueError("unsafe temporary directory")
    shutil.rmtree(tmp)
    return sorted(files), src


PULL_FRONT = ('---\nname: team-playbook\n'
              'description: "Conventions this team\'s CI and reviewers enforce, learned from past sessions. '
              'Apply them to related work."\n---\n')

PULL_NOTE = """# What the model sees in the `pull` arm

Frontmatter has `name` and `description` only: no `applyPaths`, no `alwaysApply`.

Source checks (packages/opencode/src/):
- `skill/index.ts` (~line 59-62, 197): `alwaysApply`/`applyPaths` are optional and carried through to `Skill.Info`; absent
  means `undefined`.
- `session/system.ts` `collectAutoLoadedSkills` (~line 218-240): a skill is auto-loaded only if `alwaysApply === true` or its
  `applyPaths` globs match a file in the worktree. With neither, it `continue`s, so the body is NOT placed in the system prompt.
- `session/system.ts` `skills()` (~line 160-170) still renders every available skill via `Skill.fmt(filtered, {verbose: true})`:
  the system prompt contains "Skills provide specialized instructions and workflows for specific tasks. Use the skill tool to
  load a skill when a task matches its description." followed by an `<available_skills>` block with, for this arm, one entry:
  `<name>team-playbook</name>`, `<description>Conventions this team's CI and reviewers enforce, learned from past sessions.
  Apply them to related work.</description>`, `<location>file://.../.altimate-code/skills/team-playbook/SKILL.md</location>`.
- `tool/skill.ts` also embeds the same `<available_skills>` listing in the `skill` tool's description.
- The body (the 4 bullets) only enters context if the model calls the `skill` tool with `name: "team-playbook"`; the
  result is a `<skill_content name="team-playbook">` block. No `<auto_loaded_skill>` wrapper appears, so the harness's
  `playbook_in_context` probe is expected to be False for this arm; use the trace's `skill` tool span instead (analyze.py does).
- The description is generic (does not mention staging/dbt), so whether the model pulls it is the thing being measured.
- Agent permission `skill: deny` would suppress the whole section; the harness config only denies `external_directory`.
"""


def main():
    os.makedirs(ARMS, exist_ok=True)
    front, header, real = parse_final(REAL_FILE)
    dis = [json.loads(l) for l in open(os.path.join(HERE, "distractors.jsonl")) if l.strip()]
    real_ids = {re.match(r"- \[(L-[0-9a-f]+)\]", b).group(1) for b in real}
    assert len(dis) >= 96 and not real_ids & {d["id"] for d in dis} and len({d["id"] for d in dis}) == len(dis)
    # non-near distractors must not match project files; near ones must
    files, src = workdir_files()
    matches = lambda d: [f for f in files if any(glob_re(g).match(f) for g in d["trigger"])]
    for d in dis:
        hit = bool(matches(d))
        if hit != bool(d.get("near")):
            print(f"WARNING {d['id']} near={bool(d.get('near'))} but project match={hit}: {d['trigger']}", file=sys.stderr)

    stats = {}
    for n in (25, 50, 100):
        stats[f"n{n}"] = write(f"n{n}.md", front, header, spread(real, dis, n))
    sel = [d for d in dis if matches(d)][: TIERED_CAP - 4]
    stats["tiered"] = write("tiered.md", front, header, real + [bullet(d) for d in sel])
    json.dump({"file_list_source": src, "files": files, "cap": TIERED_CAP,
               "selected": [{"id": d["id"], "trigger": d["trigger"], "near": bool(d.get("near")),
                             "matched": matches(d)[:5]} for d in sel]},
              open(os.path.join(ARMS, "tiered-selection.json"), "w"), indent=1)
    stats["pull"] = write("pull.md", PULL_FRONT, header, real)
    open(os.path.join(ARMS, "pull-note.md"), "w").write(PULL_NOTE)
    for k, (n, b) in stats.items():
        print(f"{k:8} bullets={n:3d} bytes={b}")


if __name__ == "__main__":
    main()
