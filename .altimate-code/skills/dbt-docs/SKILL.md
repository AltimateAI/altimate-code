---
name: dbt-docs
description: Generate or improve dbt model documentation — column descriptions, model descriptions, and doc blocks.
---

# Generate dbt Documentation

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** glob, read, schema_inspect, dbt_manifest, edit, write

> **When to use this vs other skills:** Use /dbt-docs to add or improve descriptions in existing schema.yml. Use /yaml-config to create schema.yml from scratch. Use /generate-tests to add test scaffolding.

Generate comprehensive documentation for dbt models by analyzing SQL logic, schema metadata, and existing docs.

## Workflow

1. **Find the target model** — Use `glob` to locate the model SQL and any existing schema YAML
2. **Read the model SQL** — Understand the transformations, business logic, and column derivations
3. **Read existing docs** — Check for existing `schema.yml`, `_<model>__models.yml`, and `docs/` blocks
4. **Inspect schema** — Use `schema_inspect` to get column types and nullability
5. **Read upstream models** — Use `dbt_manifest` to find dependencies, then `read` upstream SQL to understand data flow
6. **Generate documentation**:

### Model-Level Description
Write a clear, concise description that covers:
- **What** this model represents (business entity)
- **Why** it exists (use case)
- **How** it's built (key transformations, joins, filters)
- **When** it refreshes (materialization strategy)

Example:
```yaml
- name: fct_daily_revenue
  description: >
    Daily revenue aggregation by product category. Joins staged orders with
    product dimensions and calculates gross/net revenue. Materialized as
    incremental with a unique key on (date_day, category_id). Used by the
    finance team for daily P&L reporting.
```

### Column-Level Descriptions
For each column, describe:
- What the column represents in business terms
- How it's derived (if calculated/transformed)
- Any important caveats (nullability, edge cases)

Example:
```yaml
columns:
  - name: net_revenue
    description: >
      Total revenue minus refunds and discounts for the day.
      Calculated as: gross_revenue - refund_amount - discount_amount.
      Can be negative if refunds exceed sales.
```

### Doc Blocks (for shared definitions)
If a definition is reused across models, generate a doc block:

```markdown
{% docs customer_id %}
Unique identifier for a customer. Sourced from the `customers` table
in the raw Stripe schema. Used as the primary join key across all
customer-related models.
{% enddocs %}
```

7. **Write output** — Use `edit` to update existing YAML or `write` to create new files

## Quality Checklist
- Every column has a description (no empty descriptions)
- Descriptions use business terms, not technical jargon
- Calculated columns explain their formula
- Primary keys are identified
- Foreign key relationships are documented
- Edge cases and null handling are noted

## Usage

- `/dbt-docs models/marts/fct_daily_revenue.sql`
- `/dbt-docs stg_stripe__payments`
- `/dbt-docs --all models/staging/stripe/` — Document all models in a directory

Use the tools: `glob`, `read`, `schema_inspect`, `dbt_manifest`, `edit`, `write`.
