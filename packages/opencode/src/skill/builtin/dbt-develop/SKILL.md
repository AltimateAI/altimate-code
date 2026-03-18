---
name: dbt-develop
description: Create and modify dbt models — staging, intermediate, marts, incremental, medallion architecture. Use when building new SQL models, extending existing ones, scaffolding YAML configs, or reorganizing project structure. Powered by altimate-dbt.
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

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Writing SQL without checking column names | Run `altimate-dbt columns` or `altimate-dbt columns-source` first |
| Stopping at `compile` — "it compiled, ship it" | Always `altimate-dbt build` to materialize and run tests |
| Hardcoding table references instead of `{{ ref() }}` | Always use `{{ ref('model') }}` or `{{ source('src', 'table') }}` |
| Creating a staging model with JOINs | Staging = 1:1 with source. JOINs belong in intermediate or mart |
| Not checking existing naming conventions | Read existing models in the same directory first |
| Using `SELECT *` in final models | Explicitly list columns for clarity and contract stability |

## Reference Guides

| Guide | Use When |
|-------|----------|
| [references/altimate-dbt-commands.md](references/altimate-dbt-commands.md) | Need the full CLI reference |
| [references/layer-patterns.md](references/layer-patterns.md) | Creating staging, intermediate, or mart models |
| [references/medallion-architecture.md](references/medallion-architecture.md) | Organizing into bronze/silver/gold layers |
| [references/incremental-strategies.md](references/incremental-strategies.md) | Converting to incremental materialization |
| [references/yaml-generation.md](references/yaml-generation.md) | Generating sources.yml or schema.yml |
| [references/common-mistakes.md](references/common-mistakes.md) | Extended anti-patterns catalog |
