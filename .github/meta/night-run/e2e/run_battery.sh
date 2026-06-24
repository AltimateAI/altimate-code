#!/bin/bash
# Usage: run_battery.sh <model> <repeats> <concurrency> <bin-or-srcindex>
# Runs each task in tasks.jsonl <repeats> times via the agent, checks the artifact, logs pass/fail.
MODEL="${1:-azure/gpt-4o-mini}"; REPEATS="${2:-1}"; CONC="${3:-4}"
ROOT="$(git rev-parse --show-toplevel)"; ENTRY="$ROOT/packages/opencode/src/index.ts"
TASKS="$ROOT/.github/meta/night-run/e2e/tasks.jsonl"
OUT="/tmp/e2e_battery"; mkdir -p "$OUT"; : > "$OUT/results.tsv"
run_one() {
  local id="$1" prompt="$2" check="$3" n="$4"
  local wd; wd="$(mktemp -d /tmp/e2e_run.XXXXXX)"; (cd "$wd" && git init -q 2>/dev/null)
  ( cd "$wd" && timeout 120 bun run --conditions=browser "$ENTRY" run "$prompt" --model "$MODEL" >/dev/null 2>&1 )
  local pass; (cd "$wd" && eval "$check") && pass=PASS || pass=FAIL
  echo -e "${id}\t${n}\t${pass}" >> "$OUT/results.tsv"
  rm -rf "$wd"
}
export -f run_one; export ENTRY MODEL OUT
# build job list
JOBS="$OUT/jobs.txt"; : > "$JOBS"
while IFS= read -r line; do
  id=$(echo "$line" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
  prompt=$(echo "$line" | python3 -c "import json,sys;print(json.load(sys.stdin)['prompt'])")
  check=$(echo "$line" | python3 -c "import json,sys;print(json.load(sys.stdin)['check'])")
  for r in $(seq 1 "$REPEATS"); do printf '%s\t%s\t%s\t%s\n' "$id" "$prompt" "$check" "$r" >> "$JOBS"; done
done < "$TASKS"
TOTAL=$(wc -l < "$JOBS")
echo "running $TOTAL e2e jobs, model=$MODEL conc=$CONC"
cat "$JOBS" | xargs -P "$CONC" -d '\n' -I {} bash -c 'IFS=$'"'"'\t'"'"' read -r id prompt check n <<< "{}"; run_one "$id" "$prompt" "$check" "$n"'
echo "=== RESULTS ==="; echo "PASS: $(grep -c PASS "$OUT/results.tsv")  FAIL: $(grep -c FAIL "$OUT/results.tsv")  / $TOTAL"
echo "per-task:"; awk -F'\t' '{t[$1]++; if($3=="PASS")p[$1]++} END{for(k in t)printf "  %s: %d/%d\n",k,p[k],t[k]}' "$OUT/results.tsv" | sort
