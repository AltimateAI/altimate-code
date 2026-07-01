#!/usr/bin/env bash
# Build a SELF-CONTAINED HTML artifact from a page template by inlining every relative
# image src (clips/*.gif, frames/*.png, …) as a base64 data URI. Claude artifacts run under
# a strict CSP that blocks external hosts, so assets MUST be embedded. Optionally renders the
# result headless so you can visually inspect it BEFORE publishing (do not skip that).
#
# Usage:
#   build_artifact.sh <topic> <template.html> [--out demo.html] [--render] [--width 820] [--height 5200]
# Then publish the written file with the Artifact tool (redeploy to the same path/URL on edits).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/lib.sh"

[ $# -ge 2 ] || { echo "usage: build_artifact.sh <topic> <template.html> [--out NAME] [--render] [--width W] [--height H]" >&2; exit 2; }
TOPIC="$1"; TPL="$2"; shift 2
OUT="demo.html"; RENDER=0; W=820; H=5200
while [ $# -gt 0 ]; do case "$1" in
  --out) OUT="$2"; shift 2;;
  --render) RENDER=1; shift;;
  --width) W="$2"; shift 2;;
  --height) H="$2"; shift 2;;
  *) echo "unknown opt: $1" >&2; exit 2;;
esac; done

[ -f "$TPL" ] || { echo "ERROR: template '$TPL' not found" >&2; exit 1; }
DD="$(demo_dir "$TOPIC")"; OUTPATH="$DD/$OUT"
log "building self-contained artifact: $TPL -> $OUTPATH (base dir $DD)"

python3 - "$TPL" "$DD" "$OUTPATH" <<'PY'
import base64, mimetypes, os, re, sys
tpl, base, out = sys.argv[1:4]
html = open(tpl, encoding="utf-8").read()
mimetypes.add_type("image/svg+xml", ".svg")
inlined = [0]; missing = []
base_real = os.path.realpath(base)
def datauri(rel):
    # realpath resolves symlinks; commonpath confines to base (a plain startswith prefix
    # would let a sibling dir sharing base's name — e.g. base/../base-secret — escape).
    p = os.path.realpath(os.path.join(base, rel))
    if not (os.path.isfile(p) and os.path.commonpath([p, base_real]) == base_real):
        missing.append(rel); return None
    mime = mimetypes.guess_type(p)[0] or "application/octet-stream"
    inlined[0] += 1
    return "data:%s;base64,%s" % (mime, base64.b64encode(open(p,"rb").read()).decode())
def repl(m):
    pre, q, url, post = m.group(1), m.group(2), m.group(3), m.group(4)
    if re.match(r'^(https?:|data:|//)', url): return m.group(0)
    d = datauri(url)
    return m.group(0) if d is None else "%s%s%s%s" % (pre, q, d, post)
# src="..." and CSS url(...) for local image paths
html = re.sub(r'(src=)(["\'])([^"\']+\.(?:gif|png|jpe?g|svg|webp))(["\'])', repl, html, flags=re.I)
html = re.sub(r'(url\()(["\']?)([^)"\']+\.(?:gif|png|jpe?g|svg|webp))(["\']?\))', repl, html, flags=re.I)
open(out, "w", encoding="utf-8").write(html)
print("inlined %d asset(s); %.2f MB" % (inlined[0], len(html)/1e6))
if missing: print("WARNING: could not inline (will break under CSP): %s" % ", ".join(missing), file=sys.stderr)
PY

if [ "$RENDER" = "1" ]; then
  # Discover a Chromium-family browser on PATH or in the usual macOS bundle locations.
  CHROME=""
  for c in "${CHROME_BIN:-}" google-chrome google-chrome-stable chromium chromium-browser chrome \
           "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"; do
    [ -n "$c" ] || continue
    if command -v "$c" >/dev/null 2>&1; then CHROME="$(command -v "$c")"; break; fi
    [ -x "$c" ] && { CHROME="$c"; break; }
  done
  SHOT="$DD/clips/frames/_artifact_render.png"; mkdir -p "$(dirname "$SHOT")"
  if [ -z "$CHROME" ]; then
    # Render-inspection is mandatory before publishing, so a missing browser is a hard error.
    echo "ERROR: --render requested but no Chrome/Chromium found. Install one or set CHROME_BIN." >&2
    echo "       (Do NOT publish an artifact you haven't visually inspected.)" >&2
    exit 1
  fi
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size="$W,$H" --screenshot="$SHOT" "file://$OUTPATH" 2>/dev/null
  log "rendered for inspection -> $SHOT  (Read it; check empty grid cells, mostly-empty GIFs, no h-scroll)"
  echo "$SHOT"
fi
log "artifact ready: $OUTPATH  (publish with the Artifact tool; redeploy to the same path on edits)"
echo "$OUTPATH"
