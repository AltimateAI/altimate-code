"""Publish a run's promoted playbook as A with `skill publish --replace`, then verify as B.

usage: publish_replace.py runs/<run_id>

For a run whose loop publish stopped on "published from somewhere else" (a fresh HOME has no publish
ledger for the workspace's existing same-name skill). Records a `publish` row in loop.jsonl.
"""
import json
import os
import sys

import common as C


def main(run_dir):
    maint = os.path.join(run_dir, "work", "maint")
    final = open(os.path.join(run_dir, "playbooks", "final.md")).read()
    promoted = open(os.path.join(maint, ".altimate-code", "skills", C.PLAYBOOK_NAME, "SKILL.md")).read()
    assert promoted.strip() == final.strip(), "maintainer's promoted playbook differs from playbooks/final.md"
    # Inside the backend context: it installs each user's credentials into their isolated HOME.
    with C.Backend(run_dir, "saas", 17) as be:
        p = C.altimate(["skill", "publish", C.PLAYBOOK_NAME, "--replace"], maint, C.user_env(run_dir, "a", workspace=True))
        out = (p.stdout + p.stderr).strip()
        print(f"publish --replace rc={p.returncode}: {out[-300:]}")
        rec = {"type": "publish", "via": "skill publish --replace", "rc": p.returncode, "output": out[-400:],
               "local_promoted_sha": C.sha(final.strip() + "\n")}
        sk = be.published_skill("b", C.PLAYBOOK_NAME)
        rec["as_b"] = {k: sk.get(k) for k in ("found", "public_id", "sha", "updated_at")}
        rec["backend_content_matches_promoted"] = bool(sk.get("found")) and (sk.get("content") or "").strip() == final.strip()
        print(f"as B: found={sk.get('found')} content-matches={rec['backend_content_matches_promoted']} sha={sk.get('sha')}")
    with open(os.path.join(run_dir, "loop.jsonl"), "a") as f:
        f.write(json.dumps(rec) + "\n")
    return 0 if p.returncode == 0 and rec.get("backend_content_matches_promoted", True) else 1


if __name__ == "__main__":
    # Absolute: the run dir becomes each user's HOME, and a relative HOME leaves the CLI without credentials.
    sys.exit(main(os.path.abspath(sys.argv[1])))
