#!/usr/bin/env bash
# Bootstrap a REAL local PySpark environment (local[*], no cluster) for a demo fixture.
# Idempotent. Prints the env exports the demo run needs.
# Usage: setup_pyspark_fixture.sh <fixture-dir>
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/lib.sh"

FIXTURE="${1:?usage: setup_pyspark_fixture.sh <fixture-dir>}"
mkdir -p "$FIXTURE"; FIXTURE="$(cd "$FIXTURE" && pwd)"
log "fixture dir: $FIXTURE"

# --- JDK (Spark needs a JVM). We pin PySpark to the 3.5 line, which supports Java 8/11/17.
#     Many brew `openjdk@N` aliases actually resolve to the latest JDK (e.g. 23), which Spark
#     rejects, so we VALIDATE the reported major version and accept only 8/11/17 (then 21). ---
java_major() { "$1/bin/java" -version 2>&1 | sed -nE 's/.*version "([0-9]+).*/\1/p' | head -1; }
JAVA_HOME=""
for cand in \
  "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home" \
  "/opt/homebrew/opt/openjdk@11/libexec/openjdk.jdk/Contents/Home" \
  "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"; do
  [ -x "$cand/bin/java" ] || continue
  m="$(java_major "$cand")"
  case "$m" in 8|11|17|21) JAVA_HOME="$cand"; log "using JDK $m at $cand"; break;; esac
done
if [ -z "$JAVA_HOME" ]; then
  log "no Spark-3.5-compatible JDK (8/11/17/21) found; installing openjdk@17"
  brew install openjdk@17
  JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
fi
export JAVA_HOME
log "JAVA_HOME=$JAVA_HOME ($(java_major "$JAVA_HOME"))"

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
