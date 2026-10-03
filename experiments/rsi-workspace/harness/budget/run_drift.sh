#!/usr/bin/env bash
# Drift experiment: start from an outdated playbook (budget/arms/stale-seed.md), learn from teammate corrections,
# then evaluate the final playbook. usage: run_drift.sh <run_id> <reflector_model> [altimate_src_root]
set -uo pipefail
cd "$(dirname "$0")/.."
RID="$1"; REFL="$2"; SRC="${3:-}"
RD="runs/$RID"
export REVIEWER_MODEL="google-vertex/gemini-3.1-pro-preview" REFLECTOR_MODEL="$REFL" REVIEWER_MAX_TURNS=20
export AGENT_MODEL="${AGENT_MODEL:-google-vertex/gemini-3.5-flash}"
[ -n "$SRC" ] && export ALTIMATE_CMD="bun run --conditions=browser $SRC/packages/opencode/src/index.ts"
rm -rf "$RD"
python3 loop_corrections.py --run-dir "$RD" --iterations 2 --parallel 4 --no-publish --workspace-id 17 \
  --seed-playbook budget/arms/stale-seed.md || echo "LOOP FAILED"
mkdir -p "$RD/eval"
python3 eval.py --run-dir "$RD" --split heldout,control --runs 3 --parallel 4 \
  --arm "playbook:$RD/playbooks/final.md" --label "$RID" --out "$RD/eval/$RID.jsonl" || echo "EVAL FAILED"
echo "=== done $RID"
