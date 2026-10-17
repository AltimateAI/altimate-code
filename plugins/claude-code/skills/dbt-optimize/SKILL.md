---
name: dbt-optimize
description: >
  Use when asked to optimise, speed up, or cut the cost / memory / bytes scanned of a
  dbt model, or to find and fix its performance or cost problem — especially when the
  output rows must stay exactly the same. Finds the cost problem, proposes rewrites
  with an equivalence proof, applies one safely, and hands off to a data parity check.
allowed-tools: Bash, Read, Edit, Glob, Grep
---

# Optimise a dbt model without changing its rows

Run from the dbt project directory. All steps are deterministic engine calls.

## 0. Compile first
`altimate` reads `target/manifest.json` and needs the COMPILED SQL in it:
`dbt compile` (not `dbt parse`). Check `had_compiled_sql: true` in step 1's summary.

## 1. Find the cost problem
```bash
altimate dbt-perf --format json [--run-results target/run_results.json --sort cost]
```
Keep the findings whose `model` is the target. `--run-results` adds measured runtime
and ranks by it. A finding's `guardrail` of kind `materialization_change` comes with
`delete_scope` and `reader_requirements` — quote both if you act on it.

## 2. Get proven rewrites
```bash
altimate dbt-optimize --model <model> [--json]
```
Each proposal has a proof:
- **PROVEN** — the engine showed both versions return the same rows. Apply it.
- **REFUTED** — it changes the rows; the differences are listed. Never apply it.
- **UNDECIDABLE** — unknown; apply only if step 4 then passes.

## 3. Apply
```bash
altimate dbt-optimize --model <model> --apply [--proposal N] [--allow-unproven]
```
It keeps the `{{ config() }}` block and turns relations back into `ref()`s. When it
prints `NOT APPLIED` (Jinja such as `{% if %}`, macros or `var()`), it prints the
compiled-SQL patch: port that change into the model by hand, keeping the Jinja.
If no proposal fits the finding, write the fix yourself. The step 4 bar still applies.

## 4. Prove the rows did not change
Build the edited model into a separate relation (e.g. a dev target), then run the
command step 3 printed:
```bash
altimate dbt-parity --model <model> --before <current relation> --after <new relation> [--columns a,b,c]
```
`PARITY: MATCH` (exit 0) is the bar. Details are in the `dbt-parity` skill.
Without a warehouse connection, say so and report the proof from step 2 as the only
evidence.

## Report
State the finding (with cost, if measured), the change, its proof status, and the
parity result. Before you change a column or the materialization, run
`altimate dbt-impact` (skill `dbt-impact`).
