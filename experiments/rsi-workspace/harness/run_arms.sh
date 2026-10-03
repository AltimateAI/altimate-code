#!/usr/bin/env bash
# Steps 3-7 of run_all.sh against an existing run dir whose loop already finished (e.g. after a
# post-publish verification stop). usage: run_arms.sh <run_id>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
source "$HERE/shell_common.sh"
RID="${1:?usage: run_arms.sh <run_id>}"
validate_id "$RID"
RD="$HERE/runs/$RID"
backend_args
RUNS="${RUNS:-3}"; PARALLEL="${PARALLEL:-4}"; SPLITS="${SPLITS:-heldout,control}"
ev() { python3 eval.py --run-dir "$RD" --split "$SPLITS" --runs "$RUNS" --parallel "$PARALLEL" "${WS_ARGS[@]}" "$@"; }
[ -f "$RD/playbooks/final.md" ] || { echo "no final playbook in $RD"; exit 1; }
ev --arm "playbook:$RD/playbooks/final.md" --label learned --out "$RD/eval/learned.jsonl"
ev --arm workspace-B --out "$RD/eval/workspace-B.jsonl"
ev --arm gold --out "$RD/eval/gold.jsonl"
python3 ablation.py --run-dir "$RD" --parallel "$PARALLEL"
ev --arm "playbook:$RD/playbook-nofeedback.md" --label nofeedback --out "$RD/eval/nofeedback.jsonl"
python3 report.py "$RD"
echo "report: $RD/report.md"
