#!/usr/bin/env bash
# Whitelist gate for the SDK codegen-reproducibility CI step (#1148): succeeds
# ONLY when the build log's failure is the tsc stage AND its TypeScript
# diagnostic set is exactly the one known #1148 error. Matching "tsc failed"
# alone would silently whitelist any NEW type regression in the regenerated
# SDK. File(line,col) prefixes are stripped before comparing so line drift
# cannot fake a new failure. Exit codes: 0 = exactly the known failure;
# 2 = not a tsc-stage failure; 3 = tsc failed with a different or larger
# diagnostic set (printed to stderr).
set -uo pipefail
log="${1:?usage: check-known-tsc-failure.sh <build.log>}"
if ! grep -q '"tsc" exited with code' "$log"; then
  echo "not a tsc-stage failure" >&2
  exit 2
fi
# Only genuine tsc-emitted lines count: they start at column 0 with a
# file(line,col) prefix. build.ts also ECHOES the diagnostics inside a
# JSON-stringified error dump (indented, quote-escaped) — counting those
# would double every diagnostic and fail the exact-set comparison. The
# FILENAME stays in the comparison (only line,col are normalized): the
# same diagnostic text surfacing in a second file is a superset, not the
# known failure.
actual="$(grep -E '^[^[:space:]"]+\([0-9]+,[0-9]+\): error TS[0-9]+: ' "$log" | sed -E 's/^([^([:space:]"]+)\([0-9]+,[0-9]+\):/\1(l,c):/; s/[[:space:]]*$//' | sort -u)"
expected="src/v2/client.ts(l,c): error TS2305: Module '\"./gen/types.gen.js\"' has no exported member 'FileSystemEntry'."
if [ "$actual" != "$expected" ]; then
  {
    echo "tsc diagnostics differ from the whitelisted #1148 set:"
    printf '%s\n' "$actual"
  } >&2
  exit 3
fi
exit 0
