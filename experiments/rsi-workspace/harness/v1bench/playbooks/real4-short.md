---
name: team-playbook
description: "Conventions this team's CI and reviewers enforce, learned from past sessions. Apply them to related work."
applyPaths: ["dbt_project.yml"]
---
<!-- learned-playbook v1; managed by `altimate-code learn`. Edit via `learn`, not by hand. -->
- [L-2fe6] In staging, convert `*_cents` with `{{ cents_to_dollars('x_cents') }}` and drop `_cents` from output names (`amount`). <!-- h:0 x:0 -->
- [L-8536] If the source has `_is_deleted`, add `where not _is_deleted` in the renamed CTE and do not select the column. <!-- h:0 x:0 -->
- [L-8201] In staging models, wrap timestamps in `{{ to_utc('col') }}` and alias with `_at`; leave plain `date` columns alone. <!-- h:0 x:0 -->
- [L-8aba] A new staging source must be in the sources yml; the model yml lists only final-select columns, by aliased name. <!-- h:0 x:0 -->
