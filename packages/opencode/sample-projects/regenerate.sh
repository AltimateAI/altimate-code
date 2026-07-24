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
#   1. Replace the absolute sample path with the {{SAMPLE_ROOT}} sentinel
#      ONLY inside JSON string values — never in object keys and never at
#      the raw-text level. A raw text.replace() would silently mangle any
#      legitimate string in the manifest that happens to contain the
#      maintainer's home directory (e.g. a model description or a compiled
#      SQL literal referencing a real path).
#   2. Zero `invocation_id` and pin `generated_at` to a fixed "release day"
#      timestamp so committed diffs only change when source changes. Zero
#      epoch is avoided because some downstream freshness-check tools may
#      treat it as pathological — a plausible past date is safer.
python3 - "$SAMPLE_DIR/target/manifest.json" "$SAMPLE_DIR" <<'PY'
import json, sys, os
manifest_path, sample_dir = sys.argv[1], sys.argv[2]
sample_dir = os.path.abspath(sample_dir)
parent_dir = os.path.dirname(sample_dir)
SENTINEL_ROOT = "{{SAMPLE_ROOT}}"
SENTINEL_PARENT = "{{SAMPLE_ROOT_PARENT}}"

def replace_paths(v):
    if isinstance(v, str):
        if sample_dir in v or parent_dir in v:
            return v.replace(sample_dir, SENTINEL_ROOT).replace(parent_dir, SENTINEL_PARENT)
        return v
    if isinstance(v, list):
        return [replace_paths(x) for x in v]
    if isinstance(v, dict):
        return {k: replace_paths(x) for k, x in v.items()}
    return v

with open(manifest_path) as f:
    obj = json.load(f)
obj = replace_paths(obj)
if isinstance(obj.get("metadata"), dict):
    # Fixed sentinel timestamp — updated only when a maintainer wants to
    # signal a manifest-shape refresh; source changes alone don't bump it.
    obj["metadata"]["generated_at"] = "2026-07-24T00:00:00Z"
    obj["metadata"]["invocation_id"] = "00000000-0000-0000-0000-000000000000"
    # env can carry USER, PWD, HOME — strip it entirely.
    obj["metadata"].pop("env", None)
with open(manifest_path, "w") as f:
    json.dump(obj, f, indent=2, sort_keys=True)
    f.write("\n")
PY

# Force-include the committed manifest despite the .gitignore exclusion of
# target/ (the .gitignore has an explicit `!target/manifest.json` re-include).
git -C "$SAMPLE_DIR/../../.." add -f "$SAMPLE_DIR/target/manifest.json"

echo ""
echo "Regenerated + sanitized $SAMPLE_DIR/target/manifest.json"
echo "Stage + commit alongside your source change."
