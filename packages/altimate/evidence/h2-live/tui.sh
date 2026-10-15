#!/bin/zsh
source /private/tmp/claude-501/-Users-anandgupta-codebase-altimate-code/a3ba8813-c4f4-4234-9efe-d5c7103ee560/scratchpad/h2live/env.sh
cd $CK/packages/cli
if [[ -n "$PRELOAD" ]]; then exec bun --preload $PRE src/index.ts "$@"; else exec bun src/index.ts "$@"; fi
