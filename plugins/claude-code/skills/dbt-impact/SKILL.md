---
name: dbt-impact
description: >
  Use before changing, dropping, renaming or retyping a dbt model or column, adding a
  column that another job or model reads, changing its grain or materialization, or
  when asked "what depends on this?" or "what breaks downstream?". Lists every dbt
  model, loader and served table hop by hop, with a BREAKING / RISKY / SAFE verdict
  for each.
allowed-tools: Bash, Read
---

# What breaks downstream

```bash
altimate dbt-impact --model <model> [--column <col>] \
  --kind drop|rename|retype|grain|materialization|add \
  [--new-name x | --to-type t | --to incremental [--strategy delete+insert] [--unique-key k]] \
  [--sinks sink_map.json | --no-exposure-sinks] [--json]
# a branch's changes: both sides compiled with dbt, compiled SQL compared
altimate dbt-impact --base origin/main [--head HEAD] [--sinks sink_map.json] \
  [--jobs jobs.json | --jobs-from selectors] [--live] [--profiles-dir d] [--dbt-bin path]
# or from two already compiled manifests
altimate dbt-impact --base-manifest base/manifest.json --head-manifest head/manifest.json [--jobs ...]
```

- Each hop is a dbt child, a dbt descendant, a loader, or a served table, with a
  verdict and its evidence. `Overall` is the worst verdict, followed by its reasons.
- Without `--sinks`, the sink map comes from exposures whose `meta.sink` declares
  `{loader, target, columns, read_mode}`. That map is partial: a mart with no exposure has
  UNKNOWN loaders, not none, unless the dbt var `sink_map_complete: true` is set. An
  explicit `--sinks` map is complete. With no map at all the verdict is UNKNOWN
  (`sinks_unknown`), never SAFE. A clean dbt graph alone does not show that a mart column
  is unused. A loader that reads a column tolerantly (fills NULL) stays BREAKING.
- `--kind materialization` defaults to the `append` strategy. Pass `--strategy` (and
  `--unique-key` when the new config sets one); the report then carries `delete_scope`
  and the `reader_requirements` every reader must meet.
- Diff mode compiles base and head (`dbt compile`, offline first: no warehouse needed
  unless a model introspects) and compares `compiled_code`, so `{% set %}`, vars and
  macros classify. It detects added, renamed and retyped columns (`resolved_kind`).
  `--no-compile` falls back to a naive render; models it cannot render are
  `UNCLASSIFIED`. Run those again with `--model`.
- **Schema lag** (`schema_lag`): CI builds everything at once, production does not.
  For every column a change adds, renames or retypes, readers are checked for:
  - `schema_lag:cross_job` (BREAKING): the reader's job does not build the producer.
    Needs a job map: `--jobs jobs.json` (`{"jobs": {name: {"select", "exclude",
    "schedule"}}}`, dbt selection syntax, resolved with `dbt ls`) or
    `--jobs-from selectors` (one job per `selectors.yml` selector; cron from a
    `schedules.json` next to it). Without one, cross-job is skipped and the report says so.
  - `schema_lag:incremental_needs_full_refresh` (BREAKING): the producer is incremental
    with `on_schema_change` ignore (the default) or fail.
  - `schema_lag:source_not_landed`: the reader uses a source column newly declared in
    YAML. RISKY without a live catalog; `--live` reads the deployed columns over the
    configured connection and makes it BREAKING when the column is missing.
  - Ephemeral producers are inlined and never lag.
  Each finding names the consumer, column, producer, jobs (with cron and worst-case
  window) and one fix (e.g. `+` parent selection, `on_schema_change:
  append_new_columns`, a two-phase release).
- Use `--fail-on breaking|risky` to gate CI.

Report BREAKING hops and schema-lag findings first and name the consumers, jobs and the
suggested fix. Do not call a change safe when the sink map was missing or when cross-job
was skipped for lack of a job map on a project that runs several jobs.
