---
name: dbt-schema-verify
applyPaths:
  - "dbt_project.yml"
  - "**/dbt_project.yml"
description: |
  REQUIRED after building or modifying ANY dbt model that has columns declared
  in `schema.yml` / `_models.yml`. Run `altimate-dbt schema-verify --model
  <name>` to diff actual columns against the spec, and treat any `mismatch`
  verdict as "not done."

  The most common reason "the build is green but the tests still fail" is
  that the model produces the right *data values* in the wrong *column
  shape* — extra columns, missing columns, wrong order, wrong types. Many
  dbt equality tests grade the column tuple `(name, type, position)`
  exactly, and the agent's prior bias is to add "helpful" extras
  (`p1`/`p2`/`p3` rank breakdowns, name-resolved variants, lineage
  metadata) or reorder columns "more logically." Both break the contract.

  This skill enforces the mechanical check that catches those bugs before
  declaring done. Use it before declaring any model task complete.
---

# dbt schema-verify

## When to invoke this skill — every time

Run `altimate-dbt schema-verify --model <name>` before declaring any of the
following tasks complete:

- Creating a new dbt model that has (or will have) a `schema.yml` entry
- Modifying an existing model whose `schema.yml` declares columns
- Refactoring a CTE into its own intermediate model
- Renaming columns or changing their order
- Changing materialization config in a way that re-creates the table
- Any task that says "match the schema", "produce these columns", "the
  output should have columns X, Y, Z", or references a `_models.yml`
- Any task with `AUTO_*_equality` or `AUTO_*_existence` tests on a model

If the task touched N models, run schema-verify on **all N of them**, not
just the last one. A `build` is not a verify.

## How to run it

```bash
altimate-dbt schema-verify --model <name>
```

**Note**: `altimate-dbt build --model <name>` already runs schema-verify
automatically after a successful build and includes the verdict in its
response under a `schema_verify` field. You will see the diff in the same
result that reported the build outcome — read it there before deciding
the task is done. If you need to re-check after editing, call
`schema-verify` directly.

Returns a structured JSON result:

```json
{
  "model": "int_asana__project_user_agg",
  "verdict": "mismatch",
  "expected_columns": ["project_id", "users", "number_of_users_involved"],
  "actual_columns": ["project_id", "users"],
  "columns_extra": [],
  "columns_missing": ["number_of_users_involved"],
  "columns_reordered": [],
  "type_mismatches": []
}
```

## How to read the verdict

| verdict | meaning | what to do |
|---|---|---|
| `match` | actual columns match the spec exactly (case-insensitive on names) | DONE — proceed |
| `mismatch` | one or more of `columns_extra`, `columns_missing`, `columns_reordered`, `type_mismatches` is non-empty | NOT DONE — read the diff, fix the model SQL, rebuild, re-run schema-verify |
| `no-spec` | the model has no columns declared in `schema.yml` | DONE for shape-fidelity purposes — no contract to verify against |

## How to act on a `mismatch`

For each non-empty list, the fix is mechanical:

| Field | What it means | What to change in the model SQL |
|---|---|---|
| `columns_extra` | columns in your model NOT in the spec | REMOVE them from the `SELECT` |
| `columns_missing` | columns in the spec NOT in your model | ADD them to the `SELECT` (compute them, or rename an existing column if you used a synonym) |
| `columns_reordered` | columns present in both but at different positions | REORDER the columns in your `SELECT` to match the spec's order |
| `type_mismatches` | declared `data_type` in spec disagrees with the warehouse's reported type | CAST in the `SELECT` or change the upstream source |

Then run `altimate-dbt build --model <name>` again, then re-run
`altimate-dbt schema-verify --model <name>` until verdict is `match`.

## Iron Rules

1. **The verdict is the source of truth, not your inspection.** Reading the
   columns yourself and concluding "looks right to me" does not count.
   Run the command and read its output.
2. **A `mismatch` is "not done", even if the build is green.** dbt build
   only proves the SQL compiled and ran without errors. It does not prove
   the column shape is correct. Equality tests grade shape AND values.
3. **Do not reinterpret the spec to make the model right.** The spec is
   the contract. If the spec lists `supplier_company` and your model has
   `supplier_id`, the answer is to fix your model, not to argue that
   `supplier_id` is more useful.
4. **Run schema-verify on every model touched, not just the last one.**
   The most common "almost-pass" is N-1 models passing and the Nth one
   silently failing on column shape. Walk the list.
5. **Skip only on `no-spec`.** Do not skip on the grounds that the model
   is small, or trivial, or "obvious." The spec is small only because
   the dbt project author already curated it.

## Fallback when altimate-dbt is unavailable

If `which altimate-dbt` returns nothing, do the same diff by hand:

```bash
# 1. Read expected columns from any YAML spec under models/
#    dbt allows any .yml filename; common patterns include schema.yml,
#    _models.yml, models.yml, sources.yml, etc.
cat models/**/*.yml | grep -A 50 "name: <name>"   # or: yq eval '...' models/**/*.yml

# 2. Read actual columns from the materialized table
dbt show --select <name> --limit 0
```

Compare the two ordered lists. Produce the same four-bucket diff
(`columns_extra`, `columns_missing`, `columns_reordered`,
`type_mismatches`) in your head, and apply the same fix logic. The
mechanics don't change; only the tool name does.

## What this skill does NOT cover

- **Value-level correctness** — passing schema-verify only proves shape;
  whether the *values* in each column are right is a separate check
  (`altimate-dbt test` + dbt unit tests). Generate unit tests with the
  `dbt-unit-tests` skill when the model has non-trivial transformation
  logic.
- **Row count** — schema-verify compares columns, not rows. If a refactor
  drops rows that should be preserved (common when extracting a CTE into
  its own model — see `dbt-develop`'s "Refactoring a CTE into its own
  model" section), schema-verify will pass while equality tests fail.
  Check row counts separately.
- **Custom tests** — `check_*` and other non-AUTO tests check
  task-specific business rules, not column shape. schema-verify can pass
  while a custom test fails. Read the custom test SQL to understand
  what's being asserted.
