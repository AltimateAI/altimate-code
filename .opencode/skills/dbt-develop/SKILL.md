---
name: dbt-develop
applyPaths:
  - "dbt_project.yml"
  - "**/dbt_project.yml"
description: |
  REQUIRED before writing or modifying ANY dbt model. Invoke this skill FIRST
  whenever a task says "create", "build", "add", "modify", "update", "fix", or
  "refactor" a dbt model, staging file, mart, incremental, or snapshot.

  Skipping this skill is the leading cause of silent-correctness bugs —
  models that compile and `dbt build` cleanly but produce wrong values. It
  contains the patterns that prevent the most common such bugs encountered
  in real dbt projects:

  • Incremental high-water marks (`>=` vs `>` ties → silent row dropout)
  • Snapshot strategy selection (timestamp vs check, `unique_key` choice)
  • `LEFT JOIN + COUNT(*)` phantom rows from unmatched parents
  • Type harmonization in `COALESCE` / `CASE` / `UNION` legs
  • Date-spine completeness (every period present, even empty ones)
  • Off-by-one window boundaries (`BETWEEN d - (N-1) AND d` for N-wide)
  • Uniqueness enforcement when schema implies a key
  • Window-function `LIMIT` with deterministic tiebreaker
  • Verifying transformation correctness with dbt unit tests, not just `dbt build`
  • Enumerating every requested deliverable and checking each exists on disk

  Do not start writing SQL until this skill is loaded. Powered by altimate-dbt.
---

# dbt Model Development

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** bash (runs `altimate-dbt` commands), read, glob, write, edit, schema_search, dbt_profiles, sql_analyze, altimate_core_validate, altimate_core_column_lineage

## When to Use This Skill

**Use when the user wants to:**
- Create a new dbt model (staging, intermediate, mart, OBT)
- Add or modify SQL logic in an existing model
- Generate sources.yml or schema.yml from warehouse metadata
- Reorganize models into layers (staging/intermediate/mart or bronze/silver/gold)
- Convert a model to incremental materialization
- Scaffold a new dbt project structure

**Do NOT use for:**
- Adding tests to models → use `dbt-test`
- Writing model/column descriptions → use `dbt-docs`
- Debugging build failures → use `dbt-troubleshoot`
- Analyzing change impact → use `dbt-analyze`

## Core Workflow: Plan → Discover → Write → Validate

### 1. Plan — Understand Before Writing

Before writing any SQL:
- Read the task requirements carefully
- **Enumerate every concrete deliverable the task asks for** — write down each
  model name, every column/test/config change mentioned, and any "create N
  models" count. This list becomes the checklist you verify against in
  step 4. A task asking for four models is not done if only three exist on
  disk. If the task references a `schema.yml`, `_models.yml`, or similar
  spec file, every entry there is a deliverable.
- Identify which layer this model belongs to (staging, intermediate, mart)
- Check existing models for naming conventions and patterns
- **Check dependencies:** If `packages.yml` exists, check for `dbt_packages/` or `package-lock.yml`. Only run `dbt deps` if packages are declared but not yet installed.

```bash
altimate-dbt info                           # project name, adapter type
altimate-dbt parents --model <upstream>     # understand what feeds this model
altimate-dbt children --model <downstream>  # understand what consumes it
```

**Check warehouse connection:** Run `dbt_profiles` to discover available profiles and map them to warehouse connections. This tells you which adapter (Snowflake, BigQuery, Postgres, etc.) and target the project uses — essential for dialect-aware SQL.


### 2. Discover — Understand the Data Before Writing

**Never write SQL without deeply understanding your data first.** The #1 cause of wrong results is writing SQL blind — assuming grain, relationships, column names, or values without checking.

**Step 2a: Search for relevant tables and columns**
- Use `schema_search` with natural-language queries to find tables/columns in large warehouses (e.g., `schema_search(query: "customer orders")` returns matching tables and columns from the indexed schema cache)
- Read `sources.yml`, `schema.yml`, and any YAML files that describe the source/parent models
- These contain column descriptions, data types, tests, and business context
- Pay special attention to: primary keys, unique constraints, relationships between tables, and what each column represents

**Step 2b: Understand the grain of each parent model/source**
- What does one row represent? (one customer? one event? one day per customer?)
- What are the primary/unique keys?
- This is critical for JOINs — joining on the wrong grain causes fan-out (too many rows) or missing rows

