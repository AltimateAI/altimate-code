#!/bin/bash
# Usage: run_battery.sh <model> <repeats> <concurrency>
# Runs each task in tasks.jsonl <repeats> times via the agent, checks the artifact, logs pass/fail.
MODEL="${1:-azure/gpt-4o-mini}"; REPEATS="${2:-1}"; CONC="${3:-4}"
ROOT="$(git rev-parse --show-toplevel)"; ENTRY="$ROOT/packages/opencode/src/index.ts"
TASKS="$ROOT/.github/meta/night-run/e2e/tasks.jsonl"
OUT="/tmp/e2e_battery"; mkdir -p "$OUT"; : > "$OUT/results.tsv"

RES="$OUT/res.d"; rm -rf "$RES"; mkdir -p "$RES"
run_one() {
  local id="$1" prompt="$2" check="$3" n="$4"
  local wd; wd="$(mktemp -d /tmp/e2e_run.XXXXXX)"
  ( cd "$wd" && git init -q 2>/dev/null; timeout 120 bun run --conditions=browser "$ENTRY" run "$prompt" --model "$MODEL" </dev/null >/dev/null 2>&1
    if eval "$check" >/dev/null 2>&1; then v=PASS; else v=FAIL; fi
    # each job writes its OWN file (no concurrent-append races)
    printf '%s\t%s\t%s\n' "$id" "$n" "$v" > "$RES/${id}_${n}.tsv" )
  rm -rf "$wd"
}

JOBS="$OUT/jobs.txt"; : > "$JOBS"
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id=$(printf '%s' "$line" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
  prompt=$(printf '%s' "$line" | python3 -c "import json,sys;print(json.load(sys.stdin)['prompt'])")
  check=$(printf '%s' "$line" | python3 -c "import json,sys;print(json.load(sys.stdin)['check'])")
  for r in $(seq 1 "$REPEATS"); do printf '%s\t%s\t%s\t%s\n' "$id" "$prompt" "$check" "$r" >> "$JOBS"; done
done < "$TASKS"
TOTAL=$(wc -l < "$JOBS" | tr -d ' ')
echo "running $TOTAL e2e jobs, model=$MODEL conc=$CONC"

while IFS=$'\t' read -r id prompt check n <&9; do
  run_one "$id" "$prompt" "$check" "$n" &
  # throttle: block while at/above concurrency (portable, no wait -n needed)
  while [ "$(jobs -rp | wc -l | tr -d ' ')" -ge "$CONC" ]; do sleep 0.3; done
done 9< "$JOBS"
wait

cat "$RES"/*.tsv > "$OUT/results.tsv" 2>/dev/null
PASS=$(grep -c $'\tPASS' "$OUT/results.tsv"); FAIL=$(grep -c $'\tFAIL' "$OUT/results.tsv")
echo "=== RESULTS === PASS: $PASS  FAIL: $FAIL  / $TOTAL  (captured: $(wc -l < "$OUT/results.tsv" | tr -d ' '))"
echo "per-task pass-rate:"
awk -F'\t' '{t[$1]++; if($3=="PASS")p[$1]++} END{for(k in t)printf "  %-18s %d/%d\n",k,p[k],t[k]}' "$OUT/results.tsv" | sort
