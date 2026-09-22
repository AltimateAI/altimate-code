---
name: dbt-pr-review
description: >
  Review dbt/SQL changes in a branch or PR and produce a verdict backed by
  deterministic engine calls — column-lineage blast radius, query equivalence,
  dbt config lint, PII, and an A-F grade. Use before merging a dbt PR. Reviews a
  DIFF; for the whole project use dbt-project-review instead.
allowed-tools: Bash, Read, Glob, Grep
---

# dbt PR review

Runs `altimate review`, the same command `altimate-ingestion` runs in CI
(`.github/workflows/dbt-pr-review.yml`).

## Scope — read this first

`altimate review` reviews **a diff**, not a project. It defaults to the merge-base with
`origin/main` for `--base` and the working tree for `--head`. A model that has been wrong
since the day it was written will not appear unless it is in the diff. If the question is
"is this project healthy?" rather than "is this change safe?", use `dbt-project-review`.

## Preflight

The engine needs a manifest. `dbt parse` produces one offline, with no warehouse
connection:

```bash
cd <dbt project dir> && dbt deps && dbt parse --profiles-dir .
```

Placeholder values for any `env_var()` the profile or sources need are fine — parse never
connects.

## Run

```bash
altimate review \
  --cwd <dbt project dir> \
  --manifest target/manifest.json \
  --mode comment \
  --severity suggestion \
  --json
```

- `--mode comment` never blocks; `--mode gate` exits non-zero on REQUEST_CHANGES.
- `--base <ref>` / `--head <ref>` to review a range other than the default.
- `--no-ai` for the deterministic lanes only (no model calls, no cost).
- `--post` posts to the GitHub PR; only use it when explicitly asked.

## Reporting

Lead with the verdict and the blocking findings. For each blocking finding give the rule,
the file and line, and the fix. Separate the deterministic engine findings from the
advisory LLM lane — they carry different weight, and only the first should ever block.

Do not re-report a finding without opening the file and confirming it.
