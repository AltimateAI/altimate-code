---
name: dbt-project-review
description: >
  Review an ENTIRE dbt project rather than a diff — every model in the manifest,
  plus a deterministic performance pass. Use for "is this project healthy?",
  "what technical debt is in here?", or when onboarding to an unfamiliar dbt
  repo. Reviews a PROJECT; for "is this change safe?" use dbt-pr-review, which
  reviews a diff.
allowed-tools: Bash, Read, Glob, Grep
---

# dbt project review

Runs `altimate review --all` and `altimate dbt-perf`, both of which call the Rust
analysis engine directly. Deterministic; no model calls.

## Scope — read this first

| Question | Command | Skill |
| --- | --- | --- |
| Is **this change** safe to merge? | `altimate review` | `dbt-pr-review` |
| Is **this project** healthy? | `altimate review --all` | this one |

`altimate review` reviews a **diff** — it defaults to the merge-base with `origin/main`.
A model that has been wrong since the day it was written never shows up. In a mature
repo that is where most of the debt lives: a project can run `altimate review` in CI for
months and still be sitting on project-level findings, because none of them was ever in
a recent diff. `--all` is the mode that reads them.

## Preflight

```bash
command -v altimate >/dev/null || echo "altimate not on PATH — install: curl -fsSL https://www.altimate.sh/install | bash"
```

## Jinja is a silent false green — `dbt parse` is not enough here

The engine parses SQL, not Jinja. A dbt model beginning `{{ config(...) }}` fails to
parse at line 1, **every lint rule is skipped, and the report still shows zero
findings.** Verified: `altimate check` on a raw dbt model reports `0 errors, 0 warnings`
for exactly this reason.

In a diff review that hits one or two models. In a **project** review it can hit all of
them at once, and the result reads like a clean project. So compile, do not just parse:

```bash
cd <dbt project dir>
dbt deps
dbt compile --profiles-dir .    # writes target/manifest.json AND target/compiled/**
```

`dbt parse` writes the manifest but no compiled SQL. `dbt compile` needs credentials to
resolve `source()` metadata but runs no queries.

The report tells you whether this worked — `altimate review --all` prints a line like:

```
⚠️  207 of 214 models had no compiled SQL — the engine analysed their raw Jinja,
   which the SQL parser cannot read, so the AST lanes returned nothing for them.
```

If you see it, that number goes in your first paragraph. Do not report a 3%-coverage run
as a project review.

## 1. Project review

```bash
altimate review --all \
  --cwd <dbt project dir> \
  --manifest target/manifest.json \
  --severity warning \
  --no-ai \
  --json
```

- `--all` cannot be combined with `--base`/`--head`; it has no base ref.
- `--max-models N` caps the run (`0` = no cap, default 500). Truncation is announced on
  stderr — check for it.
- `--mode gate` exits non-zero on `REQUEST_CHANGES`, for a scheduled health check.
- `--severity suggestion` for the full list.

### Read `lanes` before `findings`

The JSON envelope carries a `lanes` object that diff mode does not:

```jsonc
"lanes": {
  "ran":     ["core_lint", "dbt_patterns", "lexical_scan", "dbt_config_lint",
              "grain_mismatch", "missing_grain_test", "sibling_filter_consistency",
              "pii_classify", "pii_detect"],
  "skipped": [{ "lane": "semantic_change", "reason": "proves base-vs-head row equivalence; …" }],
  "compiledModels": 7,
  "totalModels": 214
}
```

Every base-vs-head lane is listed in `skipped` with the reason it could not run:
equivalence, structural diff, column breakage, data-diff, dbt config diff, lineage
breakage, topology equivalence, schema.yml test removal, and the advisory LLM lane.
Report them as **not run**, never as "nothing found there", and point the user at
`dbt-pr-review` for those checks.

## 2. Performance pass

`--all` covers correctness, PII, contracts and grain. Cost and performance are a
separate deterministic command:

```bash
altimate dbt-perf --cwd <dbt project dir> --manifest target/manifest.json \
  --format json --severity warning
```

- It returns `skipped_rules` alongside `findings`, and a summary carrying
  `had_compiled_sql` / `had_sink_map`. **Surface the skipped rules.** A rule that could
  not run is not a clean result.
- Where a finding carries a `guardrail` of kind `MaterializationChange`, quote its
  `delete_scope` and `reader_requirements`. Those fields exist because a past
  performance fix switched a materialization without dropping the old relation and
  caused a data incident. A materialization recommendation without them is incomplete.
- `--fail-on warning|error` for CI.
- If it says it needs a newer `@altimateai/altimate-core`, report that and stop. Do not
  substitute your own performance opinion for the engine's.

## Reporting

Lead with scope and coverage, then findings:

1. Models analysed, how many had compiled SQL, which lanes ran and which did not.
2. Findings grouped by **category**, not by file, ordered by severity. In a project
   review the pattern is the finding: "31 models cross join without an `ON` clause" is
   the headline; the 31 paths are the evidence.
3. The three or four themes worth fixing first, each with a concrete first step.

Two rules:

- **Do not restate a finding you cannot see in the source.** Open the file and confirm
  the line before repeating what the engine said.
- **Never present a partial run as a complete one.** A missing compile, a model cap that
  bit, or a skipped lane belongs in the first paragraph, not a footnote.
