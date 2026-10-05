#!/usr/bin/env python3
"""prepare_workdir.py <task_id> <dest>

Copy project/ into a fresh dir, init a repo with a fixed fake remote, commit,
and run `dbt seed`. Idempotent: an existing dest previously created by this
script (marker file and matching git repository/origin) is rebuilt from scratch;
any other non-empty dest is refused.
Env: DBT_BIN (default documented in README.md). Prints the task prompt.
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.join(HERE, "project")
MARKER = ".prepared"
REMOTE = "git@github.com:acme/acme-shop.git"
DBT_BIN = os.environ.get("DBT_BIN") or shutil.which("dbt") or "dbt"
GIT_ENV = {
    "GIT_AUTHOR_NAME": "Acme Dev", "GIT_AUTHOR_EMAIL": "dev@acme.example",
    "GIT_COMMITTER_NAME": "Acme Dev", "GIT_COMMITTER_EMAIL": "dev@acme.example",
    "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z", "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z",
}


def sh(cmd, cwd, env=None):
    p = subprocess.run(cmd, cwd=cwd, env=dict(os.environ, **(env or {})), capture_output=True, text=True)
    if p.returncode != 0:
        sys.exit(f"command failed: {' '.join(cmd)}\n{p.stdout}{p.stderr}")


def validate_destination(raw):
    if not raw or raw.strip() in ("", ".", ".."):
        raise ValueError("destination must be an explicit work directory")
    path = Path(raw).absolute()
    if path.is_symlink() or ".." in Path(raw).parts:
        raise ValueError("destination must not be a symlink or contain traversal components")
    dest = path.resolve()
    project = Path(PROJECT).resolve()
    if dest == project or project in dest.parents or dest in project.parents:
        raise ValueError("destination must be outside project/ and must not contain it")
    if dest == Path.home().resolve() or dest in Path.cwd().resolve().parents or dest == Path.cwd().resolve():
        raise ValueError("refusing to overwrite home or the current directory or its ancestors")
    return str(dest)


def prepared_task(dest):
    marker = Path(dest) / MARKER
    if marker.is_symlink() or not marker.is_file():
        return False
    task_id = marker.read_text().strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]+", task_id):
        return False
    task_path = Path(HERE) / "verifier" / "tasks" / (task_id + ".json")
    return task_path.is_file() and json.loads(task_path.read_text()).get("id") == task_id


def prepared_workdir(dest):
    if not prepared_task(dest):
        return False
    root = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=dest,
                          capture_output=True, text=True)
    if root.returncode or Path(root.stdout.strip()).resolve() != Path(dest).resolve():
        return False
    origin = subprocess.run(["git", "config", "--local", "--get", "remote.origin.url"], cwd=dest,
                            capture_output=True, text=True)
    return origin.returncode == 0 and origin.stdout.strip() == REMOTE


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    task_id = sys.argv[1]
    if not re.fullmatch(r"[A-Za-z0-9_-]+", task_id):
        sys.exit("invalid task id")
    try:
        dest = validate_destination(sys.argv[2])
    except ValueError as e:
        sys.exit(str(e))
    tpath = os.path.join(HERE, "verifier", "tasks", task_id + ".json")
    if not os.path.isfile(tpath):
        sys.exit(f"unknown task {task_id}")
    task = json.load(open(tpath))
    if os.path.exists(dest):
        if os.path.isdir(dest) and (not os.listdir(dest) or prepared_workdir(dest)):
            shutil.rmtree(dest)
        else:
            sys.exit(f"refusing to overwrite {dest}: non-empty destinations require a valid {MARKER} "
                     f"marker and a git repository rooted here with origin {REMOTE}")
    shutil.copytree(PROJECT, dest, ignore=shutil.ignore_patterns("target", "logs", "*.duckdb", "*.duckdb.wal", ".user.yml"))
    open(os.path.join(dest, MARKER), "w").write(task_id + "\n")
    with open(os.path.join(dest, ".gitignore"), "a") as f:
        f.write(MARKER + "\n")
    sh(["git", "init", "-q", "-b", "main"], dest)
    sh(["git", "remote", "add", "origin", REMOTE], dest)
    sh(["git", "add", "-A"], dest)
    sh(["git", "commit", "-q", "-m", "chore: initial acme-shop dbt project"], dest, GIT_ENV)
    sh([DBT_BIN, "seed", "--profiles-dir", dest, "--project-dir", dest], dest,
       {"DBT_SEND_ANONYMOUS_USAGE_STATS": "false", "DO_NOT_TRACK": "1"})
    print(f"workdir ready: {dest}")
    print(f"task {task_id} ({task['split']}): {task['prompt']}")


if __name__ == "__main__":
    main()
