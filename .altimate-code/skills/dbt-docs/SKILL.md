---
name: dbt-docs
description: Generate or improve dbt model documentation -- column descriptions, model descriptions, and doc blocks. Use when the user wants to document a model, add column descriptions, improve existing docs, or generate documentation for undocumented models.
---

# Generate dbt Documentation

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** dbt_manifest, glob, read, schema_inspect, edit, write

> **When to use this vs other skills:** Use /dbt-docs to add or improve descriptions in existing schema.yml. Use /yaml-config to create schema.yml from scratch. Use /generate-tests to add test scaffolding.

Generate comprehensive documentation for dbt models by analyzing SQL logic, schema metadata, and existing docs.

## Workflow
1. **Find the target model** -- Use `glob` to locate the model SQL and any existing schema YAML (`schema.yml`, `_schema.yml`, `_<model>__models.yml`).
3. **Read the model SQL** -- Understand the transformations, business logic, and column derivations.
4. **Read existing docs** -- Check for existing schema YAML and `docs/` blocks. Note which columns already have descriptions to preserve them.
5. **Inspect schema** -- Use `schema_inspect` to get column types, nullability, and constraints from the warehouse.
6. **Read upstream models** -- Use `dbt_lineage` to get this model's upstream dependencies, then `read` upstream SQL to understand data flow and inherited column semantics. For complex projects with runtime vars, fall back to `dbt_manifest` for full DAG resolution.
7. **Generate documentation**:

### Model-Level Description

Write a clear, concise description that covers:
- **What** this model represents (business entity)
- **Why** it exists (use case, who consumes it)
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

Use the column's upstream lineage to write accurate descriptions. A `customer_id` that comes from `stg_stripe__customers` should reference Stripe as the source system.

Example:
```yaml
columns:
  - name: net_revenue
    description: >
      Total revenue minus refunds and discounts for the day.
      Calculated as: gross_revenue - refund_amount - discount_amount.
      Can be negative if refunds exceed sales.
  - name: customer_id
    description: >
      Unique identifier for a customer, sourced from the Stripe
      customers table. Used as the primary join key across all
      customer-related models. Never null.
```

### Documentation Patterns by Layer

| Layer | Description Focus |
|---|---|
| **Sources** | System of origin, sync frequency, known quirks |
| **Staging** | Renaming/casting rationale, filtered records, dedup logic |
| **Intermediate** | Join logic, aggregation grain, business rules applied |
| **Marts (fact)** | Business event captured, grain, measures available, consumers |
| **Marts (dim)** | Entity described, SCD type, key attributes, update frequency |

### Doc Blocks (for shared definitions)

If a definition is reused across 3+ models, generate a doc block:

```markdown
{% docs customer_id %}
Unique identifier for a customer. Sourced from the `customers` table
in the raw Stripe schema. Used as the primary join key across all
customer-related models.
{% enddocs %}
```

Reference it in YAML with:
```yaml
columns:
  - name: customer_id
    description: '{{ doc("customer_id") }}'
```
8. **Write output** -- Use `edit` to update existing YAML or `write` to create new files. Preserve any existing descriptions that are already accurate.

## Quality Checklist
- Every column has a description (no empty descriptions)
- Descriptions use business terms, not technical jargon
- Calculated columns explain their formula
- Primary keys are identified as such in the description
- Foreign key relationships are documented with the source model name
- Edge cases and null handling are noted
- Descriptions are written in plain English that a non-technical stakeholder can understand

## Usage

- `/dbt-docs models/marts/fct_daily_revenue.sql`
- `/dbt-docs stg_stripe__payments`
- `/dbt-docs --all models/staging/stripe/` -- Document all models in a directory

Use the tools: `dbt_manifest`, `glob`, `read`, `schema_inspect`, `edit`, `write`.
