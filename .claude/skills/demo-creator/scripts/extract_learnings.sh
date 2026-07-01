#!/usr/bin/env bash
# Mine a recorded altimate-code session into learnings.md: what the run actually DID
# (tool/command sequence), the verification/value markers it hit, and raw material for the
# "what it did" beat in the blog + the cross-session learning ledger.
#
# It only extracts evidence from the real run — it does not invent takeaways. The agent
# reads learnings.md and writes the one-line "why this matters" + any reusable lesson.
#
# Usage: extract_learnings.sh <topic> <angle> [--baseline]   (--baseline mines the claude run too)
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/lib.sh"
# Best-effort miner: grep no-matches and head-closed pipes are expected, so don't let
# lib.sh's `set -euo pipefail` abort us on them.
set +e +o pipefail

[ $# -ge 2 ] || { echo "usage: extract_learnings.sh <topic> <angle> [--baseline]" >&2; exit 2; }
TOPIC="$1"; ANGLE="$2"; WITH_BASE=0
[ "${3:-}" = "--baseline" ] && WITH_BASE=1

DD="$(demo_dir "$TOPIC")"
JSON="$DD/runs/$ANGLE.json"
LOG="$DD/runs/$ANGLE.log"; [ -f "$LOG" ] || LOG="$DD/runs/altimate.log"
OUT="$DD/learnings.md"

# Pull the source the run actually produced. Prefer json; fall back to the captured log.
CAST="$DD/clips/$ANGLE.cast"
SRC=""
[ -f "$JSON" ] && SRC="$JSON"
[ -z "$SRC" ] && [ -f "$LOG" ] && SRC="$LOG"
# Fall back to the recorded asciinema cast — it IS the run record (JSONL; output text is greppable).
[ -z "$SRC" ] && [ -f "$CAST" ] && SRC="$CAST"
[ -n "$SRC" ] || { echo "ERROR: no run source for $TOPIC/$ANGLE (runs/$ANGLE.json, runs/altimate.log, or clips/$ANGLE.cast)" >&2; exit 1; }
log "mining $SRC -> $OUT"

# Remember the real source for display; mine from an ANSI-stripped copy (formatted logs are
# full of escape codes). SRC below points at the temp copy, SRC_NAME at the real file.
SRC_NAME="$(basename "$SRC")"
CLEAN="$(mktemp)"; trap 'rm -f "$CLEAN"' EXIT
perl -pe 's/\x1b\[[0-9;]*[a-zA-Z]//g' "$SRC" > "$CLEAN" 2>/dev/null || cp "$SRC" "$CLEAN"
SRC="$CLEAN"

# Tool/command sequence the agent executed (bash tool-calls + tool names).
extract_tools() {  # extract_tools <file>
  grep -oE '"(tool|name)"[[:space:]]*:[[:space:]]*"[^"]+"' "$1" 2>/dev/null | sed -E 's/.*"([^"]+)"$/\1/' \
    | grep -viE '^(text|message|assistant|user|step)$' || true
}
# Shell commands captured in the recorded output (works on the formatted log too).
extract_cmds() {  # extract_cmds <file>
  grep -oE '(\$ |bash |python |diff |altimate-code |duckdb |run_sql)[^"]*' "$1" 2>/dev/null \
    | sed -E 's/\\u[0-9a-fA-F]{4}//g' | grep -vE '^\s*$' | head -40 || true
}
# Verification / value-moment markers — evidence the valuable thing happened on camera.
VALUE_MARKERS='run_sql|diff |byte-for-byte|identical|zero diff|verify|expected_sql|equival|sql_analyze|altimate_core|\bcheck\b|lineage|cost|row count|assert'

TOOLS="$(extract_tools "$SRC" | sort | uniq -c | sort -rn | head -25)"
CMDS="$(extract_cmds "$SRC")"
VALUE_HITS="$(grep -niE "$VALUE_MARKERS" "$SRC" 2>/dev/null | sed -E 's/\\u[0-9a-fA-F]{4}//g' | head -25)"
TRACE_ID="$(grep -oE 'ses_[A-Za-z0-9]+' "$SRC" 2>/dev/null | head -1)"

{
  echo "# Learnings — $TOPIC / $ANGLE"
  echo
  echo "_Mined from \`$SRC_NAME\`$( [ -n "$TRACE_ID" ] && echo " · trace \`$TRACE_ID\`")._"
  echo "_All items below are extracted from the REAL run. The 'why it matters' and reusable"
  echo "lessons are filled in by the author after reading this — do not invent value the run"
  echo "did not show (law #2)._"
  echo
  echo "## What altimate-code actually ran"
  echo '```'
  [ -n "$CMDS" ] && echo "$CMDS" || echo "(no shell commands parsed — inspect $SRC directly)"
  echo '```'
  echo
  echo "## Tools / events observed (count)"
  echo '```'
  [ -n "$TOOLS" ] && echo "$TOOLS" || echo "(none parsed)"
  echo '```'
  echo
  echo "## Value-moment evidence (verification / capability markers)"
  if [ -n "$VALUE_HITS" ]; then echo '```'; echo "$VALUE_HITS"; echo '```'; else
    echo "**NONE FOUND.** The run shows no verification/capability marker — per law #2 you"
    echo "do not yet have a value moment for this angle. Change the task or report honestly."
  fi
  echo
  echo "## Why it matters  <!-- author fills in: one line, grounded in the evidence above -->"
  echo
  echo "## Reusable lesson  <!-- author: product bug / env gotcha / prompt that triggers the value / fixture pattern."
  echo "                         If it should persist across sessions, also save to memory + MANIFEST ledger. -->"
} > "$OUT"

if [ "$WITH_BASE" = "1" ] && [ -f "$DD/runs/$ANGLE.baseline.json" ]; then
  {
    echo
    echo "## Baseline (claude-code) — value markers, for the contrast"
    BH="$(grep -niE "$VALUE_MARKERS" "$DD/runs/$ANGLE.baseline.json" 2>/dev/null | head -20)"
    if [ -n "$BH" ]; then echo '```'; echo "$BH"; echo '```'; else
      echo "(baseline shows none of: $VALUE_MARKERS — this absence IS the contrast.)"
    fi
  } >> "$OUT"
fi

log "wrote $OUT"
echo "$OUT"
