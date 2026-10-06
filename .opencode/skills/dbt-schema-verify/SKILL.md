---
name: dbt-schema-verify
applyPaths:
  - "dbt_project.yml"
  - "**/dbt_project.yml"
description: |
  Use after building or modifying a dbt model whose columns are declared in
  YAML (`schema.yml` / `_models.yml`). Run `altimate-dbt schema-verify --model
  <name>` to compare the built table with the declared columns, and treat a
  `mismatch` verdict (a non-empty `findings` list) as "not done" until you have
  decided whether the model or the YAML is wrong.

  YAML `columns:` is documentation plus the anchor for column tests. It is not
  an exhaustive list of what a model may produce, so columns the YAML does not
  mention are not an error unless a contract is enforced. What does count: an
  enforced contract the table does not match, and a declared column that has
  tests attached but is not produced.
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
| `match` | nothing dbt treats as an error was found (`notes` may still hold true observations) | proceed |
| `mismatch` | `findings` is non-empty: an enforced contract the table does not match, or a declared column with tests attached that the table lacks | NOT DONE until you decide which side is wrong |
| `no-spec` | the model has no columns declared in YAML | nothing to compare |

`spec` says which YAML file declares the columns, in which package, and
whether a contract is enforced. Each entry in `findings` carries the
evidence. `columns_extra` / `columns_missing` / `columns_reordered` /
`type_mismatches` are the raw diff against the YAML, not instructions:
`columns_extra` only means "not listed in the YAML".

## How to act on a finding

A finding says two things disagree. It does not say which one is wrong.

- **Contract enforced.** dbt will refuse to build a model whose columns differ
  from its contract. Either the model should produce exactly the contract's
  columns, or the contract is out of date. Decide from the task.
- **Declared column with tests, not produced.** The tests read a column that
  is not there and will fail or error. Either the model should produce the
  column, or the YAML entry (and its tests) is stale. Decide from the task.
- **Never** delete or invent a column just because the YAML does or does not
  list it. Undocumented columns are normal, and a declared column with no
  tests and no contract (a `note`) may simply be stale. If the task states
  which columns the output must have, follow the task.

Then run `altimate-dbt build --model <name>` again and re-run
`altimate-dbt schema-verify --model <name>`.

## Iron Rules

1. **The verdict is the source of truth, not your inspection.** Reading the
   columns yourself and concluding "looks right to me" does not count.
   Run the command and read its output.
2. **A `mismatch` is "not done", even if the build is green.** dbt build
   does not check declared columns unless a contract is enforced.
3. **Do not change the model to satisfy YAML that only documents some
   columns.** The YAML is evidence about intent, not the spec of the whole
   table. The task and the existing consumers of the model decide which
   columns are wanted.
4. **Run schema-verify on every model touched, not just the last one.**
5. **`no-spec` and `match` with notes need no action.** Read the notes; act
   on them only if they match what the task asked for.

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

Compare the two lists and apply the same rules: only an enforced
contract, or a declared column with tests that the table lacks, is a
problem. Columns the YAML does not list are not.

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
