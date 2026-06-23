#!/usr/bin/env bash
# Builds a self-contained linux/x64 npm tarball for altimate-code from the
# local working tree, suitable for `npm i -g <tarball>` inside an ade-bench
# container.
#
# Output: altimate-code-local.tgz (next to this script).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PKG_DIR="$REPO_ROOT/packages/opencode"
DBT_TOOLS_DIR="$REPO_ROOT/packages/dbt-tools"
SKILLS_DIR="$REPO_ROOT/.opencode/skills"
BIN_X64="$PKG_DIR/dist/@altimateai/altimate-code-linux-x64/bin/altimate-code"
BIN_ARM64="$PKG_DIR/dist/@altimateai/altimate-code-linux-arm64/bin/altimate-code"

for f in "$BIN_X64" "$BIN_ARM64"; do
  if [[ ! -f "$f" ]]; then
    echo "missing $f — run 'bun run script/build.ts --targets=linux' from packages/opencode" >&2
    exit 1
  fi
done
if [[ ! -f "$DBT_TOOLS_DIR/dist/index.js" ]]; then
  echo "missing dbt-tools dist — run 'bun run build' from packages/dbt-tools" >&2
  exit 1
fi

VERSION="$(jq -r .version "$PKG_DIR/package.json")"
ALTIMATE_CORE_DEP="$(jq -r '.dependencies["@altimateai/altimate-core"]' "$PKG_DIR/package.json")"

STAGE="$SCRIPT_DIR/.stage"
rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/dbt-tools/bin" "$STAGE/dbt-tools/dist"

# Wrappers (Node.js dispatcher scripts)
cp "$PKG_DIR/bin/altimate-code" "$STAGE/bin/altimate-code"
cp "$PKG_DIR/bin/altimate" "$STAGE/bin/altimate"
chmod 755 "$STAGE/bin/altimate-code" "$STAGE/bin/altimate"

# Per-arch native binaries. setup.sh copies the right one to bin/.altimate-code
# (the wrapper's cached fallback path — see bin/altimate-code script).
cp "$BIN_X64" "$STAGE/bin/.altimate-code-x64"
cp "$BIN_ARM64" "$STAGE/bin/.altimate-code-arm64"
chmod 755 "$STAGE/bin/.altimate-code-x64" "$STAGE/bin/.altimate-code-arm64"

# Skills (skipping postinstall.mjs — we place the binary manually in setup.sh
# via .altimate-code cache trick instead of the per-arch optionalDeps mechanism)
cp -r "$SKILLS_DIR" "$STAGE/skills"

# dbt-tools assets (subset publish.ts ships)
cp "$DBT_TOOLS_DIR/bin/altimate-dbt" "$STAGE/dbt-tools/bin/altimate-dbt"
cp "$DBT_TOOLS_DIR/dist/index.js" "$STAGE/dbt-tools/dist/index.js"
cp "$DBT_TOOLS_DIR/dist/node_python_bridge.py" "$STAGE/dbt-tools/dist/node_python_bridge.py"
echo '{ "type": "module" }' > "$STAGE/dbt-tools/package.json"
if [[ -d "$DBT_TOOLS_DIR/dist/altimate_python_packages" ]]; then
  cp -r "$DBT_TOOLS_DIR/dist/altimate_python_packages" "$STAGE/dbt-tools/dist/"
fi

# License + changelog (best effort)
[[ -f "$REPO_ROOT/LICENSE" ]] && cp "$REPO_ROOT/LICENSE" "$STAGE/LICENSE" || true
[[ -f "$REPO_ROOT/CHANGELOG.md" ]] && cp "$REPO_ROOT/CHANGELOG.md" "$STAGE/CHANGELOG.md" || true

cat > "$STAGE/package.json" <<EOF
{
  "name": "altimate-code",
  "description": "altimate-code (local build for ade-bench)",
  "version": "${VERSION}-local",
  "license": "MIT",
  "bin": {
    "altimate": "./bin/altimate",
    "altimate-code": "./bin/altimate-code",
    "altimate-dbt": "./dbt-tools/bin/altimate-dbt"
  },
  "dependencies": {
    "@altimateai/altimate-core": "${ALTIMATE_CORE_DEP}"
  }
}
EOF

# Pack with bun pm pack — produces altimate-code-<ver>-local.tgz
( cd "$STAGE" && bun pm pack >/dev/null )

TARBALL="$STAGE/altimate-code-${VERSION}-local.tgz"
if [[ ! -f "$TARBALL" ]]; then
  echo "pack failed: expected $TARBALL" >&2
  exit 1
fi
mv "$TARBALL" "$SCRIPT_DIR/altimate-code-local.tgz"
rm -rf "$STAGE"
echo "wrote $SCRIPT_DIR/altimate-code-local.tgz"
