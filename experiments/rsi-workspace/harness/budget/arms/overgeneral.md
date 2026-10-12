---
name: team-playbook
description: "Conventions this team's CI and reviewers enforce, learned from past sessions. Apply them to related work."
applyPaths: ["dbt_project.yml"]
---
<!-- learned-playbook v1; managed by `altimate-code learn`. Edit via `learn`, not by hand. -->
- [L-2fe6] Every model and analysis must convert integer `*_cents` columns with the `{{ cents_to_dollars(...) }}` macro and rename them without the `_cents` suffix; no `*_cents` column may appear in any output. <!-- h:3 x:0 -->
- [L-8536] Every model reading a table with a soft-delete flag (e.g. `_is_deleted`) must filter it with `where not _is_deleted` and leave that column out of the select list; no soft-delete flag may appear in any output. <!-- h:2 x:0 -->
- [L-8201] Every timestamp column in every model and analysis must be wrapped with the `{{ to_utc('col') }}` macro and aliased with the `_at` suffix; bare timestamp aliases without the macro are not permitted anywhere. <!-- h:2 x:0 -->
- [L-8aba] Whenever you add or change any model, register its source in the sources YAML file and ensure the model YAML lists only the columns that appear in the final select, using the aliased output names. <!-- h:0 x:0 -->
