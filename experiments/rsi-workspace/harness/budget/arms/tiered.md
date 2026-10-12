---
name: team-playbook
description: "Conventions this team's CI and reviewers enforce, learned from past sessions. Apply them to related work."
applyPaths: ["dbt_project.yml"]
---
<!-- learned-playbook v1; managed by `altimate-code learn`. Edit via `learn`, not by hand. -->
- [L-2fe6] In staging models, integer columns ending in `_cents` must be converted using the `{{ cents_to_dollars(...) }}` macro and renamed without the `_cents` suffix; no `*_cents` columns should pass through to staging output. <!-- h:3 x:0 -->
- [L-8536] If a source table has a soft-delete flag (e.g. `_is_deleted`), filter it out with `where not _is_deleted` in the renamed CTE and exclude that column from the select list; staging models must not expose soft-delete flags as output columns. <!-- h:2 x:0 -->
- [L-8201] In staging models, every timestamp column must be wrapped with the `{{ to_utc('col') }}` macro and aliased with the `_at` suffix; bare timestamp aliases without the macro are not permitted. <!-- h:2 x:0 -->
- [L-8aba] When adding a new source to a staging layer, also register it in the corresponding sources YAML file and ensure the model YAML lists only the columns that appear in the final select, using the aliased output names. <!-- h:0 x:0 -->
- [L-c420] Mart folders set `+materialized: table` once in `dbt_project.yml`, and mart models do not repeat it in their own config blocks, so project-level configuration changes are easy to find and review in isolation. <!-- h:0 x:0 -->
- [L-1f73] Dashboard exposures live in `models/marts/_exposures.yml`, each with an owner email and a `maturity` of high, medium or low, so the model layers stay predictable for every analyst who navigates the project. <!-- h:0 x:0 -->
- [L-30c0] Intermediate models are prefixed `int_`, live in `models/intermediate/`, and are never granted to BI roles, so the model layers stay predictable for every analyst who navigates the project. <!-- h:0 x:0 -->
- [L-235d] Joins in mart models are written with explicit `inner` or `left` types, with a comment whenever a fan-out is intended, so the model layers stay predictable for every analyst who navigates the project. <!-- h:0 x:0 -->