```bash
altimate-dbt columns --model <name>                         # existing model columns
altimate-dbt columns-source --source <src> --table <tbl>    # source table columns
altimate-dbt execute --query "SELECT count(*) FROM {{ ref('model') }}" --limit 1
altimate-dbt execute --query "SELECT * FROM {{ ref('model') }}" --limit 5
altimate-dbt column-values --model <name> --column <col>    # sample values for key columns
```

**Step 2c: Query the actual data to verify your understanding**
- Check row counts, NULLs, date ranges, cardinality of key columns
- Verify foreign key relationships actually hold (do all IDs in child exist in parent?)
- Check for duplicates in what you think are unique keys

**Step 2d: Read existing models that your new model will reference**
- Read the actual SQL of parent models — understand their logic, filters, and transformations
- Read 2-3 existing models in the same directory to match patterns and conventions

```bash
glob models/**/*.sql     # find all model files
read <model_file>        # understand existing patterns and logic
```

### 3. Write — Follow Layer Patterns

See [references/layer-patterns.md](references/layer-patterns.md) for staging/intermediate/mart templates.
See [references/medallion-architecture.md](references/medallion-architecture.md) for bronze/silver/gold patterns.
See [references/incremental-strategies.md](references/incremental-strategies.md) for incremental materialization.
See [references/yaml-generation.md](references/yaml-generation.md) for sources.yml and schema.yml.

### 4. Validate — Build, Verify, Check Impact

Never stop at writing the SQL. Always validate:

**Build it:**
```bash
altimate-dbt compile --model <name>                        # catch Jinja errors
altimate-dbt build --model <name>                          # materialize + run tests
```

**Verify transformation correctness with unit tests:**

For models with non-trivial transformation logic — aggregations, JOINs, CASE/WHEN,
window functions, ratio / rate / NPS calculations, COALESCE / NULL coalescing, date
spines, incremental merge keys — generate and run dbt unit tests before declaring
the model done. Schema checks ("table exists with the right columns") only verify
mechanics; value-level correctness needs unit tests.

Invoke the **dbt-unit-tests** skill, which will:
- Analyze your SQL for the constructs above
- Build typed mock input rows from the manifest
- Compute expected outputs by running the SQL against the mocks
- Write a `unit_tests:` block in the model's `_models.yml`

Then run them:
```bash
altimate-dbt test --model <name>     # runs unit tests + schema tests
```

If a unit test fails, the transformation logic is wrong — **fix the SQL, do not
weaken the test**. Skip unit tests only for genuinely trivial models: pure renames,
simple `SELECT *` passthrough, materialization / config-only changes, format-only
edits.

**Verify every requested deliverable exists:**

Walk the checklist you wrote in the Plan step. For each model the task asked
for, confirm: (1) the `.sql` file exists in the project, (2) it appears in
`altimate-dbt info` / the manifest, (3) `altimate-dbt columns --model <name>`
returns the expected columns, (4) the materialization config matches the
spec. A task that asked for N models is not complete with N-1 files on disk,
even if those N-1 build cleanly. Use:

```bash
ls models/                                                   # confirm every requested file exists
altimate-dbt info                                            # confirm every requested model is in the project
```

**Diff column shape against the spec — use the `dbt-schema-verify` skill.**
For each model the task touched, run `altimate-dbt schema-verify --model
<name>` and treat any `mismatch` verdict as "not done." Full procedure,
output interpretation, and fallback (when `altimate-dbt` is missing) live
in the dedicated **dbt-schema-verify** skill, which auto-loads alongside
this one.

**Verify the output:**
```bash
altimate-dbt columns --model <name>                        # confirm expected columns exist
altimate-dbt execute --query "SELECT count(*) FROM {{ ref('<name>') }}" --limit 1
altimate-dbt execute --query "SELECT * FROM {{ ref('<name>') }}" --limit 10  # spot-check values
```
- Do the columns match what schema.yml or the task expects?
- Does the row count make sense? (no fan-out from bad joins, no missing rows from wrong filters)
- Are values correct? (spot-check NULLs, aggregations, date ranges)

