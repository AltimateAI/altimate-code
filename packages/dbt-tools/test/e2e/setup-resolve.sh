#!/usr/bin/env bash
#
# Create real Python environments using different package managers,
# each with dbt-duckdb installed, for e2e testing of dbt binary resolution.
#
# Usage: ./e2e-resolve-setup.sh [scenario...]
#
# Examples:
#   ./e2e-resolve-setup.sh              # Set up all available scenarios
#   ./e2e-resolve-setup.sh venv uv      # Only set up venv and uv
#
# Environments are created in test/.dbt-resolve-envs/<scenario>/
#
# Each scenario installs dbt-duckdb (latest 1.8.x for speed — small install).
# We only need `dbt --version` to work; we don't need to run dbt commands.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENVS_DIR="$SCRIPT_DIR/../.dbt-resolve-envs"
# Use a fast, pinned version for all scenarios
DBT_SPEC="dbt-duckdb>=1.8,<1.9"
# Timeout per scenario (seconds)
TIMEOUT=120

mkdir -p "$ENVS_DIR"

# --- Helpers ---

has() { command -v "$1" &>/dev/null; }

ok() { echo "  ✓ $1"; }
skip() { echo "  ⊘ $1 — skipped ($2)"; }
fail() { echo "  ✗ $1 — $2"; }

# Find a real (non-shim) python3 for venv creation
find_real_python() {
  # Try pyenv's actual python first
  if has pyenv; then
    local p
    p=$(pyenv which python3 2>/dev/null) && [ -x "$p" ] && echo "$p" && return
  fi
  # Try common locations
  for p in /usr/bin/python3 /usr/local/bin/python3 /opt/homebrew/bin/python3; do
    [ -x "$p" ] && echo "$p" && return
  done
  # Fallback
  which python3 2>/dev/null
}

REAL_PYTHON=$(find_real_python)
echo "Using Python: $REAL_PYTHON ($($REAL_PYTHON --version 2>&1))"

# --- Scenarios ---

setup_venv() {
  local dir="$ENVS_DIR/venv"
  if [ -f "$dir/.done" ]; then ok "venv (cached)"; return; fi
  rm -rf "$dir"
  echo "  → Setting up venv..."
  "$REAL_PYTHON" -m venv "$dir"
  "$dir/bin/pip" install --quiet --upgrade pip
  "$dir/bin/pip" install --quiet "$DBT_SPEC"
  touch "$dir/.done"
  ok "venv ($("$dir/bin/dbt" --version 2>&1 | grep -oE 'installed:\s+\S+' | head -1))"
}

setup_uv() {
  local dir="$ENVS_DIR/uv"
  if ! has uv; then skip "uv" "uv not installed"; return; fi
  if [ -f "$dir/.done" ]; then ok "uv (cached)"; return; fi
  rm -rf "$dir"
  echo "  → Setting up uv..."
  mkdir -p "$dir"
  # uv project mode: create .venv in dir
  uv venv "$dir/.venv" --quiet
  uv pip install --quiet --python "$dir/.venv/bin/python" "$DBT_SPEC"
  touch "$dir/.done"
  ok "uv ($("$dir/.venv/bin/dbt" --version 2>&1 | grep -oE 'installed:\s+\S+' | head -1))"
}

setup_pipx() {
  local dir="$ENVS_DIR/pipx"
  if ! has pipx; then skip "pipx" "pipx not installed"; return; fi
  if [ -f "$dir/.done" ]; then ok "pipx (cached)"; return; fi
  rm -rf "$dir"
  echo "  → Setting up pipx..."
  mkdir -p "$dir/bin" "$dir/venvs"
  # Use custom PIPX_HOME/BIN_DIR so we don't pollute the real pipx
  PIPX_HOME="$dir/venvs" PIPX_BIN_DIR="$dir/bin" pipx install dbt-core --include-deps --python "$REAL_PYTHON" 2>/dev/null || true
  PIPX_HOME="$dir/venvs" PIPX_BIN_DIR="$dir/bin" pipx inject dbt-core dbt-duckdb 2>/dev/null || true
  if [ -x "$dir/bin/dbt" ]; then
    touch "$dir/.done"
    ok "pipx ($("$dir/bin/dbt" --version 2>&1 | grep -oE 'installed:\s+\S+' | head -1))"
  else
    fail "pipx" "dbt binary not created"
  fi
}

