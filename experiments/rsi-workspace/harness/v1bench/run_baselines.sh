#!/usr/bin/env bash
# Whole-playbook baselines need no learn features. ALTIMATE_CMD may select a baseline checkout.
# Claude access may be blocked by organization policy; set AGENT_MODEL to an accessible model.
set -uo pipefail
cd "$(dirname "$0")/.."
RD="${RD:-runs/v1-baselines}"
RUNS="${RUNS:-3}"; PARALLEL="${PARALLEL:-4}"
export AGENT_MODEL="${AGENT_MODEL:-google-vertex/gemini-3.5-flash}"
export ALTIMATE_CMD="${ALTIMATE_CMD:?set ALTIMATE_CMD to run the pre-v1 baseline checkout (commit 099ea68c90), e.g. bun run --conditions=browser <checkout>/packages/opencode/src/index.ts}"
mkdir -p "$RD/eval"
failed=0
run_arm() { # label arm
  python3 -c 'import common,sys; common.validate_id(sys.argv[1], "arm label")' "$1" || return 1
  echo "=== $1 $(date +%H:%M:%S)"
  # eval.py safely replaces the previous batch, including interrupted partial output.
  python3 eval.py --run-dir "$RD" --split heldout,control --runs "$RUNS" --parallel "$PARALLEL" \
    --arm "$2" --label "$1" --out "$RD/eval/$1.jsonl"
  rc=$?
  if [ "$rc" -ne 0 ]; then echo "ARM FAILED: $1 (rc $rc)"; failed=1; fi
  python3 - "$RD/eval/$1.jsonl" <<'PYWD'
import sys
from v1bench.lib import Watchdog
import common as C
wd = Watchdog()
for rec in C.read_jsonl(sys.argv[1]):
    wd.note(rec)
sys.exit(3 if wd.tripped else 0)
PYWD
  rc=$?
  if [ "$rc" -eq 3 ]; then echo "ENV-BROKEN in $1: stopping"; exit 3; fi
  if [ "$rc" -ne 0 ]; then failed=1; fi
}
for pb in ${ARMS:-n50-short all-50 all-300 all-1000}; do
  case "$pb" in
    none) arm=none ;;
    real4) arm=playbook:v1bench/playbooks/real4-long.md ;;
    *) arm="playbook:v1bench/playbooks/$pb.md" ;;
  esac
  run_arm "$pb" "$arm" || failed=1
done
if [ "$failed" -eq 0 ]; then echo "=== done $(date +%H:%M:%S)"; fi
exit "$failed"
