#!/usr/bin/env bash
# Usage: run_drift.sh <run_id> <reflector_model> [altimate_src_root]
set -euo pipefail
cd "$(dirname "$0")/.."
source ./shell_common.sh
RID="${1:?run id required}"; REFL="${2:?reflector model required}"; SRC="${3:-}"
backend_args
validate_id "$RID"
RD="runs/$RID"
export AGENT_MODEL="${AGENT_MODEL:-google-vertex/gemini-3.5-flash}"
export REVIEWER_MODEL="${REVIEWER_MODEL:-$AGENT_MODEL}" REFLECTOR_MODEL="$REFL" REVIEWER_MAX_TURNS="${REVIEWER_MAX_TURNS:-20}"
if [ -n "$SRC" ]; then
  ALTIMATE_CMD="$(python3 - "$SRC" <<'PY_CMD'
import os, shlex, sys
entry = os.path.join(os.path.abspath(sys.argv[1]), 'packages/opencode/src/index.ts')
if not os.path.isfile(entry):
    raise SystemExit('source checkout has no CLI entrypoint: ' + entry)
print('bun run --conditions=browser ' + shlex.quote(entry))
PY_CMD
)"
  export ALTIMATE_CMD
fi
python3 -c "import common; common.require_learn(); common.require_dbt()"
fresh_run "$RID"
python3 loop_corrections.py --run-dir "$RD" --iterations 2 --parallel 4 --no-publish "${WS_ARGS[@]}" \
  --seed-playbook budget/arms/stale-seed.md
[ -f "$RD/playbooks/final.md" ] || { echo "no final playbook" >&2; exit 1; }
python3 eval.py --run-dir "$RD" --split heldout,control --runs 3 --parallel 4 "${WS_ARGS[@]}" \
  --arm "playbook:$RD/playbooks/final.md" --label "$RID" --out "$RD/eval/$RID.jsonl"
echo "=== done $RID"
