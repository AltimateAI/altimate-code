#!/usr/bin/env bash
# Replacement step + implicit supersede (rsi-fix worktree) vs current code.
set -euo pipefail
cd "$(dirname "$0")/.."
pids=()
STRONG="${STRONG_MODEL:-google-vertex/gemini-3.1-pro-preview}"
WEAK="${WEAK_MODEL:-google-vertex/gemini-3.1-flash-lite}"
FIX="${FIX_SRC_ROOT:?set FIX_SRC_ROOT to the checkout containing the drift fixes}"
[ -f "$FIX/packages/opencode/src/index.ts" ] || { echo "invalid FIX_SRC_ROOT" >&2; exit 2; }
bash budget/run_drift.sh g2-fix-weak-1 "$WEAK" "$FIX" > runs-g2-fix-weak-1.log 2>&1 &
pids+=("$!")
sleep 30
bash budget/run_drift.sh g2-fix-weak-2 "$WEAK" "$FIX" > runs-g2-fix-weak-2.log 2>&1 &
pids+=("$!")
sleep 30
bash budget/run_drift.sh g2-base-weak-2 "$WEAK" > runs-g2-base-weak-2.log 2>&1 &
pids+=("$!")
sleep 30
bash budget/run_drift.sh g2-fix-strong "$STRONG" "$FIX" > runs-g2-fix-strong.log 2>&1 &
pids+=("$!")
failed=0
for pid in "${pids[@]}"; do wait "$pid" || failed=1; done
[ "$failed" -eq 0 ] || exit "$failed"
echo "=== matrix2 done"
