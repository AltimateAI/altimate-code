---
name: model-scaffold
description: >
  Scaffold a new dbt model with SQL, YAML config, documentation, and tests. Covers staging/intermediate/mart
  patterns, sources.yml, schema.yml, column descriptions, and basic test definitions. Use when the user wants
  to create a new dbt model, generate sources.yml from a warehouse table, add model documentation, or set up
  YAML configuration for existing models.
---

# Scaffold dbt Model

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** glob, read, schema_inspect, schema_search, dbt_lineage, dbt_manifest, write, edit

Scaffold a complete dbt model: SQL file, YAML configuration, column descriptions, and basic tests. Also generates sources.yml from warehouse schemas and enriches existing YAML with documentation.

## Workflow
1. **Determine what to generate** -- Based on the user's request:
   - **New model**: scaffold SQL + companion YAML (steps 2-7)
   - **Sources YAML**: generate sources.yml from warehouse schema (step 8)
   - **Documentation**: add descriptions to existing YAML (step 9)
   - **Properties YAML**: generate model config with contracts (step 10)
2. **Determine layer** -- Ask or infer whether this is a staging, intermediate, or mart model based on the user's request.
3. **Read the dbt project** -- Use `glob` to find `dbt_project.yml` and scan the `models/` directory structure. Use `read` on `dbt_project.yml` to understand model paths, naming conventions, and materialization defaults.
4. **Inspect source schema** -- Use `schema_inspect` or `schema_search` to discover source table columns and types.
5. **Generate the model SQL** based on the layer pattern below.
6. **Generate companion YAML** -- Create a `_<directory>__models.yml` (one YAML file per directory) with column descriptions and basic tests. Follow the project's existing YAML organization pattern if one exists. Use `data_tests:` (preferred since dbt v1.8) unless the project already uses `tests:`.
7. **Write the files** -- Use `write` to create the SQL model and schema YAML in the correct directory.

## Layer Patterns

### Staging (`stg_`)

Staging models are the atomic building blocks of the project. Each staging model has a 1:1 relationship with a source table.

```sql
with source as (
    select * from {{ source('source_name', 'table_name') }}
),

renamed as (
    select
        -- Primary key
        column_id as table_id,

        -- Dimensions
        column_name,

        -- Timestamps
        created_at,
        updated_at

    from source
)

select * from renamed
```

| Attribute | Convention |
|-----------|-----------|
| Materialization | `view` (always fresh, lightweight) |
| Naming | `stg_<source>__<table>.sql` (double underscore) |
| Location | `models/staging/<source>/` |
| Purpose | Rename columns, cast types, basic cleaning. No joins, no aggregations. |

### Intermediate (`int_`)

Intermediate models break complex transformations into reusable, purpose-built steps between staging and marts.

```sql
with orders as (
    select * from {{ ref('stg_source__orders') }}
),

customers as (
    select * from {{ ref('stg_source__customers') }}
),

joined as (
    select
        orders.order_id,
        orders.customer_id,
        customers.customer_name,
        orders.order_date,
        orders.amount
    from orders
    left join customers
        on orders.customer_id = customers.customer_id
)

select * from joined
```

| Attribute | Convention |
|-----------|-----------|
| Materialization | `ephemeral` (default) or `view` (if queried directly for debugging) |
| Naming | `int_<entity>__<verb>.sql` (e.g., `int_orders__joined`, `int_payments__pivoted`) |
| Location | `models/intermediate/` or `models/intermediate/<domain>/` |
| Purpose | Joins, filters, pivots, business logic. Multiple inputs allowed, but should serve a single clear purpose. |

### Mart (`fct_` / `dim_`)

Marts are the final business-facing models, organized by domain (e.g., finance, marketing, product).

```sql
with final as (
    select
        order_id,
        customer_id,
        order_date,
        amount,
        -- Derived metrics
        sum(amount) over (partition by customer_id) as customer_lifetime_value
    from {{ ref('int_orders__joined') }}
)

select * from final
```

| Attribute | Convention |
|-----------|-----------|
| Materialization | See warehouse defaults below |
| Naming | `fct_<entity>.sql` (facts/events) or `dim_<entity>.sql` (dimensions/entities) |
| Location | `models/marts/<domain>/` |
| Purpose | Business-facing, wide tables, aggregations, final metrics. Named after the entity they represent. |

## Warehouse-Specific Materialization Defaults

Apply these defaults for mart models unless the user specifies otherwise:

| Warehouse | Small marts | Large/append-only marts | Incremental strategy |
|-----------|-------------|------------------------|---------------------|
| Snowflake | `table` | `incremental` | `merge` (default) or `delete+insert` |
| BigQuery | `table` | `incremental` | `merge` or `insert_overwrite` |
| Databricks | `table` | `incremental` | `merge` (Delta) or `append` |
| PostgreSQL | `table` | `incremental` | `delete+insert` |

For incremental marts, always include:
- `unique_key` in the config block
- An `{% if is_incremental() %}` filter on the timestamp column
- `on_schema_change: 'append_new_columns'` for forward compatibility

## YAML Configuration

