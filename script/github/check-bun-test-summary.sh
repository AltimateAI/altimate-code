#!/usr/bin/env bash
# Checks the saved output of one or more `bun test` runs and fails CI on a real test failure.
#
# Bun 1.3.x can segfault during process cleanup after every test passed (exit 143/SIGTERM or
# 134/SIGABRT), so the CI steps ignore bun's exit code and parse its summary lines instead. Each
# file must hold one run's output. Fails when any run reports failures, when a run printed no
# summary (bun crashed before finishing), or when nothing passed at all.
#
# Usage: check-bun-test-summary.sh <output-file>...
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <output-file>..." >&2
  exit 2
fi

sum_field() { awk -v f="$1" '$0 ~ ("^ *[0-9]+ " f "$"){s+=$1} END{print s+0}' "${@:2}"; }
PASS_COUNT=$(sum_field pass "$@")
FAIL_COUNT=$(sum_field fail "$@")

echo ""
echo "--- Test Summary ($# runs) ---"
echo "pass=$PASS_COUNT fail=$FAIL_COUNT"

if [ "$FAIL_COUNT" != "0" ]; then
  echo "::error::$FAIL_COUNT test(s) failed"
  exit 1
fi

for file in "$@"; do
  if ! grep -qE "^ *[0-9]+ pass$" "$file"; then
    echo "::error::Missing test summary in $file — Bun may have crashed before running tests"
    exit 1
  fi
done

if [ "$PASS_COUNT" -gt 0 ] 2>/dev/null; then
  exit 0
fi
echo "::error::No test results found"
exit 1
