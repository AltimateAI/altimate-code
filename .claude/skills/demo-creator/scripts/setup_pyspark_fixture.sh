#!/usr/bin/env bash
# Bootstrap a REAL local PySpark environment (local[*], no cluster) for a demo fixture.
# Idempotent. Prints the env exports the demo run needs.
# Usage: setup_pyspark_fixture.sh <fixture-dir>
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/lib.sh"

FIXTURE="${1:?usage: setup_pyspark_fixture.sh <fixture-dir>}"
mkdir -p "$FIXTURE"; FIXTURE="$(cd "$FIXTURE" && pwd)"
log "fixture dir: $FIXTURE"

# --- JDK (Spark needs a JVM). We pin PySpark to the 3.5 line, which supports Java 8/11/17
#     (and 21). We check, in order: an existing JAVA_HOME, a `java` on PATH, `/usr/libexec/
#     java_home` (macOS), then Homebrew kegs — accepting only a Spark-compatible major
#     version. Homebrew install is the LAST resort, so this works on Linux / Intel mac /
#     already-configured shells, not just Apple-Silicon Homebrew. ---
# Handles both "1.8.0_xxx" (major 8) and "17.0.1" (major 17) version strings.
java_major() {
  "$1/bin/java" -version 2>&1 | sed -nE 's/.*version "([0-9]+)(\.([0-9]+))?.*/\1 \3/p' | head -1 \
    | awk '{ if ($1==1) print $2; else print $1 }'
}
compat() { case "$1" in 8|11|17|21) return 0;; *) return 1;; esac; }

JAVA_HOME_FOUND=""
add_cand() {  # try a candidate home; keep it if java is executable AND version is compatible
  [ -n "$JAVA_HOME_FOUND" ] && return 0
  [ -n "${1:-}" ] && [ -x "$1/bin/java" ] || return 0
  local m; m="$(java_major "$1")"
  if compat "$m"; then JAVA_HOME_FOUND="$1"; log "using JDK $m at $1"; fi
}
# 1) caller's JAVA_HOME  2) java already on PATH  3) macOS java_home for 17/11/8
add_cand "${JAVA_HOME:-}"
if [ -z "$JAVA_HOME_FOUND" ] && command -v java >/dev/null 2>&1; then
  add_cand "$(cd "$(dirname "$(command -v java)")/.." && pwd)"
fi
if [ -z "$JAVA_HOME_FOUND" ] && [ -x /usr/libexec/java_home ]; then
  for v in 17 11 21 8; do add_cand "$(/usr/libexec/java_home -v "$v" 2>/dev/null)"; done
fi
# 4) Homebrew kegs (Apple Silicon + Intel prefixes)
if [ -z "$JAVA_HOME_FOUND" ]; then
  for pfx in /opt/homebrew/opt /usr/local/opt; do
    for v in 17 11 21; do add_cand "$pfx/openjdk@$v/libexec/openjdk.jdk/Contents/Home"; done
  done
fi
# 5) last resort: install via Homebrew if available
if [ -z "$JAVA_HOME_FOUND" ]; then
  if command -v brew >/dev/null 2>&1; then
    log "no Spark-compatible JDK (8/11/17/21) found; installing openjdk@17 via Homebrew"
    brew install openjdk@17
    add_cand "$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home"
    add_cand "$(brew --prefix openjdk@17)"
  fi
fi
[ -n "$JAVA_HOME_FOUND" ] || { echo "ERROR: no Spark-compatible JDK (Java 8/11/17/21) found. Install one and/or set JAVA_HOME." >&2; exit 1; }
export JAVA_HOME="$JAVA_HOME_FOUND"
log "JAVA_HOME=$JAVA_HOME ($(java_major "$JAVA_HOME"))"

# Prerequisites for the venv step.
command -v uv >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1 || {
  echo "ERROR: need 'uv' or 'python3' to create the pyspark venv." >&2; exit 1; }

# --- Python venv + pyspark (3.5 line) via uv (fast). Fallback to python3 -m venv. ---
VENV="$FIXTURE/.venv"
PYSPARK_SPEC='pyspark>=3.5,<4'
if command -v uv >/dev/null 2>&1; then
  ( cd "$FIXTURE" && uv venv "$VENV" >/dev/null 2>&1 || true; \
    VIRTUAL_ENV="$VENV" uv pip install --python "$VENV/bin/python" "$PYSPARK_SPEC" )
else
  python3 -m venv "$VENV"; "$VENV/bin/pip" install -q --upgrade pip "$PYSPARK_SPEC"
fi
log "pyspark installed in $VENV"

# --- Smoke test: prove Spark actually runs here. ---
log "smoke-testing Spark local[*]..."
JAVA_HOME="$JAVA_HOME" "$VENV/bin/python" - <<'PY'
from pyspark.sql import SparkSession
s = SparkSession.builder.master("local[*]").appName("smoke").getOrCreate()
n = s.range(5).count()
s.stop()
assert n == 5, n
print("SPARK_SMOKE_OK rows=%d" % n)
PY

cat <<EOF

# ---- add these to your shell / the demo run env ----
export JAVA_HOME="$JAVA_HOME"
export PATH="\$JAVA_HOME/bin:$VENV/bin:\$PATH"
# run pipeline:  $VENV/bin/python <script>.py
EOF
log "fixture env ready."
