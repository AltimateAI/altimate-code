---
name: model-scaffold
description: Scaffold new dbt model files (staging, intermediate, mart) from a spec or description. Creates the SQL file, schema.yml entry, and source refs. Use when starting a new model from scratch.
---

# Model Scaffold

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** bash (runs `altimate-dbt` commands), read, write, glob, schema_search, dbt_profiles, altimate_core_validate

## When to Use This Skill

**Use when the user wants to:**
- Create a new dbt model from scratch given a description or spec
- Scaffold a staging model from a source table
- Create an intermediate or mart model shell with proper structure
- Set up the full file triad: SQL + schema.yml entry + source reference

**Do NOT use for:**
- Writing complex SQL logic — this skill creates the scaffold, not the full implementation
- Adding tests to an existing model → use `generate-tests`
- Converting a model to incremental → use `incremental-logic`

## Core Workflow

### 1. Determine the Layer and Location

```
staging/       → stg_<source>__<entity>.sql         e.g. stg_salesforce__accounts.sql
intermediate/  → int_<entity>_<verb>.sql             e.g. int_orders_joined.sql
marts/         → <entity>.sql or fct_<entity>.sql    e.g. fct_orders.sql, dim_customers.sql
```

Read existing models in the target directory to match naming conventions:
```bash
glob models/**/*.sql
```

### 2. Discover Available Sources

```bash
altimate-dbt info                                          # adapter and project info
schema_search(query: "<entity description>")               # find source tables
altimate-dbt columns-source --source <src> --table <tbl>  # inspect source columns
```

### 3. Create the SQL File

**Staging template:**
```sql
with source as (
    select * from {{ source('<source_name>', '<table_name>') }}
),

renamed as (
    select
        -- ids
        id as <entity>_id,

        -- dimensions
        name,
        status,

        -- timestamps
        created_at,
        updated_at

    from source
)

select * from renamed
```

**Intermediate template:**
```sql
with orders as (
    select * from {{ ref('stg_<source>__orders') }}
),

customers as (
    select * from {{ ref('stg_<source>__customers') }}
),

joined as (
    select
        orders.*,
        customers.customer_name

    from orders
    left join customers using (customer_id)
)

select * from joined
```

**Mart template:**
```sql
{{ config(materialized='table') }}

with <entity> as (
    select * from {{ ref('int_<entity>_joined') }}
)

select
    <entity>_id,
    -- dimensions
    -- measures

from <entity>
```

### 4. Create the schema.yml Entry

Add to the appropriate `schema.yml` (or create it):
```yaml
models:
  - name: <model_name>
    description: "<one line description>"
    columns:
      - name: <pk>
        description: "Primary key"
        tests:
          - not_null
          - unique
```

### 5. Validate

```bash
altimate-dbt compile --model <name>      # catch Jinja errors
altimate-dbt build --model <name>        # materialize and test
```

## Iron Rules

1. **Staging models are 1:1 with source tables.** No JOINs, no business logic.
2. **Always use `{{ ref() }}` and `{{ source() }}`** — never hardcode table names.
3. **Match the naming convention** of existing models in the same directory.
4. **Always validate with `altimate-dbt build`** before declaring done.
