# YAML Config Generation

## sources.yml — Define Raw Data Sources

Generate from warehouse metadata using:
```bash
altimate-dbt columns-source --source <source_name> --table <table_name>
```

Template:
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

## schema.yml — Model Documentation and Tests

Generate after building a model using:
```bash
altimate-dbt columns --model <model_name>
```

Template:
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

## Column Pattern Heuristics

When auto-generating YAML, infer descriptions and tests from column names:

| Pattern | Description Template | Auto-Tests |
|---------|---------------------|------------|
| `*_id` | "Foreign key to {table}" or "Primary key" | `unique`, `not_null` |
| `*_at`, `*_date`, `*_timestamp` | "Timestamp of {event}" | `not_null` |
| `*_amount`, `*_price`, `*_cost` | "Monetary value" | `not_null` |
| `is_*`, `has_*` | "Boolean flag for {condition}" | `accepted_values: [true, false]` |
| `*_type`, `*_status`, `*_category` | "Categorical" | `accepted_values` (if inferable) |
| `*_count`, `*_total`, `*_sum` | "Aggregated count/total" | — |
| `*_name`, `*_title`, `*_label` | "Human-readable name" | — |

## File Naming Conventions

| Convention | Example |
|-----------|---------|
| Sources | `_<source>__sources.yml` |
| Model schema | `_<model>__models.yml` or `schema.yml` |
| Properties | `_<model>__models.yml` |

Match whatever convention the project already uses. Check existing `.yml` files in the same directory.

## Merging with Existing YAML

When YAML files already exist:
1. Read the existing file first
2. Add new entries without duplicating existing ones
3. Preserve human-written descriptions
4. Use `edit` tool (not `write`) to merge