### Sources YAML (`sources.yml`)

Generate from warehouse schema when the user provides a source table:

```yaml
version: 2

sources:
  - name: raw_stripe
    description: Raw Stripe payment data
    database: raw
    schema: stripe
    tables:
      - name: payments
        description: All payment transactions
        columns:
          - name: payment_id
            description: Primary key
            data_tests:
              - unique
              - not_null
          - name: amount
            description: Payment amount in cents
          - name: created_at
            description: Payment creation timestamp
            data_tests:
              - not_null
```

### Schema YAML (`schema.yml`)

Generated alongside models with column descriptions and tests:

```yaml
version: 2

models:
  - name: stg_stripe__payments
    description: Staged Stripe payments with renamed columns and type casts
    columns:
      - name: payment_id
        description: Primary key from source
        data_tests:
          - unique
          - not_null
      - name: amount_dollars
        description: Payment amount converted to dollars
```

### Properties YAML with Contracts

For public or critical mart models, suggest contract enforcement:

```yaml
version: 2

models:
  - name: fct_daily_revenue
    description: Daily revenue aggregated by date
    config:
      materialized: incremental
      unique_key: date_day
      on_schema_change: append_new_columns
      contract:
        enforced: true
    columns:
      - name: date_day
        data_type: date
        description: The calendar date
        data_tests:
          - unique
          - not_null
```

Contracts require every column to have a `data_type` matching the warehouse dialect. Only suggest contracts for mart-layer models that serve as stable interfaces.

## Column Pattern Heuristics

When generating column descriptions and tests automatically:

| Pattern | Description Template | Auto-Tests |
|---------|---------------------|------------|
| `*_id` | "Foreign key to {table}" or "Primary key" | `unique`, `not_null` (for PKs) |
| `*_at`, `*_date`, `*_timestamp` | "Timestamp of {event}" | `not_null` |
| `*_amount`, `*_price`, `*_cost` | "Monetary value in {currency}" | `not_null` |
| `is_*`, `has_*` | "Boolean flag for {condition}" | `accepted_values: [true, false]` |
| `*_type`, `*_status`, `*_category` | "Categorical: {values}" | `accepted_values` (if inferable) |
| `*_count`, `*_total`, `*_sum` | "Aggregated count/total" | -- |
| `*_name`, `*_title`, `*_label` | "Human-readable name" | -- |

## Documentation Patterns by Layer

When adding descriptions (step 9), write documentation appropriate to the model's layer:

| Layer | Description Focus |
|---|---|
| **Sources** | System of origin, sync frequency, known quirks |
| **Staging** | Renaming/casting rationale, filtered records, dedup logic |
| **Intermediate** | Join logic, aggregation grain, business rules applied |
| **Marts (fact)** | Business event captured, grain, measures available, consumers |
| **Marts (dim)** | Entity described, SCD type, key attributes, update frequency |

For accurate descriptions, use `dbt_lineage` to trace upstream dependencies and understand where each column actually comes from. A `customer_id` sourced from `stg_stripe__customers` should mention Stripe as the source system.

### Doc Blocks (for shared definitions)

If a definition is reused across 3+ models, generate a doc block:

```markdown
{% docs customer_id %}
Unique identifier for a customer. Sourced from the `customers` table
in the raw Stripe schema. Used as the primary join key across all
customer-related models.
{% enddocs %}
```

Reference it in YAML: `description: '{{ doc("customer_id") }}'`

## YAML Organization

Match the project's existing pattern. If no pattern exists, follow this default:

| Pattern | Convention | When to use |
|---------|-----------|-------------|
| One file per directory | `_<directory>__models.yml` | Default recommendation |
| One file per model | `_<model_name>.yml` | Large projects with frequent merge conflicts |
| Sources separate | `_<source_name>__sources.yml` | Always keep sources in their own file |

## Model Governance (dbt Mesh)

When scaffolding models in projects that use dbt Mesh or multi-project setups, include access modifiers in the companion YAML:

| Layer | Default access | When to use `public` |
|-------|---------------|---------------------|
| Staging | `protected` | Never -- staging models are internal building blocks |
| Intermediate | `private` or `protected` | Never -- intermediate models are implementation details |
| Mart | `protected` | When consumed by other dbt projects or BI tools outside the project |

For public mart models, also consider adding `contract: {enforced: true}` with explicit column `data_type` definitions.

## Usage

- `/model-scaffold staging orders from raw.public.orders` -- Scaffold staging model with sources.yml
- `/model-scaffold mart fct_daily_revenue` -- Scaffold mart model with YAML and tests
- `/model-scaffold intermediate int_orders__enriched` -- Scaffold intermediate model
- `/model-scaffold sources raw.stripe` -- Generate sources.yml from warehouse schema
- `/model-scaffold docs stg_stripe__payments` -- Add descriptions to existing YAML
- `/model-scaffold properties fct_daily_revenue` -- Generate properties.yml with contracts

Use the tools: `glob`, `read`, `schema_inspect`, `schema_search`, `dbt_lineage`, `dbt_manifest`, `write`, `edit`.
