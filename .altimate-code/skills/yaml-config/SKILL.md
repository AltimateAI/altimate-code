---
name: yaml-config
description: Generate dbt YAML configuration files — sources.yml, schema.yml, properties.yml — from warehouse schema or existing models.
---

# Generate dbt YAML Config

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** glob, read, schema_inspect, schema_search, dbt_manifest, write, edit

> **When to use this vs other skills:** Use /yaml-config to generate sources.yml or schema.yml from warehouse metadata. Use /generate-tests to add test definitions. Use /dbt-docs to enrich existing YAML with descriptions.

Generate or update dbt YAML configuration files by inspecting warehouse schemas and existing models.

## Workflow

1. **Determine config type** — sources.yml, schema.yml, or properties.yml
2. **Read existing configs** — Use `glob` to find existing YAML files in the project and `read` to understand current state
3. **Inspect warehouse schema** — Use `schema_inspect` and `schema_search` to discover tables and columns
4. **Read the manifest** — If available, use `dbt_manifest` to find existing model definitions
5. **Generate the YAML** based on the config type:

### Config Types

#### sources.yml — Define raw data sources
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
            tests:
              - unique
              - not_null
          - name: amount
            description: Payment amount in cents
          - name: created_at
            description: Payment creation timestamp
            tests:
              - not_null
```

#### schema.yml — Model documentation and tests
```yaml
version: 2

models:
  - name: stg_stripe__payments
    description: Staged Stripe payments with renamed columns and type casts
    columns:
      - name: payment_id
        description: Primary key from source
        tests:
          - unique
          - not_null
      - name: amount_dollars
        description: Payment amount converted to dollars
```

#### properties.yml — Model-level config
```yaml
version: 2

models:
  - name: fct_daily_revenue
    config:
      materialized: incremental
      unique_key: date_day
      on_schema_change: append_new_columns
    columns:
      - name: date_day
        description: The calendar date
```

6. **Merge with existing** — If YAML files already exist, merge new entries without duplicating existing definitions. Preserve human-written descriptions.
7. **Write the output** — Use `write` or `edit` to save the YAML file

### Column Pattern Heuristics

When generating column descriptions and tests automatically:

| Pattern | Description Template | Auto-Tests |
|---------|---------------------|------------|
| `*_id` | "Foreign key to {table}" or "Primary key" | `unique`, `not_null` |
| `*_at`, `*_date`, `*_timestamp` | "Timestamp of {event}" | `not_null` |
| `*_amount`, `*_price`, `*_cost` | "Monetary value in {currency}" | `not_null` |
| `is_*`, `has_*` | "Boolean flag for {condition}" | `accepted_values: [true, false]` |
| `*_type`, `*_status`, `*_category` | "Categorical: {values}" | `accepted_values` (if inferable) |
| `*_count`, `*_total`, `*_sum` | "Aggregated count/total" | — |
| `*_name`, `*_title`, `*_label` | "Human-readable name" | — |

## Usage

- `/yaml-config sources raw.stripe` — Generate sources.yml from warehouse schema
- `/yaml-config schema stg_stripe__payments` — Generate schema.yml for a model
- `/yaml-config properties fct_daily_revenue` — Generate properties.yml with config

Use the tools: `glob`, `read`, `schema_inspect`, `schema_search`, `dbt_manifest`, `write`, `edit`.
