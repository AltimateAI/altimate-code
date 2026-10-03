#!/usr/bin/env bash
# The whole RSI experiment. usage: run_all.sh [run_id]
# env: RUNS (final-arm runs, 3) K (loop iterations, 2) RUNS_VAL (2) PARALLEL (4) SPLITS (heldout,control)
#      BACKEND (fake by default) WORKSPACE_ID (required for opted-in SaaS)
#      ALTIMATE_CMD DBT_BIN AGENT_MODEL REFLECTOR_MODEL (see common.py)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
source "$HERE/shell_common.sh"
RUN_ID="${1-$(new_run_id)}"
backend_args
python3 -c "import common; common.require_learn(); common.require_dbt()"
fresh_run "$RUN_ID"
RUNS="${RUNS:-3}"; K="${K:-2}"; RUNS_VAL="${RUNS_VAL:-2}"; PARALLEL="${PARALLEL:-4}"; SPLITS="${SPLITS:-heldout,control}"
RD="$HERE/runs/$RUN_ID"
echo "run dir: $RD"
ev() { python3 eval.py --run-dir "$RD" --split "$SPLITS" --runs "$RUNS" --parallel "$PARALLEL" "${WS_ARGS[@]}" "$@"; }

# 1. baseline, before anything is published (BASELINE_FROM=<file> reuses an earlier baseline of the same tasks)
if [ -n "${BASELINE_FROM:-}" ]; then cp "$BASELINE_FROM" "$RD/eval/none.jsonl"; else ev --arm none --out "$RD/eval/none.jsonl"; fi
# 2. the autonomous loop (trains on train, gates on val, publishes the promoted playbook as A)
python3 loop.py --run-dir "$RD" --iterations "$K" --runs-val "$RUNS_VAL" --parallel "$PARALLEL" "${WS_ARGS[@]}"
# 3. learned playbook installed locally, then 4. the same playbook arriving through the workspace sync
if [ -f "$RD/playbooks/final.md" ]; then
  ev --arm "playbook:$RD/playbooks/final.md" --label learned --out "$RD/eval/learned.jsonl"
  ev --arm workspace-B --out "$RD/eval/workspace-B.jsonl"
else
  echo "nothing promoted: skipping learned and workspace-B arms"
fi
# 5. gold playbook (upper bound)
ev --arm gold --out "$RD/eval/gold.jsonl"
# 6. no-feedback ablation, then its playbook on the same tasks
python3 ablation.py --run-dir "$RD" --parallel "$PARALLEL"
ev --arm "playbook:$RD/playbook-nofeedback.md" --label nofeedback --out "$RD/eval/nofeedback.jsonl"
# 7. report
python3 report.py "$RD"
echo "report: $RD/report.md"