**Check SQL quality** (on the compiled SQL from `altimate-dbt compile`):
- `sql_analyze` — catches anti-patterns (SELECT *, cartesian products, missing filters)
- `altimate_core_validate` — validates syntax and schema references
- `altimate_core_column_lineage` — traces how source columns flow to output columns. Use this to verify your SELECT is pulling the right columns from the right sources, especially for complex JOINs or multi-CTE models.

**Check downstream impact** (when modifying an existing model):
```bash
altimate-dbt children --model <name>                       # who depends on this?
altimate-dbt build --model <name> --downstream             # rebuild downstream to catch breakage
```
Use `altimate-dbt children` and `altimate-dbt parents` to verify the DAG is intact when changes could affect downstream models.

## Iron Rules

1. **Never write SQL without reading the source columns first.** Use `altimate-dbt columns` or `altimate-dbt columns-source`.
2. **Never stop at compile.** Always `altimate-dbt build` to catch runtime errors.
3. **Match existing patterns.** Read 2-3 existing models in the same directory before writing.
4. **One model, one purpose.** A staging model should not contain business logic. An intermediate model should not be materialized as a table unless it has consumers.
5. **Fix ALL errors, not just yours.** After creating/modifying models, run a full `dbt build`. If ANY model fails — even pre-existing ones you didn't touch — fix them. Your job is to leave the project in a fully working state.
6. **Verify transformation correctness, not just mechanics.** For non-trivial models, generate and run dbt unit tests as part of the validate step (use the `dbt-unit-tests` skill). Passing `dbt build` only proves the SQL is syntactically valid — it doesn't prove the *values* are right.
7. **Enumerate deliverables, then check them off.** The task is not done until every model, column, test, and config change explicitly requested exists on disk and in the manifest. Re-read the prompt at the end and verify each requested item — don't trust your own intermediate "done" feeling.
8. **Match the column spec exactly — and verify it mechanically, not by inspection.** Use the dedicated **dbt-schema-verify** skill. Before declaring any model task done, run `altimate-dbt schema-verify --model <name>` and treat any `mismatch` verdict as "not done." Adding "helpful" extras (rank breakdowns, name-resolved fields, lineage metadata), reordering columns "more logically", or substituting synonyms (`supplier_id` for `supplier_company`, `transaction_type_name` for `transaction_type`) all break equality tests. The contract is what the spec says, not what you think would be useful.

## Common Pitfalls in Transformation Logic

When the model involves any of the following SQL constructs, watch for these
generic bugs that mostly compile cleanly but produce wrong values:

### Incremental models and snapshots

- **High-water mark boundary**: in the `{% if is_incremental() %}` filter, use
  `>=` (not `>`) when the upstream timestamp can repeat or land exactly on the
  prior max — a strict `>` silently drops every event that ties with the most
  recent prior load.
- **`unique_key` choice**: must be the *natural* unique key of the row. Picking
  a column that is not actually unique (e.g. a foreign-key like `customer_id`
  instead of `order_id`) causes silent merges and lost rows.
- **`on_schema_change`**: set `append_new_columns` (or `sync_all_columns` if
  upstream evolves) so a new source column doesn't NULL-out existing data.
- **Snapshots — strategy selection**: use `strategy='timestamp'` only when the
  source has a reliable `updated_at` that monotonically increases on every
  change. If `updated_at` can be NULL, be reset, or move backwards, switch to
  `strategy='check'` with an explicit `check_cols` list. Verify by querying
  the source for `MAX(updated_at)` and looking for repeats or NULLs.
- **Backfilling**: `--full-refresh` rebuilds incremental tables from scratch.
  Use it whenever you change the incremental SQL, the merge key, or
  `on_schema_change`.

### Date and time arithmetic

- **"current age", "days since", "elapsed", "tenure"** — if the column is not
  pre-computed in the source, compute it. For year-based age, account for
  month/day so the change happens on the birthday, not on Jan 1:
  ```sql
  date_part('year', age(birth_date))                              -- in postgres-family
  EXTRACT(YEAR FROM CURRENT_DATE) - EXTRACT(YEAR FROM birth_date)
    - CASE WHEN (EXTRACT(MONTH FROM CURRENT_DATE), EXTRACT(DAY FROM CURRENT_DATE))
              < (EXTRACT(MONTH FROM birth_date), EXTRACT(DAY FROM birth_date))
           THEN 1 ELSE 0 END                                       -- portable form
  ```
