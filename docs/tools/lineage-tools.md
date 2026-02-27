---
layout: default
title: Lineage Tools
parent: Tools
nav_order: 4
---

# Lineage Tools

## lineage_check

Trace column-level lineage through SQL transformations. Returns source-to-target mappings for every column.

```
> lineage_check "
    SELECT
        o.order_id,
        c.name AS customer_name,
        o.amount * t.rate AS amount_usd,
        DATE_TRUNC('month', o.order_date) AS order_month
    FROM orders o
    JOIN customers c ON o.customer_id = c.id
    JOIN fx_rates t ON o.currency = t.currency AND o.order_date = t.rate_date
  "

Column Lineage:
┌─────────────────┬────────────────────────┬───────────────┐
│ Target Column   │ Source                 │ Transform     │
├─────────────────┼────────────────────────┼───────────────┤
│ order_id        │ orders.order_id        │ direct        │
│ customer_name   │ customers.name         │ alias         │
│ amount_usd      │ orders.amount          │ arithmetic    │
│                 │ fx_rates.rate          │ arithmetic    │
│ order_month     │ orders.order_date      │ DATE_TRUNC    │
└─────────────────┴────────────────────────┴───────────────┘

Confidence: high
Confidence factors: schema-qualified tables, no SELECT *, small graph (7 nodes)
```

### Confidence signals

Lineage confidence is affected by 4 factors:

| Factor | Impact | Why |
|---|---|---|
| `SELECT *` | Reduces to medium | Cannot determine which columns flow through |
| Jinja templates | Reduces to medium | Dynamic SQL not fully parseable |
| Missing schema qualification | Reduces to low | Ambiguous table references |
| Large graph (50+ nodes) | Reduces to medium | Complex lineage may miss indirect paths |

### Use cases

**Impact analysis before schema changes:**

```
> lineage_check "SELECT * FROM stg_orders"

Warning: SELECT * detected — lineage confidence reduced to medium.
All columns from stg_orders flow through.

Recommendation: Use explicit column list for precise lineage.
```

**Verify lineage preservation during migration:**

```
> lineage_check [original Snowflake SQL]
> lineage_check [translated BigQuery SQL]

Compare: ✓ Same 4 source columns map to same 4 target columns
Lineage preserved across translation.
```

**dbt model dependency tracking:**

```
> dbt_manifest ./target/manifest.json

Models: 47
Sources: 12

> lineage_check [fct_revenue.sql]

Source columns:
  stg_orders.order_amount → fct_revenue.revenue
  stg_orders.order_date → fct_revenue.revenue_date
  dim_products.category → fct_revenue.product_category

Downstream impact: dim_products.category rename would break fct_revenue
```