setup_conda() {
  local dir="$ENVS_DIR/conda"
  if ! has conda; then skip "conda" "conda not installed"; return; fi
  if [ -f "$dir/.done" ]; then ok "conda (cached)"; return; fi
  rm -rf "$dir"
  echo "  → Setting up conda..."
  conda create -y -p "$dir" python=3.11 --quiet 2>/dev/null
  # Install dbt via pip inside the conda env
  "$dir/bin/pip" install --quiet "$DBT_SPEC" 2>/dev/null
  if [ -x "$dir/bin/dbt" ]; then
    touch "$dir/.done"
    ok "conda ($("$dir/bin/dbt" --version 2>&1 | grep -oE 'installed:\s+\S+' | head -1))"
  else
    fail "conda" "dbt binary not created"
  fi
}

setup_poetry() {
  local dir="$ENVS_DIR/poetry"
  if ! has poetry; then skip "poetry" "poetry not installed"; return; fi
  if [ -f "$dir/.done" ]; then ok "poetry (cached)"; return; fi
  rm -rf "$dir"
  echo "  → Setting up poetry (in-project venv)..."
  mkdir -p "$dir"
  cd "$dir"
  # Create a minimal pyproject.toml
  cat > pyproject.toml << 'PYPROJECT'
[tool.poetry]
name = "dbt-resolve-test"
version = "0.1.0"
description = "test"

[tool.poetry.dependencies]
python = "^3.9"

[build-system]
requires = ["poetry-core"]
build-backend = "poetry.core.masonry.api"
PYPROJECT
  # Force in-project venv
  poetry config virtualenvs.in-project true --local 2>/dev/null
  poetry env use "$REAL_PYTHON" 2>/dev/null || true
  poetry run pip install --quiet "$DBT_SPEC" 2>/dev/null
  cd - >/dev/null
  if [ -x "$dir/.venv/bin/dbt" ]; then
    touch "$dir/.done"
    ok "poetry ($("$dir/.venv/bin/dbt" --version 2>&1 | grep -oE 'installed:\s+\S+' | head -1))"
  else
    fail "poetry" "dbt binary not created"
  fi
}

setup_pyenv_venv() {
  # Simulates a pyenv user who creates a venv with their pyenv-managed python
  local dir="$ENVS_DIR/pyenv-venv"
  if ! has pyenv; then skip "pyenv-venv" "pyenv not installed"; return; fi
  if [ -f "$dir/.done" ]; then ok "pyenv-venv (cached)"; return; fi
  rm -rf "$dir"
  echo "  → Setting up pyenv + venv..."
  local pyenv_python
  pyenv_python=$(pyenv which python3 2>/dev/null || echo "")
  if [ -z "$pyenv_python" ]; then skip "pyenv-venv" "no python3 in pyenv"; return; fi
  "$pyenv_python" -m venv "$dir"
  "$dir/bin/pip" install --quiet --upgrade pip
  "$dir/bin/pip" install --quiet "$DBT_SPEC"
  touch "$dir/.done"
  ok "pyenv-venv ($("$dir/bin/dbt" --version 2>&1 | grep -oE 'installed:\s+\S+' | head -1))"
}

setup_system_pip() {
  # Uses whatever `dbt` is already on PATH (if any)
  local dir="$ENVS_DIR/system"
  local sys_dbt
  sys_dbt=$(which dbt 2>/dev/null || echo "")
  if [ -z "$sys_dbt" ]; then skip "system" "no dbt on PATH"; return; fi
  rm -rf "$dir"
  mkdir -p "$dir"
  # Just record the system dbt path
  echo "$sys_dbt" > "$dir/dbt-path"
  echo "$(dirname "$sys_dbt")" > "$dir/bin-dir"
  touch "$dir/.done"
  ok "system ($($sys_dbt --version 2>&1 | grep -oE 'installed:\s+\S+' | head -1) at $sys_dbt)"
}

# --- Main ---

ALL_SCENARIOS=(venv uv pipx conda poetry pyenv-venv system)

if [ $# -gt 0 ]; then
  SCENARIOS=("$@")
else
  SCENARIOS=("${ALL_SCENARIOS[@]}")
fi

echo "Setting up dbt resolve e2e environments..."
echo ""

for scenario in "${SCENARIOS[@]}"; do
  case "$scenario" in
    venv)       setup_venv ;;
    uv)         setup_uv ;;
    pipx)       setup_pipx ;;
    conda)      setup_conda ;;
    poetry)     setup_poetry ;;
    pyenv-venv) setup_pyenv_venv ;;
    system)     setup_system_pip ;;
    *) echo "  ? Unknown scenario: $scenario" ;;
  esac
done

echo ""
echo "Environments ready in $ENVS_DIR"
echo ""
echo "Available scenarios:"
for scenario in "${SCENARIOS[@]}"; do
  if [ -f "$ENVS_DIR/$scenario/.done" ]; then
    echo "  ✓ $scenario"
  else
    echo "  ✗ $scenario (not set up)"
  fi
done