- **Date spines**: when a daily/weekly/monthly model must have a row for
  every period (even periods with zero events), build a spine first with
  `dbt_utils.date_spine` or a recursive CTE, then LEFT JOIN the events onto
  it. Never compute date series by `DISTINCT date_col FROM events` — that
  silently drops empty periods.
- **Date boundaries for windowed sums**: rolling-N-day windows expressed as
  `BETWEEN d - (N-1) AND d` (inclusive both ends) give a width of exactly N.
  `BETWEEN d - N AND d` gives N+1 — a classic off-by-one.

### Type harmonization in `COALESCE` / `CASE` / `UNION`

`COALESCE(timestamp_col, integer_col)` and `CASE WHEN ... THEN '0' ELSE 0 END`
fail at compile or coerce silently to whatever type the engine guesses.
Cast every branch / argument to the same explicit type:
```sql
COALESCE(CAST(timestamp_col AS TIMESTAMP), CAST(integer_col AS TIMESTAMP))
CASE WHEN cond THEN CAST('0' AS NUMERIC) ELSE CAST(0 AS NUMERIC) END
```
Same applies to `UNION` / `UNION ALL` — column types must match across legs.

### String concatenation with `NULL` operands

`||` and `CONCAT()` propagate `NULL` in most engines — a single `NULL` operand
makes the whole expression `NULL`. When the result feeds an equality join or
surrogate-key generation, that's an invisible row-dropper:
```sql
-- Wrong: NULL region OR NULL segment produces NULL geo_segment
region || '-' || segment AS geo_segment

-- Right: explicit placeholder
COALESCE(region, 'UNKNOWN') || '-' || COALESCE(segment, 'UNKNOWN') AS geo_segment
```
Use `CONCAT_WS()` if your dialect supports it (Snowflake, BigQuery) — it
skips `NULL` operands instead of propagating them, which is usually safer
than a static placeholder.

### dbt model versioning (dbt 1.8+)

When the task asks for a v2 of an existing model (and v1 must keep
working — common during a rolling schema change), use dbt's **versioned
models** feature, not a sibling `.sql` file with a `_v2` suffix:

1. Create the new SQL file (e.g. `dim_accounts_v2.sql`).
2. Add a `versions:` block to the model's entry in `_models.yml`:
   ```yaml
   models:
     - name: dim_accounts
       latest_version: 1
       versions:
         - v: 1
         - v: 2
           defined_in: dim_accounts_v2   # filename without .sql
   ```
3. Downstream callers reference the version with
   `{{ ref('dim_accounts', v=2) }}`. Without the `versions:` block, dbt
   treats `dim_accounts_v2` as an unrelated sibling model — versioning
   tests will fail and v1↔v2 lineage won't appear in the DAG.

### Refactoring a CTE into its own model — preserve row-count semantics

When a task asks to extract a CTE from a larger model into its own
intermediate model, the new model's row count must match what the CTE
produced inside the original. Common bug: the CTE was on the parent side of
a `LEFT JOIN` that preserved parent rows with no children; the agent's
extracted model starts `FROM child_table` and joins back to the parent,
silently dropping parents that have no children.

**Rule of thumb:** the extracted model should start `FROM` the same table
the CTE started from. Build the extracted model inside-out from the
parent's perspective, not the child's.

```sql
-- Original CTE (inside the larger model):
--   WITH agg_users AS (
--     SELECT p.project_id, listagg(u.user_id) AS users
--     FROM projects p
--     LEFT JOIN project_users u ON u.project_id = p.project_id
--     GROUP BY p.project_id
--   )
--
-- Right refactor — preserves projects with no users:
SELECT p.project_id, listagg(u.user_id) AS users
FROM {{ ref('projects') }} p
LEFT JOIN {{ ref('project_users') }} u ON u.project_id = p.project_id
GROUP BY p.project_id

-- Wrong refactor — drops projects with no users:
SELECT u.project_id, listagg(u.user_id) AS users
FROM {{ ref('project_users') }} u
GROUP BY u.project_id                            -- projects with zero users vanish
```

**Verification** (in order of preference):

