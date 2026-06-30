#!/usr/bin/env bash
# Shared helpers for demo-creator scripts. Source this; don't run directly.
set -euo pipefail

# Repo root = three levels up from .claude/skills/demo-creator/scripts/
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"

demo_dir() {   # demo_dir <topic-slug>
  echo "$REPO_ROOT/demos/$1"
}

need() {       # need <cmd> [brew-pkg]
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: '$1' not found. Install: brew install ${2:-$1}" >&2
    return 1
  fi
}

log() { printf '\033[36m[demo-creator]\033[0m %s\n' "$*" >&2; }
