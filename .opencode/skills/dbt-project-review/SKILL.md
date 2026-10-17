---
name: dbt-project-review
applyPaths:
  - "dbt_project.yml"
  - "**/dbt_project.yml"
description: Review an ENTIRE dbt project rather than a diff — every model in the manifest, plus a deterministic performance pass. Use when the question is "is this project healthy?", "what technical debt is in here?", "audit the whole warehouse", or when onboarding to an unfamiliar dbt repo. For "is this change safe?" use `dbt-pr-review` instead, which reviews a diff.
---

# dbt project review

## Requirements
**Agent:** `reviewer` (read-only) — also works from `analyst`.
**Tools used:** `bash` (`altimate review --all`, `altimate dbt-perf`), read-only `git`, `read`.

## Diff vs project — pick the right one

| Question | Command | Skill |
| --- | --- | --- |
| Is **this change** safe to merge? | `altimate review` | `dbt-pr-review` |
| Is **this project** healthy? | `altimate review --all` | this one |

They are not interchangeable. `altimate review` defaults to the merge-base with
`origin/main`; a model that has been wrong since the day it was written never appears in
its output. In a mature repo that is most of the findings — a project running
`altimate review` in CI for months can still be sitting on dozens of untouched
project-level issues, because none of them was ever in a recent diff.

## Preflight — compile, do not just parse

The engine analyses SQL, not Jinja. **`dbt parse` is not enough for a project review.**
It writes a manifest (so the DAG, contracts and tests resolve) but no compiled SQL, and
every model that falls back to raw Jinja fails to parse at `{{ config(...) }}` on line 1
— the AST lanes then return **zero findings for that model**, which is indistinguishable
from a clean one.

```bash
cd <dbt project dir>
dbt deps
dbt compile --profiles-dir .     # writes target/manifest.json AND target/compiled/**
```

`dbt compile` needs credentials to resolve `source()` metadata but does not run queries.
If compile is impossible, run anyway — but read the compiled-coverage line in the report
(below) and say plainly how much of the project was actually analysed.

## 1. Project review

```bash
altimate review --all \
  --cwd <dbt project dir> \
  --manifest target/manifest.json \
  --severity warning \
  --no-ai \
  --json
```

- `--all` is mutually exclusive with `--base`/`--head` — it has no base ref.
- `--severity suggestion` for everything; `warning` is the useful default on a first pass.
- `--max-models N` caps the run (`0` lifts the cap; the default is 500). Any truncation
  is announced on stderr — never assume it didn't happen.
- `--mode gate` exits non-zero on `REQUEST_CHANGES`, for a scheduled CI health check.
- `--no-ai` keeps it deterministic and free.

### Read `lanes` before you read `findings`

The envelope carries a `lanes` object that the diff mode does not have:

```jsonc
"lanes": {
  "ran": ["core_lint", "dbt_patterns", "lexical_scan", "dbt_config_lint",
          "grain_mismatch", "missing_grain_test", "sibling_filter_consistency",
          "pii_classify", "pii_detect"],
  "skipped": [{ "lane": "semantic_change", "reason": "proves base-vs-head row equivalence; …" }],
  "compiledModels": 7,
  "totalModels": 214
}
```

Two rules:

- **Every base-vs-head lane is skipped and says so.** Equivalence, structural diff,
  column breakage, data-diff, config diff, lineage breakage, topology equivalence and
  the schema.yml test-removal detector all compare two versions of a model; project
  scope has one. Do not report their silence as "no issues found there" — report them
  as not run, and point the user at `dbt-pr-review` for those.
- **`compiledModels` < `totalModels` means the report is partial.** Say the number. A
  review where 207 of 214 models had no compiled SQL analysed 3% of the project with
  the AST lanes, and the honest headline is that, not the finding count.

## 2. Performance pass

`altimate review --all` covers correctness, PII, contracts and grain. It does not do
the cost/performance rule set — that is a separate deterministic command:

```bash
altimate dbt-perf --cwd <dbt project dir> --manifest target/manifest.json \
  --format json --severity warning
```

- It prints `skipped_rules` for every rule that could not run, and a summary line
  carrying `had_compiled_sql` / `had_sink_map` / `had_run_results` / `parse_failures`. Surface both: a rule that could not run
  is not a clean result.
- Where a finding carries a `guardrail` of kind `materialization_change`, report its
  `delete_scope` and `reader_requirements` verbatim. Those fields exist because a past
  performance fix switched a materialization without dropping the old relation and
  caused a data incident. A recommendation to change a materialization that omits them
  is not a complete recommendation.
- `--fail-on warning|error` for CI.
- `--run-results target/run_results.json --sort cost` ranks findings by measured runtime;
  `--sinks <map>` lets the column rules see loaders outside dbt.
- If it reports that it needs a newer `@altimateai/altimate-core`, say so and stop —
  do not substitute a hand-rolled performance opinion for the engine's.

## Acting on the findings

This skill reports. To fix what it finds, use these skills, which work on one model
or one change at a time:

- Performance or cost findings → `dbt-optimize` (`altimate dbt-optimize --model X`):
  rewrites with an equivalence proof, applied safely.
- Logic repeated across models (P104 and similar) → `dbt-factor`
  (`altimate dbt-factor --project`).
- Before you drop, rename or retype a column, or change a materialization →
  `dbt-impact` (`altimate dbt-impact --model X --column c`). It includes loaders and
  served tables when you pass `--sinks`.
- After any rewrite → `dbt-parity` to prove the rows are unchanged.

## 3. Reporting

Lead with **scope and coverage**, then findings:

1. How many models were analysed, how many had compiled SQL, which lanes ran and which
   did not.
2. Findings grouped by category (not by file) and ordered by severity — in a project
   review the pattern matters more than the instance. "31 models cross join without an
   `ON` clause" is the finding; the 31 paths are the evidence.
3. The three or four themes worth fixing first, with the concrete first step.

Two rules carried over from `dbt-pr-review`:

- **Do not restate a finding you cannot see in the source.** Open the file and confirm
  the line before repeating what the engine said.
- **Never present a partial run as a complete one.** If compile did not happen, or the
  model cap bit, or a lane was skipped, that belongs in the first paragraph.
