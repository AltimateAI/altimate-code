#!/usr/bin/env bash
# Corrections-only RSI experiment. usage: run_corrections.sh <run_id>
# loop (teammate corrections, no verifier in training) -> final arms -> rescore -> report.
# env: K (iterations, 2) PARALLEL (4) RUNS (final-arm runs, 3) SPLITS (heldout,control) BACKEND (saas; explicit opt-in required) WORKSPACE_ID (required for saas)
#      BASELINE_FROM (default empty: evaluate a fresh baseline; explicitly set to an existing file to reuse)
#      TRAIN_LIMIT (tasks, default all 4) ALTIMATE_CMD DBT_BIN AGENT_MODEL REFLECTOR_MODEL REVIEWER_MODEL
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
source "$HERE/shell_common.sh"
RUN_ID="${1:?usage: run_corrections.sh <run_id>}"
BASELINE_FROM="${BASELINE_FROM:-}"
if [ -n "$BASELINE_FROM" ] && [ ! -f "$BASELINE_FROM" ]; then
  echo "BASELINE_FROM file does not exist or is not a regular file: $BASELINE_FROM" >&2
  exit 2
fi
WORKSPACE_ID="${WORKSPACE_ID:-}"
backend_args
python3 -c "import common; common.require_learn(); common.require_dbt()"
fresh_run "$RUN_ID"
K="${K:-2}"; PARALLEL="${PARALLEL:-4}"; RUNS="${RUNS:-3}"; SPLITS="${SPLITS:-heldout,control}"
RD="$HERE/runs/$RUN_ID"
echo "run dir: $RD"
LIMIT_ARGS=(); [ -n "${TRAIN_LIMIT:-}" ] && LIMIT_ARGS=(--train-limit "$TRAIN_LIMIT")
ev() { python3 eval.py --run-dir "$RD" --split "$SPLITS" --runs "$RUNS" --parallel "$PARALLEL" "${WS_ARGS[@]}" "$@"; }

# Optional reuse retains source workdir/trace paths for rescore.py.
if [ -n "$BASELINE_FROM" ]; then cp "$BASELINE_FROM" "$RD/eval/none.jsonl"; else ev --arm none --out "$RD/eval/none.jsonl"; fi
# 1. corrections-only loop: train with capture, teammate reviews, learn reflect --session, maintainer approval, publish as A
python3 loop_corrections.py --run-dir "$RD" --iterations "$K" --parallel "$PARALLEL" "${WS_ARGS[@]}" ${LIMIT_ARGS[@]+"${LIMIT_ARGS[@]}"}
# 2. final arms on heldout+control: the learned playbook installed locally, and B receiving it by workspace sync
[ -f "$RD/playbooks/final.md" ] || { echo "nothing promoted: no final arms"; exit 1; }
ev --arm "playbook:$RD/playbooks/final.md" --label corrections-learned --out "$RD/eval/corrections-learned.jsonl"
ev --arm workspace-B --label corrections-workspace-B --out "$RD/eval/corrections-workspace-B.jsonl"
# 3. integrity rescan, 4. report
python3 rescore.py "$RD"
python3 report_corrections.py "$RD"
echo "report: $RD/report-corrections.md"
