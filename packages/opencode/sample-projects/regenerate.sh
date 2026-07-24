#!/usr/bin/env bash
# Regenerate the pre-compiled target/manifest.json that ships alongside the
# jaffle-shop-duckdb starter sample. Run this after editing any source file
# under jaffle-shop-duckdb/{dbt_project.yml,profiles.yml,models,seeds},
# then commit the refreshed target/manifest.json in the same commit as the
# source change.
#
# The freshness test (jaffle-shop-duckdb/verify-freshness.test.ts) will
# fail if source hashes don't match what the committed manifest was
# generated from — that's the guard against a source edit landing without
# a matching artifact refresh.
#
# Requires: dbt-core + dbt-duckdb on PATH.
set -euo pipefail

SAMPLE_DIR="$(cd "$(dirname "$0")/jaffle-shop-duckdb" && pwd)"
cd "$SAMPLE_DIR"

if ! command -v dbt >/dev/null 2>&1; then
  echo "ERROR: dbt is not on PATH. Install with: pip install dbt-duckdb" >&2
  exit 127
fi

# Compile against the sample's own profile file (not the user's ~/.dbt/profiles.yml).
export DBT_PROFILES_DIR="$SAMPLE_DIR"

# Clean stale artifacts so what we commit is fully derived from current source.
rm -rf target dbt_packages

# `dbt compile` produces target/manifest.json and target/graph.gpickle. We only
# ship manifest.json (graph.gpickle is a Python pickle and adds no value for
# our TypeScript consumers). `dbt parse` also produces manifest.json but omits
# the compiled_code field, which /review needs — so we compile.
dbt compile --project-dir "$SAMPLE_DIR" --profiles-dir "$SAMPLE_DIR"

# Sanitize the manifest so no committed bytes are host-specific:
#   1. Replace the absolute sample path with the {{SAMPLE_ROOT}} sentinel.
#      Sample-project loader in altimate-code substitutes this back to the
#      user's materialized target path at load time.
#   2. Zero out `generated_at` and `invocation_id` so the committed diff
#      only changes when source changes, not when a maintainer re-runs.
python3 - "$SAMPLE_DIR/target/manifest.json" "$SAMPLE_DIR" <<'PY'
import json, sys, re
path, sample_dir = sys.argv[1], sys.argv[2]
with open(path) as f:
    text = f.read()
# Replace the resolved absolute path (host-specific) with a sentinel.
text = text.replace(sample_dir, "{{SAMPLE_ROOT}}")
# Some dbt implementations also embed the parent packages/opencode/sample-projects
# path prefix in a couple of metadata fields — strip anything above the sample.
parent = sample_dir.rsplit("/", 1)[0]
text = text.replace(parent, "{{SAMPLE_ROOT_PARENT}}")
obj = json.loads(text)
if isinstance(obj.get("metadata"), dict):
    obj["metadata"]["generated_at"] = "1970-01-01T00:00:00Z"
    obj["metadata"]["invocation_id"] = "00000000-0000-0000-0000-000000000000"
    # env can carry USER, PWD, HOME — strip it entirely.
    obj["metadata"].pop("env", None)
with open(path, "w") as f:
    json.dump(obj, f, indent=2, sort_keys=True)
    f.write("\n")
PY

# Force-include the committed manifest despite the .gitignore exclusion of
# target/ (the .gitignore has an explicit `!target/manifest.json` re-include).
git -C "$SAMPLE_DIR/../../.." add -f "$SAMPLE_DIR/target/manifest.json"

echo ""
echo "Regenerated + sanitized $SAMPLE_DIR/target/manifest.json"
echo "Stage + commit alongside your source change."
