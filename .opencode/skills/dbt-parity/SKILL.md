---
name: dbt-parity
description: Use to verify that a changed or rewritten dbt model returns exactly the same rows as before. It proves the data is unchanged: row counts, duplicate grain keys, EXCEPT both ways, and per-column match rates, run over a warehouse connection.
---

# Prove a dbt model change kept the same data

## Requirements
**Agent:** any (read-only analysis)
**Tools used:** `bash` (`altimate dbt-parity`), `read`

```bash
altimate dbt-parity --model <model> --before <relation before> --after <relation after> \
  [--connection <name>] [--columns a,b,c] [--sample-rows N] [--json]
```

- `--before`: the relation built from the old SQL (usually prod). `--after`: the same
  model built from the new SQL into another schema or target.
- The grain comes from the model's uniqueness test, its contract primary key, or its
  `unique_key`. The output says which one it used.
- `--columns` turns on per-column match rates, which name the column that differs.
- Exit 0 and `PARITY: MATCH` mean the rows are the same. `MISMATCH` and `INCONCLUSIVE`
  exit 1. `INCONCLUSIVE` means a check errored. It is never a pass.
- `--connection`: a configured warehouse connection. Without one, the first configured
  connection is used. A connection can also come from an environment variable:
  `ALTIMATE_CODE_CONN_<NAME>='{"type":"trino","host":…,"port":…,"user":…,"catalog":…}'`.

## PII: samples are opt-in
Without `--sample-rows`, only counts leave the warehouse. With `--sample-rows N`,
up to N differing rows are printed each way, and they end up in this conversation.
Ask the user before you use it on tables that may hold personal or regulated data.

## Reading a mismatch
- Row delta with EXCEPT = 0: rows were duplicated or dropped. Check
  `Duplicated grain keys`.
- EXCEPT > 0 both ways with equal counts: values changed. The column match rates name
  the columns.
