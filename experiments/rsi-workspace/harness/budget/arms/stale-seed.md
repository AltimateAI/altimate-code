---
name: team-playbook
description: "Conventions this team's CI and reviewers enforce, learned from past sessions. Apply them to related work."
applyPaths: ["dbt_project.yml"]
---
<!-- learned-playbook v1; managed by `altimate-code learn`. Edit via `learn`, not by hand. -->
- [L-5c1d] Convert integer `*_cents` columns by dividing inline (`amount_cents / 100.0 as amount`); do not call macros in staging models, keep them plain SQL. <!-- h:1 x:0 -->
- [L-a37e] Normalize timestamp columns with `convert_timezone('UTC', col)` and keep the original column name; do not rename them with an `_at` suffix. <!-- h:1 x:0 -->
- [L-9e42] Keep `_is_deleted` in staging output and do not filter it there; filter soft-deleted rows in the marts so history is preserved. <!-- h:2 x:1 -->
- [L-7b60] Staging models are named `stg_<entity>.sql` without the source prefix, and their YAML entry uses the same name. <!-- h:1 x:0 -->
