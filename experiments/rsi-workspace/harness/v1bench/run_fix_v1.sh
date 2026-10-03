#!/usr/bin/env bash
# Re-run the arms affected by the scope-rendering and file-hook-ranking fix (commit c6c86a5395)
# into runs/v1-fix-*, for a before/after comparison with runs/v1-scale, v1-vague, v1-topic.
cd "$(dirname "$0")/.."
V=v1bench; RUNS=3; PARALLEL=4
export AGENT_MODEL="${AGENT_MODEL:-google-vertex/gemini-3.5-flash}"
export ALTIMATE_CMD="bun run --conditions=browser /Users/anandgupta/codebase/altimate-code/.claude/worktrees/rsi/packages/opencode/src/index.ts"
nrec() { [ -f "$1" ] && wc -l < "$1" || echo 0; }
guard() { if [ "$1" = "3" ]; then echo "ENV-BROKEN in $2: stopping"; exit 3; fi; }
eval_arm() { local rd="$1" label="$2" arm="$3"; mkdir -p "$rd/eval"
  if [ "$(nrec "$rd/eval/$label.jsonl")" -ge $((6 * RUNS)) ]; then echo "=== skip $label (done)"; return; fi
  echo "=== $label $(date +%H:%M:%S)"
  python3 "$V/eval_v1.py" --run-dir "$rd" --runs "$RUNS" --parallel "$PARALLEL" --arm "$arm" --label "$label" --out "$rd/eval/$label.jsonl"
  guard $? "$label"; }
topic_arm() { local rd="$1" label="$2" arm="$3"; mkdir -p "$rd/eval"
  if [ "$(nrec "$rd/eval/$label.jsonl")" -ge 18 ]; then echo "=== skip $label (done)"; return; fi
  echo "=== topic $label $(date +%H:%M:%S)"
  python3 "$V/topic_switch/run_topic_switch.py" --run-dir "$rd" --parallel "$PARALLEL" --arm "$arm" --label "$label" --out "$rd/eval/$label.jsonl"
  guard $? "$label"; }
P300=$V/pool-300.jsonl; P1000=$V/lessons-1000.jsonl
eval_arm runs/v1-fix-scale tiered-300  "lessons:$P300;core=0;retrieved=15"
eval_arm runs/v1-fix-scale tiered-1000 "lessons:$P1000;core=0;retrieved=15"
eval_arm runs/v1-fix-vague vague-hook  "vague:$P300;core=0;retrieved=15;filehook=1"
topic_arm runs/v1-fix-topic per-request "lessons:$P300;core=0;retrieved=15;request=5;filehook=0"
echo "=== done $(date +%H:%M:%S)"
