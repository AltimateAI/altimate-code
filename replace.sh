#!/usr/bin/env bash
set -euo pipefail

# Build the local altimate-code and install it as the global `altimate` binary
# so other consumers (terminals, IDE extensions, etc.) pick it up for testing.
#
# Usage:
#   ./replace.sh                # build (current platform only), sign + install
#   ./replace.sh --skip-build   # sign + install the existing local build
#
# Restore the release version afterwards with:
#   curl -fsSL https://www.altimate.sh/install | bash

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_BIN="$REPO_DIR/packages/opencode/dist/@altimateai/altimate-code-darwin-arm64/bin/altimate"
DEST="$HOME/.altimate/bin/altimate"

if [[ "${1:-}" != "--skip-build" ]]; then
    (cd "$REPO_DIR/packages/opencode" && bun run build --single)
fi

if [[ ! -f "$DIST_BIN" ]]; then
    echo "error: no local build at $DIST_BIN" >&2
    exit 1
fi

# Bun's linker-generated ad-hoc signature is invalid on macOS arm64, which
# makes dyld hang at startup. Re-sign before installing.
codesign --force --sign - "$DIST_BIN"
codesign --verify "$DIST_BIN"

# rm before cp: overwriting in place reuses the inode and poisons the kernel's
# code-signature cache (running `altimate serve` processes keep it alive).
rm -f "$DEST"
cp "$DIST_BIN" "$DEST"
chmod 755 "$DEST"

echo "Installed $DEST -> $("$DEST" -v)"
