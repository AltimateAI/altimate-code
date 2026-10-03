#!/bin/bash
# End-to-end demo: user A publishes a skill, user B receives it on the next session.
# usage: demo.sh [scratch-parent] (default: ./.demo). Creates a fresh child each run.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/../../../packages/opencode" && pwd)"
SCRATCH="${1:-$HERE/.demo}"
mkdir -p -- "$SCRATCH"
S="$(mktemp -d "$(cd "$SCRATCH" && pwd)/demo.XXXXXX")"
REMOTE=https://example.test/demo/rsi-demo.git   # must be a URL: bare local paths are dropped by detect.ts
MODEL="${MODEL:-${AGENT_MODEL:-google-vertex/gemini-3.5-flash}}"
PORT="${PORT:-18787}"

echo "Demo artifacts: $S"
for u in a b; do
  mkdir -p "$S/repo-$u" "$S/home-$u/.altimate"
  (cd "$S/repo-$u" && git init -q && git remote add origin "$REMOTE")
  echo "{\"altimateUrl\":\"http://127.0.0.1:$PORT\",\"altimateInstanceName\":\"demo\",\"altimateApiKey\":\"token-user-$u\"}" > "$S/home-$u/.altimate/altimate.json"
done

FAKE_STATE="$S/state.json" FAKE_SEED_REMOTE="$REMOTE" FAKE_TENANT=demo FAKE_DEBUG_TOKEN= \
  FAKE_TOKENS='{"token-user-a":{"user_id":1,"email":"a@demo.test"},"token-user-b":{"user_id":2,"email":"b@demo.test"}}' \
  PORT=$PORT bun "$HERE/server.ts" > "$S/server.log" 2>&1 &
SERVER=$!; trap 'kill "$SERVER" 2>/dev/null || true' EXIT; sleep 1.5
kill -0 "$SERVER" # Fail if the port was occupied or the backend could not start.

# run-as <a|b> <altimate-code args...>: isolated HOME/XDG so the real ~/.altimate is never read.
run_as() {
  local u=$1; shift
  case "$u" in a|b) ;; *) echo "Unknown demo user: $u" >&2; return 2 ;; esac
  (cd "$S/repo-$u" && HOME="$S/home-$u" OPENCODE_TEST_HOME="$S/home-$u" XDG_DATA_HOME="$S/home-$u/.local/share" XDG_CONFIG_HOME="$S/home-$u/.config" \
    XDG_CACHE_HOME="$S/home-$u/.cache" XDG_STATE_HOME="$S/home-$u/.local/state" OPENCODE_TEST_STATE_HOME="$S/home-$u/.local/state" ALTIMATE_WORKSPACE=1 \
    ALTIMATE_ENTRYPOINT="$PKG/src/index.ts" python3 -c 'import os, shlex, sys
cmd = shlex.split(os.environ["ALTIMATE_CMD"]) if os.environ.get("ALTIMATE_CMD") else ["bun", "run", "--conditions=browser", os.environ["ALTIMATE_ENTRYPOINT"]]
os.execvp(cmd[0], cmd + sys.argv[1:])' "$@")
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
