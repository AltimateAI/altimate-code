---
name: dbt-factor
description: >
  Use when the same or near-duplicate SQL (CTEs, filters, aggregations) is repeated
  across several dbt models, or when asked to compute it once and reuse it, to
  deduplicate model logic, or to cut repeated scans. Proposes a shared intermediate
  model, with an equivalence proof for each consumer.
allowed-tools: Bash, Read, Edit, Glob
---

# Compute repeated logic once

```bash
altimate dbt-factor --project [--min-occurrences 2] [--json]
altimate dbt-factor --model <model>          # only proposals that touch this model
altimate dbt-factor --apply [--proposal N]   # write the patch
```

Each proposal is a multi-file patch:
- a new `models/intermediate/int_<name>.sql` with a yml stub;
- an edit to each consumer so it reads the new model;
- a proof for each consumer, plus the savings estimate and the storage trade-off (the
  new model is materialised).

`--apply` writes the files only when no consumer proof is REFUTED and every consumer's
Jinja maps back safely. It then runs `dbt-impact` on each consumer it touched and
prints a `dbt-parity` command for each one. Run those commands after building
(skill `dbt-parity`). Set a `{{ config() }}` on the new model before you build it.
