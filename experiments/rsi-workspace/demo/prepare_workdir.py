#!/usr/bin/env python3
"""prepare_workdir.py <task_id> <dest>

Copy project/ into a fresh dir, init a repo with a fixed fake remote, commit,
and run `dbt seed`. Idempotent: an existing dest previously created by this
script (marker file) is rebuilt from scratch; any other non-empty dest is refused.
Env: DBT_BIN (default documented in README.md). Prints the task prompt.
"""
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.join(HERE, "project")
MARKER = ".prepared"
DBT_BIN = os.environ.get(
    "DBT_BIN",
    "/private/tmp/claude-501/-Users-anandgupta-codebase-altimate-code/"
    "5e228db8-69ac-4824-86f1-4a9ad4ff2e5c/scratchpad/dbtenv/bin/dbt",
)
GIT_ENV = {
    "GIT_AUTHOR_NAME": "Acme Dev", "GIT_AUTHOR_EMAIL": "dev@acme.example",
    "GIT_COMMITTER_NAME": "Acme Dev", "GIT_COMMITTER_EMAIL": "dev@acme.example",
    "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z", "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z",
}


def sh(cmd, cwd, env=None):
    p = subprocess.run(cmd, cwd=cwd, env=dict(os.environ, **(env or {})), capture_output=True, text=True)
    if p.returncode != 0:
        sys.exit(f"command failed: {' '.join(cmd)}\n{p.stdout}{p.stderr}")


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    task_id, dest = sys.argv[1], os.path.abspath(sys.argv[2])
    tpath = os.path.join(HERE, "verifier", "tasks", task_id + ".json")
    if not os.path.isfile(tpath):
        sys.exit(f"unknown task {task_id}")
    task = json.load(open(tpath))
    if os.path.exists(dest):
        if os.path.isfile(os.path.join(dest, MARKER)) or (os.path.isdir(dest) and not os.listdir(dest)):
            shutil.rmtree(dest)
        else:
            sys.exit(f"refusing to overwrite {dest}: not created by prepare_workdir.py")
    shutil.copytree(PROJECT, dest, ignore=shutil.ignore_patterns("target", "logs", "*.duckdb", "*.duckdb.wal", ".user.yml"))
    open(os.path.join(dest, MARKER), "w").write(task_id + "\n")
    with open(os.path.join(dest, ".gitignore"), "a") as f:
        f.write(MARKER + "\n")
    sh(["git", "init", "-q", "-b", "main"], dest)
    sh(["git", "remote", "add", "origin", "git@github.com:acme/acme-shop.git"], dest)
    sh(["git", "add", "-A"], dest)
    sh(["git", "commit", "-q", "-m", "chore: initial acme-shop dbt project"], dest, GIT_ENV)
    sh([DBT_BIN, "seed", "--profiles-dir", dest, "--project-dir", dest], dest,
       {"DBT_SEND_ANONYMOUS_USAGE_STATS": "false", "DO_NOT_TRACK": "1"})
    print(f"workdir ready: {dest}")
    print(f"task {task_id} ({task['split']}): {task['prompt']}")


if __name__ == "__main__":
    main()
