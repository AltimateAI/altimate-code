#!/usr/bin/env bash
# v1 benchmark items 1-3 that need no new product features: run on the pre-change code
# (worktree rsi-base) so in-progress product edits cannot leak in. Gemini agent (Claude on
# Vertex is blocked by org policy since 2026-10-01).
set -uo pipefail
cd "$(dirname "$0")/.."
RD="${RD:-runs/v1-baselines}"
export AGENT_MODEL="${AGENT_MODEL:-google-vertex/gemini-3.5-flash}"
export ALTIMATE_CMD="bun run --conditions=browser /Users/anandgupta/codebase/altimate-code/.claude/worktrees/rsi-base/packages/opencode/src/index.ts"
mkdir -p "$RD/eval"
run_arm() { # label arm
  echo "=== $1 $(date +%H:%M:%S)"
  python3 eval.py --run-dir "$RD" --split heldout,control --runs 3 --parallel 4 \
    --arm "$2" --label "$1" --out "$RD/eval/$1.jsonl" || echo "ARM FAILED: $1"
  # environment watchdog: runs that made zero tool calls mean the install or worktree vanished
  if [ "$(grep -c '"tool_calls": 0' "$RD/eval/$1.jsonl" 2>/dev/null)" -ge 3 ]; then echo "ENV-BROKEN in $1: stopping"; exit 3; fi
}
for pb in ${ARMS:-n50-short all-50 all-300 all-1000}; do
  run_arm "$pb" "playbook:v1bench/playbooks/$pb.md"
done
echo "=== done $(date +%H:%M:%S)"
