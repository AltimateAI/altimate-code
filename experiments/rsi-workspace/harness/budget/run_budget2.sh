#!/usr/bin/env bash
# Rule-budget experiment: same tasks, model and verifier as runs/corr-main; the N=4 arm is corr-main's corrections-learned.
set -uo pipefail
cd "$(dirname "$0")/.."
RD="${RD:-runs/budget}"
mkdir -p "$RD/eval"
for arm in ${ARMS:-conflict overgeneral applicable40}; do
  echo "=== $arm $(date +%H:%M:%S)"
  python3 eval.py --run-dir "$RD" --split heldout,control --runs 3 --parallel 4 \
    --arm "playbook:budget/arms/$arm.md" --label "$arm" --out "$RD/eval/$arm.jsonl" || echo "ARM FAILED: $arm"
done
echo "=== done $(date +%H:%M:%S)"
