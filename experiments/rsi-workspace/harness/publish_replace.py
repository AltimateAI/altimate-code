"""Publish/update a run's approved playbook and verify workspace delivery as B.

Usage: publish_replace.py runs/<run_id> [--backend fake|saas] [--workspace-id ID]
The workspace ID must be supplied by --workspace-id or WORKSPACE_ID.
SaaS also requires ALLOW_REAL_SAAS=1 and SAAS_CREDS_DIR. No --replace CLI flag is used.
"""
import argparse
import os

import common as C
from loop import export_approved
from loop_corrections import publish


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("run_dir")
    ap.add_argument("--backend", choices=["fake", "saas"], default="saas")
    ap.add_argument("--workspace-id", type=int, default=os.environ.get("WORKSPACE_ID"))
    a = ap.parse_args()
    if a.workspace_id is None:
        ap.error("provide --workspace-id or set WORKSPACE_ID")
    run_dir = os.path.abspath(a.run_dir)
    maint = os.path.join(run_dir, "work", "maint")
    final = open(os.path.join(run_dir, "playbooks", "final.md")).read()
    promoted = export_approved(maint)
    if not promoted or promoted.strip() != final.strip():
        raise SystemExit("approved lessons differ from playbooks/final.md")
    with C.Backend(run_dir, a.backend, a.workspace_id) as be:
        publish(run_dir, be, maint, final, None, os.path.join(run_dir, "loop.jsonl"))


if __name__ == "__main__":
    main()
