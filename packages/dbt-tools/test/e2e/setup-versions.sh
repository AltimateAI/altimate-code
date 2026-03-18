#!/usr/bin/env bash
#
# Create isolated Python venvs for each dbt version we want to test.
# Usage: ./e2e-setup.sh [version...]
#
# Examples:
#   ./e2e-setup.sh              # Install all default versions
#   ./e2e-setup.sh 1.8 1.9      # Install only 1.8 and 1.9
#
# Venvs are created in test/.dbt-venvs/<version>/
# Each venv gets dbt-core + dbt-duckdb of the matching minor version.
#
# NOTE: dbt 1.11+ is only available as pre-release on PyPI (1.11.0b3).
# Stable 1.11.x releases are on GitHub but use the new `dbt` meta-package.
# We install 1.11.0b3 which is the latest PyPI-available 1.11 build.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENVS_DIR="$SCRIPT_DIR/../.dbt-venvs"

DEFAULT_VERSIONS=("1.7" "1.8" "1.9" "1.10" "1.11")

if [ $# -gt 0 ]; then
  VERSIONS=("$@")
else
  VERSIONS=("${DEFAULT_VERSIONS[@]}")
fi

get_install_spec() {
  # Pin both dbt-core and dbt-duckdb to the target minor version.
  # Without pinning dbt-core, pip resolves to the latest compatible version.
  case "$1" in
    1.7)  echo "dbt-core>=1.7,<1.8 dbt-duckdb>=1.7,<1.8" ;;
    1.8)  echo "dbt-core>=1.8,<1.9 dbt-duckdb>=1.8,<1.9" ;;
    1.9)  echo "dbt-core>=1.9,<1.10 dbt-duckdb>=1.9,<1.10" ;;
    1.10) echo "dbt-core>=1.10,<1.11 dbt-duckdb>=1.10,<1.11" ;;
    1.11) echo "dbt-core==1.11.0b3 dbt-duckdb>=1.10,<1.11" ;;
    *)    echo "" ;;
  esac
}

get_pip_flags() {
  case "$1" in
    1.11) echo "--pre" ;;
    *)    echo "" ;;
  esac
}

mkdir -p "$VENVS_DIR"

for ver in "${VERSIONS[@]}"; do
  venv_dir="$VENVS_DIR/$ver"
  install_spec=$(get_install_spec "$ver")
  extra_flags=$(get_pip_flags "$ver")

  if [ -z "$install_spec" ]; then
    echo "ERROR: Unknown dbt version $ver (supported: 1.7 1.8 1.9 1.10 1.11)"
    exit 1
  fi

  if [ -f "$venv_dir/bin/dbt" ]; then
    existing=$("$venv_dir/bin/dbt" --version 2>&1 | grep -oE 'installed: [0-9.a-z]+' | head -1 | sed 's/installed: /core=/' | head -1 || echo "unknown")
    echo "✓ dbt $ver already installed ($existing) at $venv_dir"
    continue
  fi

  echo "→ Installing dbt $ver..."
  python3 -m venv "$venv_dir"
  "$venv_dir/bin/pip" install --quiet --upgrade pip
  # shellcheck disable=SC2086
  "$venv_dir/bin/pip" install --quiet $extra_flags $install_spec

  installed=$("$venv_dir/bin/dbt" --version 2>&1 | grep -oE 'installed: [0-9.a-z]+' | head -1 | sed 's/installed: /core=/' | head -1 || echo "unknown")
  echo "✓ dbt $ver installed ($installed)"
done

echo ""
echo "Venvs ready in $VENVS_DIR"
echo "Available versions:"
for ver in "${VERSIONS[@]}"; do
  venv_dir="$VENVS_DIR/$ver"
  if [ -f "$venv_dir/bin/dbt" ]; then
    installed=$("$venv_dir/bin/dbt" --version 2>&1 | grep -oE 'installed: [0-9.a-z]+' | head -1 | sed 's/installed: /core=/' | head -1)
    echo "  $ver → $installed ($venv_dir/bin/dbt)"
  fi
done
