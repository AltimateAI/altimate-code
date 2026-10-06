#!/usr/bin/env bash
# Rule-budget experiment: same tasks, model and verifier as runs/corr-main; the N=4 arm is corr-main's corrections-learned.
set -euo pipefail
cd "$(dirname "$0")/.."
source ./shell_common.sh
backend_args
RD="${RD:-runs/budget}"
failed=0
mkdir -p "$RD/eval"
for arm in n25 n50 n100 tiered pull; do
  validate_id "$arm"
  echo "=== $arm $(date +%H:%M:%S)"
  python3 eval.py --run-dir "$RD" --split heldout,control --runs 3 --parallel 4 \
    "${WS_ARGS[@]}" --arm "playbook:budget/arms/$arm.md" --label "$arm" --out "$RD/eval/$arm.jsonl" || { echo "ARM FAILED: $arm"; failed=1; }
done
[ "$failed" -eq 0 ] && echo "=== done $(date +%H:%M:%S)"
exit "$failed"
