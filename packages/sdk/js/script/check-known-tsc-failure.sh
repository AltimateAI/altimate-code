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
actual="$(grep -oE 'error TS[0-9]+: .*' "$log" | sed 's/[[:space:]]*$//' | sort -u)"
expected="error TS2305: Module '\"./gen/types.gen.js\"' has no exported member 'FileSystemEntry'."
if [ "$actual" != "$expected" ]; then
  {
    echo "tsc diagnostics differ from the whitelisted #1148 set:"
    printf '%s\n' "$actual"
  } >&2
  exit 3
fi
exit 0
