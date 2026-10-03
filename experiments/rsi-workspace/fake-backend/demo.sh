#!/bin/bash
# End-to-end demo: user A publishes a skill, user B receives it on the next session.
# usage: demo.sh [scratch-dir]   (default: ./.demo). Needs bun, git, and the repo's node_modules.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/../../../packages/opencode" && pwd)"
S="$(mkdir -p "${1:-$HERE/.demo}" && cd "${1:-$HERE/.demo}" && pwd)"
REMOTE=https://example.test/demo/rsi-demo.git   # must be a URL: bare local paths are dropped by detect.ts
MODEL="${MODEL:-google-vertex-anthropic/claude-haiku-4-5@20251001}"
PORT=18787

rm -rf "$S"/repo-* "$S"/home-* "$S"/state.json
for u in a b; do
  mkdir -p "$S/repo-$u" "$S/home-$u/.altimate"
  (cd "$S/repo-$u" && git init -q && git remote add origin "$REMOTE")
  echo "{\"altimateUrl\":\"http://127.0.0.1:$PORT\",\"altimateInstanceName\":\"demo\",\"altimateApiKey\":\"token-user-$u\"}" > "$S/home-$u/.altimate/altimate.json"
done

FAKE_STATE="$S/state.json" FAKE_SEED_REMOTE="$REMOTE" PORT=$PORT bun "$HERE/server.ts" > "$S/server.log" 2>&1 &
SERVER=$!; trap 'kill $SERVER' EXIT; sleep 1.5

# run-as <a|b> <altimate-code args...>: isolated HOME/XDG so the real ~/.altimate is never read.
run_as() {
  local u=$1; shift
  (cd "$S/repo-$u" && HOME="$S/home-$u" XDG_DATA_HOME="$S/home-$u/.local/share" XDG_CONFIG_HOME="$S/home-$u/.config" \
    XDG_CACHE_HOME="$S/home-$u/.cache" XDG_STATE_HOME="$S/home-$u/.local/state" ALTIMATE_WORKSPACE=1 \
    bun run --conditions=browser "$PKG/src/index.ts" "$@")
}

mkdir -p "$S/repo-a/.altimate-code/skill/dbt-incremental-gotcha"
cat > "$S/repo-a/.altimate-code/skill/dbt-incremental-gotcha/SKILL.md" <<'EOF'
---
name: dbt-incremental-gotcha
description: Learned tip - always filter incremental dbt models with is_incremental() on the updated_at watermark.
---
When editing an incremental dbt model, wrap the filter in `{% if is_incremental() %}` using the max `updated_at` of `{{ this }}`.
EOF

echo "== user A: publish"; run_as a skill publish dbt-incremental-gotcha
echo "== user B: first session (bind-time sync)"; run_as b run -m "$MODEL" "Reply with just the word ok."
echo "== B received:"; find "$S/repo-b/.altimate-code/skill/_workspace" -name SKILL.md
echo "== server log"; cat "$S/server.log"
