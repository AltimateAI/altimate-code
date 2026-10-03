#!/usr/bin/env bash
# Base vs supersede-guard, strong vs weak reflector. Staggered so per-user DB migrations don't race.
cd "$(dirname "$0")/.."
STRONG=google-vertex/gemini-3.1-pro-preview
WEAK=google-vertex/gemini-3.1-flash-lite
FIX=/Users/anandgupta/codebase/altimate-code/.claude/worktrees/rsi-fix
bash budget/run_drift.sh g-base-strong "$STRONG" > runs-g-base-strong.log 2>&1 &
sleep 30
bash budget/run_drift.sh g-fix-strong "$STRONG" "$FIX" > runs-g-fix-strong.log 2>&1 &
sleep 30
bash budget/run_drift.sh g-base-weak "$WEAK" > runs-g-base-weak.log 2>&1 &
sleep 30
bash budget/run_drift.sh g-fix-weak "$WEAK" "$FIX" > runs-g-fix-weak.log 2>&1 &
wait
echo "=== matrix done"
