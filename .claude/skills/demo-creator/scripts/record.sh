#!/usr/bin/env bash
# Record a REAL run with asciinema, then render that exact cast to a GIF with agg.
# Usage:
#   record.sh <topic-slug> <angle> [--cwd DIR] [--cols N] [--rows N] [--font N] \
#             [--idle SECS] [--out-prefix NAME] -- <command...>
# Everything after `--` is the real command that gets recorded (e.g. altimate-code run ...).
# Produces: demos/<topic>/clips/<out-prefix>.cast and .gif
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/lib.sh"

[ $# -ge 2 ] || { echo "usage: record.sh <topic> <angle> [opts] -- <command...>" >&2; exit 2; }
TOPIC="$1"; ANGLE="$2"; shift 2
CWD="$PWD"; COLS=100; ROWS=30; FONT=22; IDLE=2; PREFIX="$ANGLE"; BANNER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cwd) CWD="$2"; shift 2;;
    --cols) COLS="$2"; shift 2;;
    --rows) ROWS="$2"; shift 2;;
    --font) FONT="$2"; shift 2;;
    --idle) IDLE="$2"; shift 2;;
    --out-prefix) PREFIX="$2"; shift 2;;
    --banner) BANNER="$2"; shift 2;;   # shown on screen before the run (headless hides the invocation)
    --) shift; break;;
    *) echo "unknown opt: $1" >&2; exit 2;;
  esac
done
[ $# -ge 1 ] || { echo "ERROR: no command after --" >&2; exit 2; }

need asciinema asciinema; need agg agg

DD="$(demo_dir "$TOPIC")"; CLIPS="$DD/clips"; mkdir -p "$CLIPS"
CAST="$CLIPS/$PREFIX.cast"; GIF="$CLIPS/$PREFIX.gif"

# Build a single shell string for the real command (asciinema --command takes one string).
CMD="$(printf '%q ' "$@")"
log "recording REAL run -> $CAST"
log "  cwd: $CWD"
log "  cmd: $CMD"

# Optional on-screen banner so viewers see what was asked (headless mode hides the prompt).
# The real command is unchanged — the banner only echoes context, it does not fake output.
INNER="$CMD"
if [ -n "$BANNER" ]; then
  INNER="printf '\033[1;36m\$ %s\033[0m\n\n' $(printf '%q' "$BANNER"); sleep 1; $CMD"
fi

# Record. asciinema (v3) runs the command in a real pty and stops when it exits.
( cd "$CWD" && asciinema rec --overwrite --window-size "${COLS}x${ROWS}" \
    --command "bash -lc $(printf '%q' "$INNER")" "$CAST" )

log "rendering -> $GIF"
agg --cols "$COLS" --rows "$ROWS" --font-size "$FONT" --idle-time-limit "$IDLE" \
    "$CAST" "$GIF"

log "done: $CAST  +  $GIF"
echo "$GIF"
