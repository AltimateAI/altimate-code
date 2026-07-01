#!/usr/bin/env bash
# Extract PNG frames from a clip's GIF for visual inspection, and print the authenticity
# cross-check inputs (json event summary + how to view the trace).
# Usage: inspect.sh <topic> <angle> [--fps N] [--prefix NAME]
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/lib.sh"

[ $# -ge 2 ] || { echo "usage: inspect.sh <topic> <angle> [--fps N] [--prefix NAME]" >&2; exit 2; }
TOPIC="$1"; ANGLE="$2"; shift 2
FPS=1; PREFIX="$ANGLE"
while [ $# -gt 0 ]; do
  case "$1" in
    --fps) FPS="$2"; shift 2;;
    --prefix) PREFIX="$2"; shift 2;;
    *) echo "unknown opt: $1" >&2; exit 2;;
  esac
done
need ffmpeg ffmpeg

DD="$(demo_dir "$TOPIC")"
GIF="$DD/clips/$PREFIX.gif"
FRAMES="$DD/clips/frames/$PREFIX"
[ -f "$GIF" ] || { echo "ERROR: no GIF at $GIF (record it first)" >&2; exit 1; }
mkdir -p "$FRAMES"; rm -f "$FRAMES"/f_*.png

log "extracting frames @ ${FPS}fps -> $FRAMES"
ffmpeg -y -loglevel error -i "$GIF" -vf "fps=$FPS" "$FRAMES/f_%03d.png"
# Count without letting a no-match ls abort us under `set -e`/pipefail (lib.sh sets both).
COUNT=$(find "$FRAMES" -name 'f_*.png' 2>/dev/null | wc -l | tr -d ' ')
log "wrote $COUNT frames. Read them to verify legibility + the value moment."

# --- Authenticity cross-check pointers ---
# Reconcile against the run that produced THIS clip: a baseline prefix (<angle>.baseline)
# must be checked against the baseline json, not the altimate one.
case "$PREFIX" in
  *.baseline) JSON="$DD/runs/$ANGLE.baseline.json";;
  *)          JSON="$DD/runs/$ANGLE.json";;
esac
if [ -f "$JSON" ]; then
  log "json event stream present: $JSON"
  echo "----- tool calls observed in the run (cross-check against the clip) -----"
  # Best-effort: pull tool/event names out of the json stream (works for line-delimited json).
  grep -oE '"(tool|name|type)"[[:space:]]*:[[:space:]]*"[^"]+"' "$JSON" 2>/dev/null | sort | uniq -c | sort -rn | head -40 || true
  echo "------------------------------------------------------------------------"
else
  log "NOTE: no $JSON — run baseline_vs_altimate.sh (or run with --format json) to get the authenticity proof."
fi
echo "To view the recorded session trace:  altimate-code trace list   then   altimate-code trace view <id>"
echo "FRAMES_DIR=$FRAMES"
