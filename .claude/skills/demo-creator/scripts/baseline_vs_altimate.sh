#!/usr/bin/env bash
# Run the SAME task twice and capture each run for comparison:
#   baseline  = claude-code (the base agent: `claude -p`)         [default]
#   altimate  = altimate-code (the fork with data tooling)
# Same prompt, same fixture, same underlying model -> the only difference is altimate-code's
# additions. This is the honest "why use us over plain Claude Code" control.
#
# It captures the json event stream for each run (authenticity proof). It does NOT render
# GIFs — use record.sh to capture the watchable clip of whichever run(s) you show.
#
# Usage:
#   baseline_vs_altimate.sh <topic> <angle> --cwd DIR --prompt "..." \
#       [--reset-from PRISTINE_DIR] [--max-turns N] \
#       [--model PROVIDER/MODEL]      # altimate-code model (e.g. anthropic/claude-...)
#       [--baseline-model ALIAS]      # claude-code model alias (default: sonnet)
#       [--baseline-mode claude|disable] [--baseline-deny TOOL,TOOL] [--baseline-agent NAME]
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/lib.sh"

TOPIC=""; ANGLE=""; CWD="$PWD"; PROMPT=""; MODEL=""; BASE_MODEL="sonnet"; MAXT="40"
RESET_FROM=""; BASE_MODE="claude"; BASE_DENY=""; BASE_AGENT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cwd) CWD="$2"; shift 2;;
    --prompt) PROMPT="$2"; shift 2;;
    --model) MODEL="$2"; shift 2;;
    --baseline-model) BASE_MODEL="$2"; shift 2;;
    --reset-from) RESET_FROM="$2"; shift 2;;
    --max-turns) MAXT="$2"; shift 2;;
    --baseline-mode) BASE_MODE="$2"; shift 2;;     # claude (default) | disable
    --baseline-deny) BASE_DENY="$2"; shift 2;;     # only for --baseline-mode disable
    --baseline-agent) BASE_AGENT="$2"; shift 2;;   # only for --baseline-mode disable
    -*) echo "unknown opt: $1" >&2; exit 2;;
    *) if [ -z "$TOPIC" ]; then TOPIC="$1"; elif [ -z "$ANGLE" ]; then ANGLE="$1"; fi; shift;;
  esac
done
[ -n "$TOPIC" ] && [ -n "$ANGLE" ] && [ -n "$PROMPT" ] || {
  echo "usage: baseline_vs_altimate.sh <topic> <angle> --cwd DIR --prompt '...' [...]" >&2; exit 2; }
need altimate-code

DD="$(demo_dir "$TOPIC")"; RUNS="$DD/runs"; mkdir -p "$RUNS"

reset_fixture() {
  [ -n "$RESET_FROM" ] || return 0
  [ -d "$RESET_FROM" ] || { echo "ERROR: --reset-from '$RESET_FROM' is not a dir" >&2; return 1; }
  log "  resetting fixture: rsync $RESET_FROM/ -> $CWD/"
  rsync -a --delete --exclude '.git' "$RESET_FROM"/ "$CWD"/
}

# ---------------- baseline ----------------
log "=== BASELINE run ($BASE_MODE) ==="
reset_fixture
if [ "$BASE_MODE" = "claude" ]; then
  need claude
  ( cd "$CWD" && claude -p --dangerously-skip-permissions --max-turns "$MAXT" \
      --output-format json --model "$BASE_MODEL" "$PROMPT" ) \
      | tee "$RUNS/$ANGLE.baseline.json" || true
else
  # In-fork isolation: run altimate-code but strip the capability under test.
  B_ARGS=(); [ -n "$BASE_AGENT" ] && B_ARGS+=(--agent "$BASE_AGENT")
  M_ARGS=(); [ -n "$MODEL" ] && M_ARGS+=(--model "$MODEL")
  if [ -n "$BASE_DENY" ]; then
    export OPENCODE_PERMISSION="{\"tools\":{$(echo "$BASE_DENY" | awk -F, '{for(i=1;i<=NF;i++){printf "%s\"%s\":\"deny\"", (i>1?",":""), $i}}')}}"
    log "  baseline OPENCODE_PERMISSION=$OPENCODE_PERMISSION"
  fi
  ( cd "$CWD" && altimate-code run --yolo --max-turns "$MAXT" --format json --trace \
      "${M_ARGS[@]}" "${B_ARGS[@]}" "$PROMPT" ) | tee "$RUNS/$ANGLE.baseline.json" || true
  unset OPENCODE_PERMISSION
fi

# ---------------- altimate ----------------
log "=== ALTIMATE run ==="
reset_fixture
M_ARGS=(); [ -n "$MODEL" ] && M_ARGS+=(--model "$MODEL")
( cd "$CWD" && altimate-code run --yolo --max-turns "$MAXT" --format json --trace \
    "${M_ARGS[@]}" "$PROMPT" ) | tee "$RUNS/$ANGLE.json" || true

log "json captured: $RUNS/$ANGLE.baseline.json  +  $RUNS/$ANGLE.json"
log "fair-comparison check: baseline model='$BASE_MODEL', altimate model='${MODEL:-<default>}' — keep these equivalent."
log "trace ids: 'altimate-code trace list' (altimate run is traced; the claude run leaves its own transcript)."
