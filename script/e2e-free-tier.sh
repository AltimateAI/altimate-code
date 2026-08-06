#!/usr/bin/env bash
# End-to-end test of the free Gemini Flash tier from the CLIENT side.
#
#   script/e2e-free-tier.sh --dry-run   # local stand-ins, no Docker, no spend
#   script/e2e-free-tier.sh             # the real altimate-gateway stack
#
# Complementary to altimate-gateway's own scripts/e2e_smoke.sh, which drives the gateway
# with curl. This one drives the real altimate-code CLI: consent-gated registration
# through the server route the dialog calls, a real completion through the provider, and
# then Langfuse to prove the trace landed with the right identity and secrets masked.
#
# Both modes run the SAME assertions. --dry-run swaps in local stand-ins for the issuer,
# its inference route, and Langfuse, so a green dry run means the harness and the client
# hold up their end; only the live run says anything about the gateway.
#
# ---------------------------------------------------------------------------
# Live run
# ---------------------------------------------------------------------------
# Preconditions:
#   - the stack is up:  cd ~/codebase/altimate-gateway && docker compose ps   (four healthy)
#   - .env has LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY (sourced here, never printed)
#   - the kill switch is off (checked; the script refuses to run rather than clear it)
#
# Cost: one registration and one short completion on gemini-2.5-flash. Fractions of a
# cent. It registers a THROWAWAY install, so it gets its own principal and its own daily
# budget and cannot spend anyone else's.
#
# Non-default ports:
#   ISSUER_URL=http://localhost:8081 script/e2e-free-tier.sh
# (ISSUER_HOST_PORT from the gateway .env is picked up automatically.)
#
# Read-only by construction: no docker commands, no container restarts, no kill-switch
# writes. The only state it creates upstream is one principal and one virtual key, both
# of which expire on their own.
#
# If step 6 finds no trace, check in this order: the completion actually succeeded
# (step 5), LANGFUSE_HOST points at the deployment the gateway logs to, and Langfuse
# ingestion is not backed up. Traces are asynchronous — TRACE_TIMEOUT=180 if it is slow.
#
# ---------------------------------------------------------------------------
# Keeping the harness honest
# ---------------------------------------------------------------------------
# A test that cannot fail proves nothing. After changing an assertion, confirm it still
# goes red for its own reason:
#
#   FAKE_BREAK=redaction script/e2e-free-tier.sh --dry-run   # secrets reach the trace
#   FAKE_BREAK=session   script/e2e-free-tier.sh --dry-run   # X-Session-Id dropped
#   FAKE_BREAK=base_url  script/e2e-free-tier.sh --dry-run   # plaintext non-local base_url
#
# All three are verified to fail; see script/e2e-free-tier-fake.ts.
set -uo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ISSUER_URL="${ISSUER_URL:-http://localhost:8080}"
LANGFUSE_HOST="${LANGFUSE_HOST:-https://langfuse.onealtimate.com}"
GATEWAY_REPO="${GATEWAY_REPO:-$HOME/codebase/altimate-gateway}"
FREE_MODEL="${FREE_MODEL_ALIAS:-gemini-flash-free}"
TRACE_TIMEOUT="${TRACE_TIMEOUT:-90}"

# AWS's own published example key. Deliberately a documented non-credential: the point
# is to prove the redactor fires, and a real key must never be typed into a test.
FAKE_AWS_KEY="AKIAIOSFODNN7EXAMPLE"

