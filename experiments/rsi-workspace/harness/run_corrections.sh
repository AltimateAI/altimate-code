#!/usr/bin/env bash
# Corrections-only RSI experiment. usage: run_corrections.sh <run_id>
# loop (teammate corrections, no verifier in training) -> final arms -> rescore -> report.
# env: K (iterations, 2) PARALLEL (4) RUNS (final-arm runs, 3) SPLITS (heldout,control) BACKEND (saas) WORKSPACE_ID (17)
#      BASELINE_FROM (default runs/saas-v2/eval/none.jsonl, reused: same tasks, model and verifier)
#      TRAIN_LIMIT (tasks, default all 4) ALTIMATE_CMD DBT_BIN AGENT_MODEL REFLECTOR_MODEL REVIEWER_MODEL
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
RUN_ID="${1:?usage: run_corrections.sh <run_id>}"
K="${K:-2}"; PARALLEL="${PARALLEL:-4}"; RUNS="${RUNS:-3}"; SPLITS="${SPLITS:-heldout,control}"
BACKEND="${BACKEND:-saas}"; WORKSPACE_ID="${WORKSPACE_ID:-17}"
BASELINE_FROM="${BASELINE_FROM:-$HERE/runs/saas-v2/eval/none.jsonl}"
RD="$HERE/runs/$RUN_ID"
mkdir -p "$RD/eval"
echo "run dir: $RD"
WS_ARGS=(--backend "$BACKEND" --workspace-id "$WORKSPACE_ID")
LIMIT_ARGS=(); [ -n "${TRAIN_LIMIT:-}" ] && LIMIT_ARGS=(--train-limit "$TRAIN_LIMIT")
ev() { python3 eval.py --run-dir "$RD" --split "$SPLITS" --runs "$RUNS" --parallel "$PARALLEL" "${WS_ARGS[@]}" "$@"; }

# baseline: reused from saas-v2 (the report reads it from this run dir)
cp "$BASELINE_FROM" "$RD/eval/none.jsonl"
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
