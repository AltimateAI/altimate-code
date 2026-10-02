#!/usr/bin/env bash
# Replacement step + implicit supersede (rsi-fix worktree) vs current code.
cd "$(dirname "$0")/.."
STRONG=google-vertex/gemini-3.1-pro-preview
WEAK=google-vertex/gemini-3.1-flash-lite
FIX=/Users/anandgupta/codebase/altimate-code/.claude/worktrees/rsi-fix
bash budget/run_drift.sh g2-fix-weak-1 "$WEAK" "$FIX" > runs-g2-fix-weak-1.log 2>&1 &
sleep 30
bash budget/run_drift.sh g2-fix-weak-2 "$WEAK" "$FIX" > runs-g2-fix-weak-2.log 2>&1 &
sleep 30
bash budget/run_drift.sh g2-base-weak-2 "$WEAK" > runs-g2-base-weak-2.log 2>&1 &
sleep 30
bash budget/run_drift.sh g2-fix-strong "$STRONG" "$FIX" > runs-g2-fix-strong.log 2>&1 &
wait
echo "=== matrix2 done"