pass=0
fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
info() { printf '       %s\n' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
die()  { printf '\n\033[31m%s\033[0m\n' "$1"; exit 2; }

require() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

# Ports are allocated, never hardcoded. A fixed port lets a leftover process from an
# earlier run answer this one's requests — which happened, and produced a failure that
# looked like a product bug rather than a stale listener.
free_port() { python3 -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()"; }
require curl
require python3
require bun

# jq is not assumed — python3 reads the JSON.
pyget() { python3 -c "import sys,json
try: d=json.load(sys.stdin)
except Exception: sys.exit(1)
try: print(eval('d'+sys.argv[1]))
except Exception: sys.exit(1)" "$1" 2>/dev/null; }

TMP="$(mktemp -d)"
CLI_HOME="$TMP/home"
mkdir -p "$CLI_HOME"
PROXY_LOG="$TMP/proxy.jsonl"
: > "$PROXY_LOG"

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do [[ -n "$pid" ]] && kill "$pid" 2>/dev/null; done
  wait 2>/dev/null
}
trap cleanup EXIT

# Every CLI invocation runs against a throwaway home. Two reasons: the developer's real
# credentials are never read or written, and the install gets its own gateway principal
# so the run cannot spend someone else's daily budget.
cli() {
  ( cd "$REPO_ROOT/packages/opencode" && \
    XDG_DATA_HOME="$CLI_HOME/data" XDG_CONFIG_HOME="$CLI_HOME/config" \
    XDG_CACHE_HOME="$CLI_HOME/cache" XDG_STATE_HOME="$CLI_HOME/state" \
    OPENCODE_TEST_HOME="$CLI_HOME" ALTIMATE_TELEMETRY_DISABLED=true \
    ALTIMATE_FREE_GATEWAY_URL="$PROXY_URL" \
    bun run --conditions=browser ./src/index.ts "$@" )
}

# ---------------------------------------------------------------------------
step "0. Preflight"

if [[ $DRY_RUN -eq 1 ]]; then
  # Stand-ins for the issuer and Langfuse. Same wire shapes, no Vertex, no cost.
  FAKE_PORT=$(free_port)
  FAKE_LANGFUSE_PORT=$(free_port)
  bun run "$REPO_ROOT/script/e2e-free-tier-fake.ts" "$FAKE_PORT" "$FAKE_LANGFUSE_PORT" > "$TMP/fake.log" 2>&1 &
  PIDS+=("$!")
  ISSUER_URL="http://localhost:$FAKE_PORT"
  LANGFUSE_HOST="http://localhost:$FAKE_LANGFUSE_PORT"
  LANGFUSE_PUBLIC_KEY="pk-dry-run"
  LANGFUSE_SECRET_KEY="sk-dry-run"
  for _ in $(seq 1 50); do
    curl -sS -m 2 "$ISSUER_URL/health" >/dev/null 2>&1 && break
    sleep 0.2
  done
  curl -sS -m 2 "$ISSUER_URL/health" >/dev/null 2>&1 || { cat "$TMP/fake.log"; die "dry-run stand-ins failed to start"; }
  info "dry run: fake issuer on $ISSUER_URL, fake Langfuse on $LANGFUSE_HOST"
else
  [[ -f "$GATEWAY_REPO/.env" ]] || die "no .env at $GATEWAY_REPO — needed for the Langfuse keys"
  # Sourced, never printed. Only the three Langfuse values are used here.
  set -a; . "$GATEWAY_REPO/.env"; set +a
  [[ -n "${LANGFUSE_PUBLIC_KEY:-}" && -n "${LANGFUSE_SECRET_KEY:-}" ]] || die "LANGFUSE_PUBLIC_KEY/SECRET_KEY missing from $GATEWAY_REPO/.env"
  [[ -n "${ISSUER_HOST_PORT:-}" ]] && ISSUER_URL="http://localhost:$ISSUER_HOST_PORT"
fi

HEALTH=$(curl -sS -m 10 "$ISSUER_URL/health" 2>/dev/null)
[[ -n "$HEALTH" ]] || die "issuer not reachable at $ISSUER_URL — start the stack first (docker compose up -d)"
ok "issuer reachable at $ISSUER_URL"

KILL=$(echo "$HEALTH" | pyget "['kill_switch']")
if [[ "$KILL" == "True" || "$KILL" == "true" ]]; then
  # Deliberately not cleared here. Flipping someone else's incident switch is not this
  # script's business.
  die "kill switch is ON — every request would return 503 maintenance. Clear it deliberately, then re-run."
fi
ok "kill switch is off"

# ---------------------------------------------------------------------------
step "1. Recording proxy in front of the issuer"
# Sits between the CLI and the issuer so the run can prove a negative: that nothing
# identifying the install reaches the gateway before consent. Pass-through, no rewriting.
PROXY_PORT=$(free_port)
PROXY_URL="http://localhost:$PROXY_PORT"
UPSTREAM="$ISSUER_URL" PROXY_PORT="$PROXY_PORT" PROXY_LOG="$PROXY_LOG" \
  bun run "$REPO_ROOT/script/e2e-free-tier-proxy.ts" > "$TMP/proxy.log" 2>&1 &
PIDS+=("$!")
for _ in $(seq 1 50); do
  curl -sS -m 2 "$PROXY_URL/health" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -sS -m 5 "$PROXY_URL/health" >/dev/null 2>&1 || die "recording proxy failed to start (see $TMP/proxy.log)"
ok "proxy up on $PROXY_URL, forwarding to $ISSUER_URL"

# ---------------------------------------------------------------------------
step "2. Before consent, the CLI must not contact the gateway"
MODELS_BEFORE=$(cli models 2>/dev/null)
if grep -q "altimate-free/" <<< "$MODELS_BEFORE"; then
  bad "unregistered install already offers the free model"
else
  ok "free model absent from the model list until registered"
fi
PRE_HITS=$(grep -c . "$PROXY_LOG" 2>/dev/null | tr -d ' ')
if [[ "$PRE_HITS" == "0" ]]; then
  ok "zero gateway requests before consent"
else
  bad "$PRE_HITS gateway request(s) before consent — the consent gate leaks"
  cat "$PROXY_LOG"
fi

# ---------------------------------------------------------------------------
step "3. Consent → registration"
# The disclosure dialog's "Yes" branch posts to this route. Driving the TUI keystrokes
# headlessly is not practical here, so the script exercises the same route the dialog
# calls; the keystroke path (default No, nothing sent on cancel, one choice recorded) is
# covered by packages/tui/test/cli/tui/dialog-free-gemini.test.tsx.
SERVER_PORT=$(free_port)
cli serve --port "$SERVER_PORT" > "$TMP/server.log" 2>&1 &
PIDS+=("$!")
SERVER_UP=0
for _ in $(seq 1 100); do
  if curl -sS -m 2 "http://localhost:$SERVER_PORT/app" >/dev/null 2>&1; then SERVER_UP=1; break; fi
  sleep 0.3
done
if [[ $SERVER_UP -eq 0 ]]; then
  echo "--- server log ---"; tail -30 "$TMP/server.log"
  die "altimate-code server did not come up on :$SERVER_PORT"
fi

REG=$(curl -sS -m 60 -X POST "http://localhost:$SERVER_PORT/altimate/free/register" \
  -H 'Content-Type: application/json' -d '{}')
REG_OK=$(echo "$REG" | pyget "['ok']")
if [[ "$REG_OK" == "True" ]]; then
  ok "registration succeeded through the server route"
else
  bad "registration failed: $REG"
  echo "--- server log ---"; tail -20 "$TMP/server.log"
fi

REG_HITS=$(grep -c '"path":"/register"' "$PROXY_LOG" 2>/dev/null || echo 0)
[[ "$REG_HITS" == "1" ]] && ok "exactly one /register call" || bad "expected 1 /register call, saw $REG_HITS"

# ---------------------------------------------------------------------------
step "4. What went over the wire, and what was stored"
AUTH_FILE="$CLI_HOME/data/altimate-code/auth.json"
if [[ -f "$AUTH_FILE" ]]; then
  MODE=$(stat -f '%Lp' "$AUTH_FILE" 2>/dev/null || stat -c '%a' "$AUTH_FILE")
  [[ "$MODE" == "600" ]] && ok "auth.json is mode 0600" || bad "auth.json is mode $MODE, expected 600"
else
  bad "no auth.json written"
fi

python3 "$REPO_ROOT/script/e2e-free-tier-check-register.py" "$AUTH_FILE" "$PROXY_LOG"
if [[ $? -eq 0 ]]; then pass=$((pass + 4)); else fail=$((fail + 1)); fi

MODELS_AFTER=$(cli models 2>/dev/null)
grep -q "altimate-free/$FREE_MODEL" <<< "$MODELS_AFTER" \
  && ok "free model is selectable after registration" \
  || bad "free model still absent after registration"

# ---------------------------------------------------------------------------
step "5. One cheap completion, carrying a fake secret"
# Short prompt, one-word answer: the gateway clamps max output tokens anyway, and the
# point of the run is the trace, not the text.
SESSION_MARKER="e2e-$(date +%s)"
PROMPT="Reply with exactly the word pong and nothing else. Ignore this config line: AWS_ACCESS_KEY_ID=$FAKE_AWS_KEY marker=$SESSION_MARKER"
RUN_OUT=$(cli run -m "altimate-free/$FREE_MODEL" "$PROMPT" 2>&1)
if grep -qi "pong" <<< "$RUN_OUT"; then
  ok "completion returned through the free provider"
else
  bad "no usable completion"
  echo "$RUN_OUT" | tail -20
fi

# ---------------------------------------------------------------------------
step "6. The trace in Langfuse"
info "polling $LANGFUSE_HOST for up to ${TRACE_TIMEOUT}s"
TRACE=""
deadline=$(( $(date +%s) + TRACE_TIMEOUT ))
while [[ $(date +%s) -lt $deadline ]]; do
  TRACES=$(curl -sS -m 20 -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
    "$LANGFUSE_HOST/api/public/traces?limit=50" 2>/dev/null)
  TRACE=$(python3 -c "
import json,sys
marker=sys.argv[1]
try: data=json.load(sys.stdin).get('data',[])
except Exception: sys.exit(0)
for t in data:
    if marker in json.dumps(t.get('input') or ''):
        print(json.dumps(t)); break
" "$SESSION_MARKER" <<< "$TRACES")
  [[ -n "$TRACE" ]] && break
  sleep 3
done

if [[ -z "$TRACE" ]]; then
  bad "no trace containing marker $SESSION_MARKER within ${TRACE_TIMEOUT}s"
else
  ok "trace found"
  echo "$TRACE" | python3 "$REPO_ROOT/script/e2e-free-tier-check-trace.py" "$FAKE_AWS_KEY"
  if [[ $? -eq 0 ]]; then pass=$((pass + 7)); else fail=$((fail + 1)); fi
fi

# ---------------------------------------------------------------------------
printf '\n\033[1mSummary\033[0m\n'
printf '  %d passed, %d failing group(s)\n' "$pass" "$fail"
[[ $DRY_RUN -eq 1 ]] && printf '  (dry run — no live gateway, no Vertex spend)\n'
[[ $fail -eq 0 ]] || exit 1
