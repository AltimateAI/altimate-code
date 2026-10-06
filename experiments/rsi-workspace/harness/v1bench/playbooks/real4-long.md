---
name: team-playbook
description: "Conventions this team's CI and reviewers enforce, learned from past sessions. Apply them to related work."
applyPaths: ["dbt_project.yml"]
---
<!-- learned-playbook v1; managed by `altimate-code learn`. Edit via `learn`, not by hand. -->
- [L-2fe6] In staging models, integer columns ending in `_cents` must be converted using the `{{ cents_to_dollars(...) }}` macro and renamed without the `_cents` suffix; no `*_cents` columns should pass through to staging output. <!-- h:0 x:0 -->
- [L-8536] If a source table has a soft-delete flag (e.g. `_is_deleted`), filter it out with `where not _is_deleted` in the renamed CTE and exclude that column from the select list; staging models must not expose soft-delete flags as output columns. <!-- h:0 x:0 -->
- [L-8201] In staging models, every timestamp column must be wrapped with the `{{ to_utc('col') }}` macro and aliased with the `_at` suffix; bare timestamp aliases without the macro are not permitted. <!-- h:0 x:0 -->
- [L-8aba] When adding a new source to a staging layer, also register it in the corresponding sources YAML file and ensure the model YAML lists only the columns that appear in the final select, using the aliased output names. <!-- h:0 x:0 -->
