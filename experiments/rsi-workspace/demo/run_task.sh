#!/usr/bin/env bash
# run_task.sh prepare <task_id> <dest>   fresh workdir for the agent (prints the ticket prompt)
# run_task.sh check   <task_id> <dest>   run the hidden CI on a workdir, prints JSON
# run_task.sh selftest [--all-gold|--all-naive]
# run_task.sh list                       task ids, splits, prompts
# DBT_BIN overrides the dbt binary (default documented in README.md).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cmd="${1:-}"; shift || true
case "$cmd" in
  prepare)  python3 "$here/prepare_workdir.py" "$@" ;;
  check)    python3 "$here/verifier/check.py" "$2" "$1" ;;
  selftest) python3 "$here/verifier/selftest.py" "$@" ;;
  list)     python3 - "$here" <<'EOF'
import json, glob, sys
for f in sorted(glob.glob(sys.argv[1] + "/verifier/tasks/*.json")):
    t = json.load(open(f)); print(f"{t['split']:8} {t['id']:28} {t['prompt']}")
EOF
  ;;
  *) sed -n '2,6p' "$0"; exit 2 ;;
esac
