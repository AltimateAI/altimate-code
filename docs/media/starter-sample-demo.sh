#!/usr/bin/env bash
# Helper for docs/media/starter-sample.tape — the tape shells out here
# because VHS's `Type` command doesn't play well with escaped nested
# quotes and long semicolon-chained one-liners. Keeping the demo logic
# in a real script also lets a reader `bash` this file directly for a
# non-recorded reproduction.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel)}"
STAGE_DIR="${STAGE_DIR:-$HOME/altimate-sample-demo}"
ACTION="${1:-materialize}"

MATERIALIZE_SCRIPT='
const { materializeSample } = await import(
  "'"$REPO_ROOT"'/packages/opencode/src/altimate/onboarding/materialize.ts",
);
const preferredTargetName = "altimate-sample-demo";
const r = await materializeSample({
  preferredTargetName,
  sampleVersion: "1.0.0",
  cliVersion: "0.9.4-preview",
});
console.log("→", r.targetPath);
console.log("  reused:", r.reused);
console.log("  note:", r.note);
'

case "$ACTION" in
  materialize)
    cd "$REPO_ROOT"
    bun -e "$MATERIALIZE_SCRIPT"
    ;;
  list)
    ls -la "$STAGE_DIR"
    ;;
  find)
    find "$STAGE_DIR" -type f | sort
    ;;
  marker)
    cat "$STAGE_DIR/.altimate-sample.json"
    ;;
  manifest-size)
    wc -l "$STAGE_DIR/target/manifest.json"
    ;;
  readme)
    head -30 "$STAGE_DIR/README.md"
    ;;
  reused)
    cd "$REPO_ROOT"
    bun -e "$MATERIALIZE_SCRIPT"
    ;;
  cleanup)
    rm -rf "$STAGE_DIR"
    ;;
  *)
    echo "unknown action: $ACTION" >&2
    exit 2
    ;;
esac