```sql
-- If dbt_utils is installed, add to schema.yml on the extracted model:
tests:
  - dbt_utils.equal_rowcount:
      compare_model: ref('<parent_table>')

-- If dbt-audit-helper is installed:
{{ audit_helper.compare_relations(
    a_relation=ref('<original_or_parent>'),
    b_relation=ref('<extracted>'),
    primary_key='<key>'
) }}

-- Manual fallback — always available:
SELECT (SELECT COUNT(*) FROM {{ ref('<parent>') }})   AS parent_rows,
       (SELECT COUNT(*) FROM {{ ref('<extracted>') }}) AS extracted_rows
-- These must match if the original CTE was LEFT-joined to its parent.
```

If `extracted_rows < parent_rows`, the refactor is wrong — you've turned a
LEFT JOIN into an INNER JOIN somewhere. Same trap shows up when filtering a
right-side column in `WHERE` (silently converts the LEFT JOIN to an INNER
JOIN); move that filter into the `ON` clause.

### Uniqueness when the schema implies it

If the model is named `dim_*`, has a `unique` test in `schema.yml`, or the
task says "one row per X", the model must enforce that grain. Source data
often has duplicates. Use one of:
- `SELECT DISTINCT ...`
- `QUALIFY ROW_NUMBER() OVER (PARTITION BY <key> ORDER BY <tiebreaker>) = 1`
- `GROUP BY <key>` with explicit aggregation of all other columns

### Window functions / ranking with `LIMIT` and ties

`ORDER BY metric DESC LIMIT N` (and equivalently `ROW_NUMBER() / RANK() OVER
(PARTITION BY ... ORDER BY metric)` filtered to `<= N`) over a column with
ties returns a **non-deterministic** set — the engine can pick any N of the
tied rows, and the choice often differs across runs, engines, or warehouse
versions. The rest of the pipeline then sees row-count drift or different
keys appearing in downstream joins.

Always add a deterministic tiebreaker to the `ORDER BY` (a primary key, a
surrogate id, or any column guaranteed unique within the partition):
```sql
-- Wrong: ties produce different "top 20" every run
SELECT * FROM standings
ORDER BY points DESC
LIMIT 20

-- Right: tie on points falls back to driver_id
SELECT * FROM standings
ORDER BY points DESC, driver_id ASC
LIMIT 20

-- Same fix inside QUALIFY / window-row-number patterns:
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY season ORDER BY points DESC, driver_id ASC
) <= 20
```
If you can't think of a tiebreaker column, the model probably doesn't yet
have a unique key — fix that first.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Writing SQL without checking column names | Run `altimate-dbt columns` or `altimate-dbt columns-source` first |
| Stopping at `compile` — "it compiled, ship it" | Always `altimate-dbt build` to materialize and run tests |
| Hardcoding table references instead of `{{ ref() }}` | Always use `{{ ref('model') }}` or `{{ source('src', 'table') }}` |
| Creating a staging model with JOINs | Staging = 1:1 with source. JOINs belong in intermediate or mart |
| Not checking existing naming conventions | Read existing models in the same directory first |
| Using `SELECT *` in final models | Explicitly list columns for clarity and contract stability |
| `COUNT(*)` over a `LEFT JOIN` — counts unmatched parent rows as if they had one child (e.g. a `dim_parent LEFT JOIN fct_child` with no matching children still yields one row, so `COUNT(*) = 1` instead of `0`) | Use `COUNT(<child_key>)` or `COUNT(CASE WHEN <child_key> IS NOT NULL THEN 1 END)`. If you intended to exclude unmatched parents, switch to `INNER JOIN`. Same trap applies to `SUM`, `AVG`, etc. when the unmatched side contributes a "ghost" `NULL` row |

## Reference Guides

| Guide | Use When |
|-------|----------|
| [references/altimate-dbt-commands.md](references/altimate-dbt-commands.md) | Need the full CLI reference |
| [references/layer-patterns.md](references/layer-patterns.md) | Creating staging, intermediate, or mart models |
| [references/medallion-architecture.md](references/medallion-architecture.md) | Organizing into bronze/silver/gold layers |
| [references/incremental-strategies.md](references/incremental-strategies.md) | Converting to incremental materialization |
| [references/yaml-generation.md](references/yaml-generation.md) | Generating sources.yml or schema.yml |
| [references/common-mistakes.md](references/common-mistakes.md) | Extended anti-patterns catalog |
