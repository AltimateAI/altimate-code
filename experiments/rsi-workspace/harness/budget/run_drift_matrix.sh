#!/usr/bin/env bash
# Base vs supersede-guard, strong vs weak reflector. Staggered so per-user DB migrations don't race.
set -euo pipefail
cd "$(dirname "$0")/.."
pids=()
STRONG="${STRONG_MODEL:-google-vertex/gemini-3.1-pro-preview}"
WEAK="${WEAK_MODEL:-google-vertex/gemini-3.1-flash-lite}"
FIX="${FIX_SRC_ROOT:?set FIX_SRC_ROOT to the checkout containing the fix variant}"
[ -f "$FIX/packages/opencode/src/index.ts" ] || { echo "invalid FIX_SRC_ROOT" >&2; exit 2; }
bash budget/run_drift.sh g-base-strong "$STRONG" > runs-g-base-strong.log 2>&1 &
pids+=("$!")
sleep 30
bash budget/run_drift.sh g-fix-strong "$STRONG" "$FIX" > runs-g-fix-strong.log 2>&1 &
pids+=("$!")
sleep 30
bash budget/run_drift.sh g-base-weak "$WEAK" > runs-g-base-weak.log 2>&1 &
pids+=("$!")
sleep 30
bash budget/run_drift.sh g-fix-weak "$WEAK" "$FIX" > runs-g-fix-weak.log 2>&1 &
pids+=("$!")
failed=0
for pid in "${pids[@]}"; do wait "$pid" || failed=1; done
[ "$failed" -eq 0 ] || exit "$failed"
echo "=== matrix done"
