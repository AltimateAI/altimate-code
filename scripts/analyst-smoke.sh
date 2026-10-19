#!/usr/bin/env bash
# Run the source-tree analyst smoke suite once. Artifacts are kept for inspection.
# Reassert saved artifacts without LLM calls: ANALYST_SMOKE_REPLAY=/path/to/run ./scripts/analyst-smoke.sh
set -uo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)" || exit 1
worktree_root="$(dirname -- "$script_dir")"

for argument in "$@"; do
  case "$argument" in
    --rerun-each|--rerun-each=*|--retry|--retry=*|--watch|--watch=*|--hot|--hot=*|-w)
      printf 'FAIL | runner | Repeated model execution is not allowed: %s\n' "$argument" >&2
      exit 1
      ;;
  esac
done

# Capture this before bun test's preload replaces HOME/XDG. Never print its contents.
export ANALYST_SMOKE_AUTH_FILE="${ANALYST_SMOKE_AUTH_FILE:-${XDG_DATA_HOME:-$HOME/.local/share}/altimate-code/auth.json}"
if [[ "$ANALYST_SMOKE_AUTH_FILE" != /* ]]; then
  export ANALYST_SMOKE_AUTH_FILE="$PWD/$ANALYST_SMOKE_AUTH_FILE"
fi
export ANALYST_SMOKE_RUN=1
export ALTIMATE_TELEMETRY_DISABLED=true
export OPENCODE_PURE=1

if [[ -n "${ANALYST_SMOKE_REPLAY:-}" ]]; then
  export ANALYST_SMOKE_ARTIFACTS="$ANALYST_SMOKE_REPLAY"
  if [[ ! -d "$ANALYST_SMOKE_ARTIFACTS" ]]; then
    printf 'FAIL | runner | Replay directory does not exist: %s\n' "$ANALYST_SMOKE_ARTIFACTS" >&2
    exit 1
  fi
else
  if [[ -z "${ANALYST_SMOKE_ARTIFACTS:-}" ]]; then
    ANALYST_SMOKE_ARTIFACTS="$(mktemp -d "${TMPDIR:-/tmp}/analyst-smoke.XXXXXX")" || exit 1
  fi
  mkdir -p -- "$ANALYST_SMOKE_ARTIFACTS" || exit 1
fi
ANALYST_SMOKE_ARTIFACTS="$(CDPATH= cd -- "$ANALYST_SMOKE_ARTIFACTS" && pwd)" || exit 1
export ANALYST_SMOKE_ARTIFACTS
if [[ -n "${ANALYST_SMOKE_REPLAY:-}" ]]; then
  export ANALYST_SMOKE_REPLAY="$ANALYST_SMOKE_ARTIFACTS"
fi
export ANALYST_SMOKE_RESULTS="$ANALYST_SMOKE_ARTIFACTS/results.json"
if [[ -e "$ANALYST_SMOKE_RESULTS" ]]; then
  cp -- "$ANALYST_SMOKE_RESULTS" "$ANALYST_SMOKE_ARTIFACTS/results.previous.json" || exit 1
fi
printf '[]\n' > "$ANALYST_SMOKE_RESULTS" || exit 1

cd -- "$worktree_root/packages/opencode" || exit 1
bun test --config=./test/e2e-smoke/bunfig.toml test/e2e-smoke/analyst-smoke.test.ts --timeout 360000 "$@"
test_status=$?

# Print the table even when tests fail. Missing/empty results must never look green.
bun -e '
  import { readFileSync } from "node:fs";
  const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  try {
    const rows = JSON.parse(readFileSync(process.env.ANALYST_SMOKE_RESULTS, "utf8"));
    if (!Array.isArray(rows) || rows.length === 0) throw new Error("No scenario results were recorded");
    console.log("STATUS | SCENARIO | DETAIL");
    let failed = false;
    for (const row of rows) {
      if (!row || !["PASS", "FAIL", "SKIP"].includes(row.status) || !row.id || !row.name) {
        throw new Error("Invalid scenario result in results.json");
      }
      console.log(`${row.status} | ${oneLine(row.id)} ${oneLine(row.name)} | ${oneLine(row.reason)}`);
      failed ||= row.status === "FAIL";
    }
    if (failed) process.exitCode = 1;
  } catch (error) {
    console.error(`FAIL | runner | ${oneLine(error.message)}`);
    process.exitCode = 1;
  }
'
summary_status=$?
printf 'Artifacts: %s\n' "$ANALYST_SMOKE_ARTIFACTS"
if (( test_status != 0 || summary_status != 0 )); then
  exit 1
fi
