#!/usr/bin/env bash
# learn-v1 benchmark, PLAN.md items 2-7, on the NEW lesson store (approved.json, tiered selection, per-request
# additions, file hook, bootstrap). Items 1 (baselines) and the playbook-only part of 3 ran earlier in runs/v1-baselines.
# Item 8 (review import) is a hand-reviewed read-only run, not scripted here; item 9 comes from the tables.
#
# COST ESTIMATE (Gemini 3.5 flash agent, observed ~$0.65 per agent run in runs/v1-baselines; reviewer/reflector
# Gemini 3.1 pro/flash-lite as in budget/run_drift.sh):
#   item 2 scale        6 arms x 18 runs                      ~ $72
#   item 3 compression  4 arms x 18 runs                      ~ $48
#   item 4 topic switch 4 arms x 18 two-request sessions      ~ $84   (none arm ~ $21; turn 2 adds ~$0.5)
#   item 5 file hook    4 arms x 18 runs                      ~ $48
#   item 6 drift        stale baseline 18 runs ~$12 + 2 x (loop ~$13 + final eval 18 runs ~$12) ~ $62
#   item 7 bootstrap    reflection ~$1-2 + 18 runs ~$12       ~ $14
#   TOTAL ~ $330 (range $280-400); 26 arm-blocks of 18 runs/sessions; wall time ~ 15-20 h at --parallel 4
#   (each 18-run arm ~ 35 min; the baselines log shows ~130 s per run).
#
# usage: ALTIMATE_CMD='bun run --conditions=browser <rsi worktree>/packages/opencode/src/index.ts' ./run_all_v1.sh
# env:   ITEMS="2 3 4 5 6 7" (subset to run), RUNS=3 , PARALLEL=4, AGENT_MODEL, STRONG, WEAK, REVIEWER_MODEL, RD=runs (output root)
# Each arm is skipped only when its output has exactly the expected unique keys and completed turns; guarded by
# the watchdog: 3 runs with 0 tool calls (install or worktree vanished) stops everything with exit 3.
set -uo pipefail
cd "$(dirname "$0")/.."            # harness/
HARNESS="$PWD"
export AGENT_MODEL="${AGENT_MODEL:-google-vertex/gemini-3.5-flash}"
STRONG="${STRONG:-google-vertex/gemini-3.1-pro-preview}"
WEAK="${WEAK:-google-vertex/gemini-3.1-flash-lite}"
export REVIEWER_MODEL="${REVIEWER_MODEL:-google-vertex/gemini-3.1-pro-preview}" REVIEWER_MAX_TURNS=20
ITEMS="${ITEMS:-2 3 4 5 6 7}"
RUNS="${RUNS:-3}"; PARALLEL="${PARALLEL:-4}"
OUT="${RD:-runs}"
V=v1bench
P50="$V/pool-50.jsonl"; P300="$V/pool-300.jsonl"; P1000="$V/lessons-1000.jsonl"
ALWAYS_ON="$P1000;only=real;pin=real;core=4;retrieved=0"   # the 4 real lessons pinned: old always-loaded behaviour
want() { [[ " $ITEMS " == *" $1 "* ]]; }
complete() { python3 "$V/check_output.py" "$@"; }
guard() { # rc label
  if [ "$1" -eq 3 ]; then echo "ENV-BROKEN in $2: stopping"; exit 3; fi
  if [ "$1" -ne 0 ]; then echo "ARM FAILED: $2 (rc $1)"; exit "$1"; fi
  return 0
}

eval_arm() { # run-dir label arm [extra eval_v1 args]; 18 records = 6 tasks x RUNS
  local rd="$1" label="$2" arm="$3"; shift 3
  mkdir -p "$rd/eval"
  local kind=eval; [[ "$arm" == vague:* ]] && kind=vague
  if complete "$rd/eval/$label.jsonl" "$label" "$kind" "$RUNS"; then echo "=== skip $label (done)"; return; fi
  echo "=== $label $(date +%H:%M:%S)"
  python3 "$V/eval_v1.py" --run-dir "$rd" --runs "$RUNS" --parallel "$PARALLEL" --arm "$arm" --label "$label" \
    --out "$rd/eval/$label.jsonl" "$@"
  guard $? "$label"
}
topic_arm() { # run-dir label arm
  local rd="$1" label="$2" arm="$3"
  mkdir -p "$rd/eval"
  if complete "$rd/eval/$label.jsonl" "$label" topic; then echo "=== skip $label (done)"; return; fi
  echo "=== topic $label $(date +%H:%M:%S)"
  python3 "$V/topic_switch/run_topic_switch.py" --run-dir "$rd" --parallel "$PARALLEL" --arm "$arm" --label "$label" \
    --out "$rd/eval/$label.jsonl"
  guard $? "$label"
}

