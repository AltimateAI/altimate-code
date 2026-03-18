#!/usr/bin/env bash
# Build and run altimate-code locally from a compiled binary.
#
# Usage:
#   ./script/local.sh              # build + run
#   ./script/local.sh --skip-build # run without rebuilding
#   ./script/local.sh -- --help    # pass flags to altimate-code
#
# The script:
#   1. Builds a single-platform binary (current OS/arch) via `bun run script/build.ts --single --skip-install`
#   2. Sets NODE_PATH so the compiled Bun binary can find @altimateai/altimate-core
#   3. Launches the binary with any trailing arguments

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Parse script flags (everything before --)
SKIP_BUILD=false
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=true; shift ;;
    --) shift; ARGS=("$@"); break ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

# --- Build ---
if [ "$SKIP_BUILD" = false ]; then
  echo "Building for current platform..."
  # Run in subshell to avoid changing the working directory
  (cd "$PKG_DIR" && bun run script/build.ts --single --skip-install)
fi

# --- Resolve binary ---
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

# Detect Rosetta 2: if the shell runs under Rosetta on Apple Silicon,
# uname -m reports x86_64 but bun builds a native arm64 binary.
if [ "$OS" = "darwin" ] && [ "$ARCH" = "x86_64" ]; then
  if sysctl -n sysctl.proc_translated 2>/dev/null | grep -q 1; then
    ARCH="arm64"
  fi
fi

case "$ARCH" in
  aarch64|arm64) ARCH="arm64" ;;
  x86_64)        ARCH="x64" ;;
esac

BINARY="$PKG_DIR/dist/@altimateai/altimate-code-${OS}-${ARCH}/bin/altimate"
if [ ! -f "$BINARY" ]; then
  echo "error: binary not found at $BINARY" >&2
  echo "Available builds:" >&2
  ls "$PKG_DIR/dist/@altimateai/" 2>/dev/null || echo "  (none)" >&2
  exit 1
fi

# --- Run ---
export NODE_PATH="$PKG_DIR/node_modules${NODE_PATH:+:$NODE_PATH}"
# Use ${ARGS[@]+"${ARGS[@]}"} to avoid "unbound variable" on bash 3.2 (macOS default)
exec "$BINARY" ${ARGS[@]+"${ARGS[@]}"}
