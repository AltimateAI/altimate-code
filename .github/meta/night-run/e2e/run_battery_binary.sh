#!/bin/bash
# Usage: run_battery_binary.sh <model> <repeats> <conc>  — runs the BUILT BINARY with --yolo
MODEL="${1:-azure/gpt-5.5}"; REPEATS="${2:-1}"; CONC="${3:-1}"
ROOT="$(git rev-parse --show-toplevel)"
BIN="$ROOT/packages/opencode/dist/@altimateai/altimate-code-darwin-arm64/bin/altimate"
TASKS="$ROOT/.github/meta/night-run/e2e/tasks.jsonl"
OUT="/tmp/e2e_binary"; mkdir -p "$OUT"; RES="$OUT/res.d"; rm -rf "$RES"; mkdir -p "$RES"; : > "$OUT/results.tsv"
run_one() {
  local id="$1" prompt="$2" check="$3" n="$4"; local wd; wd="$(mktemp -d /tmp/e2eb.XXXXXX)"
  ( cd "$wd" && git init -q 2>/dev/null; timeout 200 "$BIN" run "$prompt" --model "$MODEL" --yolo </dev/null >/dev/null 2>&1
    if eval "$check" >/dev/null 2>&1; then v=PASS; else v=FAIL; fi
    printf '%s\t%s\t%s\n' "$id" "$n" "$v" > "$RES/${id}_${n}.tsv" ); rm -rf "$wd"
}
JOBS="$OUT/jobs.txt"; : > "$JOBS"
while IFS= read -r line; do [ -z "$line" ] && continue
  id=$(printf '%s' "$line"|python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
  prompt=$(printf '%s' "$line"|python3 -c "import json,sys;print(json.load(sys.stdin)['prompt'])")
  check=$(printf '%s' "$line"|python3 -c "import json,sys;print(json.load(sys.stdin)['check'])")
  for r in $(seq 1 "$REPEATS"); do printf '%s\t%s\t%s\t%s\n' "$id" "$prompt" "$check" "$r" >> "$JOBS"; done
done < "$TASKS"
TOTAL=$(wc -l <"$JOBS"|tr -d ' '); echo "running $TOTAL binary e2e jobs (model=$MODEL --yolo conc=$CONC) $(date +%T)"
while IFS=$'\t' read -r id prompt check n <&9; do
  run_one "$id" "$prompt" "$check" "$n" &
  while [ "$(jobs -rp|wc -l|tr -d ' ')" -ge "$CONC" ]; do sleep 0.3; done
done 9< "$JOBS"; wait
cat "$RES"/*.tsv > "$OUT/results.tsv" 2>/dev/null
echo "=== RESULTS === PASS: $(grep -c $'\tPASS' "$OUT/results.tsv") FAIL: $(grep -c $'\tFAIL' "$OUT/results.tsv") / $TOTAL $(date +%T)"
awk -F'\t' '{t[$1]++; if($3=="PASS")p[$1]++} END{for(k in t)printf "  %-18s %d/%d\n",k,p[k],t[k]}' "$OUT/results.tsv"|sort