if want 2; then  # scale and retrieval: 4 relevant lessons hidden among N; retrieval only (core=0) unless noted
  rd="$OUT/v1-scale"
  eval_arm "$rd" tiered-50   "lessons:$P50;core=0;retrieved=15"
  eval_arm "$rd" tiered-300  "lessons:$P300;core=0;retrieved=15"
  eval_arm "$rd" tiered-1000 "lessons:$P1000;core=0;retrieved=15"
  eval_arm "$rd" tiered-300-defaults "lessons:$P300"                       # shipped defaults: core 15 (by id) + retrieved 15
  eval_arm "$rd" tiered-300-textonly "lessons:$P300;core=0;retrieved=15;nopaths"  # no trigger paths: text signal only
  eval_arm "$rd" all-300     "lessons:$P300;core=300;retrieved=0;budget=100000;session_max=300"  # load everything
fi

if want 3; then  # compression: same lessons, original vs <=140 chars (md playbooks: no trigger paths, text retrieval)
  rd="$OUT/v1-compress"
  eval_arm "$rd" n50-long   "lessons:$V/playbooks/n50-long.md;core=0;retrieved=15"
  eval_arm "$rd" n50-short  "lessons:$V/playbooks/n50-short.md;core=0;retrieved=15"
  eval_arm "$rd" real4-long  "lessons:$V/playbooks/real4-long.md"
  eval_arm "$rd" real4-short "lessons:$V/playbooks/real4-short.md"
fi

if want 4; then  # topic switch: 18 two-request sessions per arm (3 request-1 prompts x 6 request-2 tasks)
  rd="$OUT/v1-topic"
  topic_arm "$rd" none        none
  topic_arm "$rd" always-on   "lessons:$ALWAYS_ON"
  topic_arm "$rd" frozen      "lessons:$P300;core=0;retrieved=15;request=0;filehook=0"  # session-start retrieval only, no additions
  topic_arm "$rd" per-request "lessons:$P300;core=0;retrieved=15;request=5;filehook=0"  # + per-request additions
fi

if want 5; then  # file hook: vague prompts (4 vague heldout x3 + 2 original controls x3)
  rd="$OUT/v1-vague"
  eval_arm "$rd" vague-none       "vague:none"
  eval_arm "$rd" vague-always-on  "vague:$ALWAYS_ON"
  eval_arm "$rd" vague-nohook     "vague:$P300;core=0;retrieved=15;filehook=0"  # file hook off
  eval_arm "$rd" vague-hook       "vague:$P300;core=0;retrieved=15;filehook=1"
fi

if want 6; then  # drift: stale lessons + teammate corrections, 2 iterations, strong and weak reflector, new store
  eval_arm "$OUT/v1-drift-base" drift-stale "lessons:budget/arms/stale-seed.md"   # no learning: the stale seed as is
  for kind in strong weak; do
    model="$STRONG"; [ "$kind" = weak ] && model="$WEAK"
    rd="$OUT/v1-drift-$kind"
    if complete "$rd/eval/drift-$kind-final.jsonl" "drift-$kind-final" eval "$RUNS"; then echo "=== skip drift-$kind (done)"; continue; fi
    echo "=== drift-$kind $(date +%H:%M:%S)"
    retry_args=()
    [ ! -f "$rd/loop.jsonl" ] || retry_args+=(--eval-only)
    python3 "$V/drift_v1.py" "${retry_args[@]}" --run-dir "$rd" --label "drift-$kind" --iterations 2 --parallel "$PARALLEL" \
      --reflector-model "$model" --runs "$RUNS"
    guard $? "drift-$kind"
  done
fi

if want 7; then  # bootstrap from the corr-main train-session history, then held-out pass
  rd="$OUT/v1-bootstrap"
  if complete "$rd/eval/bootstrap-lessons.jsonl" bootstrap-lessons eval "$RUNS"; then echo "=== skip bootstrap (done)"
  else
    echo "=== bootstrap $(date +%H:%M:%S)"
    python3 "$V/bootstrap_bench.py" --run-dir "$rd" --source-run "${SOURCE_RUN:-$HARNESS/runs/corr-main}" -m "$STRONG" \
      --max-reflections 20 --runs "$RUNS" --parallel "$PARALLEL"
    guard $? bootstrap
  fi
fi
echo "=== done $(date +%H:%M:%S)"
echo "tables: python3 $V/analyze_v1.py $OUT/v1-baselines $OUT/v1-scale $OUT/v1-compress $OUT/v1-topic $OUT/v1-vague $OUT/v1-drift-base $OUT/v1-drift-strong $OUT/v1-drift-weak $OUT/v1-bootstrap"
