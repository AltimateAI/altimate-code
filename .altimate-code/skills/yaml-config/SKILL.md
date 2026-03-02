---
name: yaml-config
description: >
  Generate dbt YAML configuration files -- sources.yml, schema.yml, properties.yml -- from
  warehouse schema or existing models. Use when the user wants to create or update dbt YAML
  files, define sources, add model documentation and tests in YAML, generate schema.yml from
  a table, or configure model properties like materialization and contracts.
---

# Generate dbt YAML Config

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** warehouse_list, dbt_profiles, glob, read, schema_inspect, schema_search, dbt_manifest, write, edit

> **When to use this vs other skills:** Use `/yaml-config` to generate sources.yml or schema.yml from warehouse metadata. Use `/generate-tests` to add test definitions. Use `/dbt-docs` to enrich existing YAML with descriptions.

Generate or update dbt YAML configuration files by inspecting warehouse schemas and existing models.

## Workflow

1. **Detect warehouse** -- Use `warehouse_list` or `dbt_profiles` to discover the connected warehouse type and dialect. This determines default schema quoting, database structure, and available configurations.

2. **Determine config type** -- sources.yml, schema.yml, or properties.yml.

3. **Read existing configs** -- Use `glob` to find existing YAML files in the project and `read` to understand the current organization pattern (one file per directory vs. one file per model). Match the existing convention.

4. **Inspect warehouse schema** -- Use `schema_inspect` and `schema_search` to discover tables and columns.

5. **Read the manifest** -- If available, use `dbt_manifest` to find existing model definitions and avoid duplicating entries.

6. **Generate the YAML** based on the config type below.

7. **Merge with existing** -- If YAML files already exist, merge new entries without duplicating existing definitions. Preserve human-written descriptions. Use `edit` for surgical updates, `write` only for new files.

8. **Write the output** -- Use `write` or `edit` to save the YAML file.

## Config Types

### sources.yml -- Define raw data sources

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

### schema.yml -- Model documentation and tests

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

### properties.yml -- Model-level config with contracts

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
      - name: total_revenue
        data_type: numeric
        description: Sum of all revenue for the day
```

## YAML Organization

Match the project's existing pattern. If no pattern exists, follow this default:

| Pattern | Convention | When to use |
|---------|-----------|-------------|
| One file per directory | `_<directory>__models.yml` | Default recommendation. Balances discoverability with maintainability. |
| One file per model | `_<model_name>.yml` | Large projects where models change independently and merge conflicts are common. |
| Sources separate | `_<source_name>__sources.yml` | Always keep sources in their own file, co-located in `models/staging/<source>/`. |

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

## Test Key: `data_tests` vs `tests`

Use `data_tests:` in generated YAML. This is the preferred key since dbt v1.8, which distinguishes data tests from unit tests. The older `tests:` key still works but `data_tests:` is clearer. If the project already uses `tests:`, match the existing convention for consistency.

## Model Contracts

When generating properties for public or critical mart models, suggest contract enforcement:

```yaml
models:
  - name: fct_orders
    config:
      contract:
        enforced: true
    columns:
      - name: order_id
        data_type: varchar
        description: Unique order identifier
        data_tests:
          - unique
          - not_null
```

Contracts require every column to have a `data_type` that matches the warehouse dialect. Only suggest contracts for mart-layer models that serve as stable interfaces.

## Usage

- `/yaml-config sources raw.stripe` -- Generate sources.yml from warehouse schema
- `/yaml-config schema stg_stripe__payments` -- Generate schema.yml for a model
- `/yaml-config properties fct_daily_revenue` -- Generate properties.yml with config and contract

Use the tools: `warehouse_list`, `dbt_profiles`, `glob`, `read`, `schema_inspect`, `schema_search`, `dbt_manifest`, `write`, `edit`.
