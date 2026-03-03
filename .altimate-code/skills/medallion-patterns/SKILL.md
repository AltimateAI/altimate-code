---
name: medallion-patterns
description: >
  Apply medallion architecture (bronze/silver/gold) patterns to organize dbt models into clean data layers.
  Use when the user asks about layered data architecture, bronze/silver/gold organization, staging vs marts structure,
  data mesh patterns, or wants to reorganize their dbt project into proper transformation layers.
domain: dbt
tools:
  - glob
  - read
  - dbt_run
  - write
  - edit
docs:
  - title: "dbt Best Practices: How we structure our dbt projects"
    url: "https://docs.getdbt.com/best-practices/how-we-structure/1-guide-overview"
    context: "Staging/intermediate/mart layer definitions and conventions"
  - title: "Medallion Architecture (Databricks)"
    url: "https://www.databricks.com/glossary/medallion-architecture"
    context: "Bronze/silver/gold pattern origin, layer responsibilities, Delta Lake context"
---

# Medallion Architecture Patterns

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** glob, read, dbt_run, write, edit

Guide and scaffold dbt projects following layered architecture patterns. Adapts to the project's existing conventions rather than imposing a single naming scheme.

## Workflow
1. **Detect existing conventions** -- This step is critical. Never impose a naming scheme without checking first.
   - Use `glob` to scan `models/` directory structure for folder patterns and model file names
   - Use `read` to check `dbt_project.yml` for configured model paths and materializations
   - Classify the project's current convention from directory names and file prefixes:

   | Signal | Convention | Layer Mapping |
   |--------|-----------|---------------|
   | `stg_`, `int_`, `fct_`, `dim_` prefixes | **dbt canonical** | staging / intermediate / marts |
   | `brz_`, `slv_`, `gld_` prefixes | **medallion prefix** | bronze / silver / gold |
   | `bronze/`, `silver/`, `gold/` dirs | **medallion directory** | bronze / silver / gold |
   | `staging/`, `intermediate/`, `marts/` dirs | **dbt directory** | staging / intermediate / marts |
   | `raw_`, `clean_`, `mart_` prefixes | **custom** | detect and follow |
   | No clear pattern | **greenfield** | recommend dbt canonical (most widely adopted) |
3. **Follow the detected convention** -- Match whatever the project already uses. If the project uses `stg_/int_/fct_/dim_`, use that. If it uses `brz_/slv_/gld_`, use that. Consistency with the existing project matters more than any theoretical ideal.
4. **Audit and recommend** -- Identify models that don't fit their layer's responsibilities (e.g., a staging model with joins, or a mart model referencing sources directly)
5. **Scaffold or reorganize** -- Create directory structure and template models, using the detected convention

## Layer Definitions

The medallion architecture has three layers. The terminology varies but the responsibilities are universal:

### Layer 1: Source-Conformed (Bronze / Staging)
**Purpose**: Ingest raw data with minimal transformation. Preserve source fidelity.

**Responsibilities**:
- 1:1 mapping with source tables
- Type casting, column renaming, deduplication only
- No joins, no business logic
- Materialized as `view` or `ephemeral`

**Pattern**:
```sql
{{ config(materialized='view') }}

with source as (
    select * from {{ source('stripe', 'payments') }}
),

renamed as (
    select
        cast(id as varchar) as payment_id,
        cast(amount as integer) as amount_cents,
        cast(created as timestamp) as created_at,
        _loaded_at
    from source
)

select * from renamed
```

### Layer 2: Business-Conformed (Silver / Intermediate)
**Purpose**: Cross-source joins, business logic, data quality transformations.

**Responsibilities**:
- Cross-source joins allowed
- Business logic transformations (currency conversion, status mapping)
- Data quality filters (remove nulls, deduplicate)
- Standardized naming conventions
- Materialized as `ephemeral`, `view`, or `table`

**Pattern**:
```sql
{{ config(materialized='ephemeral') }}

with orders as (
    select * from {{ ref('stg_stripe__payments') }}
),

customers as (
    select * from {{ ref('stg_crm__customers') }}
),

enriched as (
    select
        o.payment_id,
        o.amount_cents / 100.0 as amount_dollars,
        c.customer_name,
        c.segment,
        o.created_at
    from orders o
    left join customers c on o.customer_id = c.customer_id
    where o.created_at is not null
)

select * from enriched
```

### Layer 3: Consumption-Ready (Gold / Marts)
**Purpose**: Business-ready aggregations, metrics, and dimensional models for BI.

**Responsibilities**:
- Aggregations, metrics, KPIs
- Wide denormalized tables for BI tools
- Fact tables and dimension tables (Kimball style)
- Materialized as `table` or `incremental`

**Pattern**:
```sql
{{ config(
    materialized='incremental',
    unique_key='revenue_date'
) }}

with orders as (
    select * from {{ ref('int_orders__enriched') }}
    {% if is_incremental() %}
    where created_at > (select max(revenue_date) from {{ this }})
    {% endif %}
),

daily as (
    select
        date_trunc('day', created_at) as revenue_date,
        segment,
        count(*) as order_count,
        sum(amount_dollars) as gross_revenue
    from orders
    group by 1, 2
)

select * from daily
```

## Convention Mapping Reference

When the project uses one convention but the user asks about another, use this mapping:

| Medallion | dbt Canonical | Typical Prefix | Directory |
|-----------|--------------|----------------|-----------|
| Bronze | Staging | `stg_` or `brz_` | `staging/` or `bronze/` |
| Silver | Intermediate | `int_` or `slv_` | `intermediate/` or `silver/` |
| Gold (facts) | Marts (facts) | `fct_` | `marts/` or `gold/` |
| Gold (dimensions) | Marts (dimensions) | `dim_` | `marts/` or `gold/` |
| Gold (metrics) | Marts (metrics) | `mrt_` or `met_` | `marts/` or `gold/` |

## Materialization Defaults by Layer

Configure in `dbt_project.yml`:
```yaml
models:
  my_project:
    staging:         # or bronze
      +materialized: view
    intermediate:    # or silver
      +materialized: ephemeral
    marts:           # or gold
      +materialized: table
```

## Migration Checklist

When reorganizing an existing project:

1. **Inventory** -- Use `glob` on `models/` to catalog all model files and `read` `dbt_project.yml` for materializations
2. **Map layers** -- Classify each model into its target layer based on content (not just name)
3. **Create directories** -- Set up the target directory structure
4. **Move and rename** -- Relocate models, updating names to match the convention
5. **Update refs** -- Update all `ref()` calls to match new model names
6. **Update dbt_project.yml** -- Add layer-specific materialization configs
7. **Verify** -- Run `dbt build` to confirm no breakages

## Usage

- `/medallion-patterns audit` -- Analyze current project structure and conventions
- `/medallion-patterns scaffold stripe` -- Create layered models for a new source
- `/medallion-patterns migrate` -- Plan migration of existing models to layered architecture

Use the tools: `glob`, `read`, `dbt_run`, `write`, `edit`.
