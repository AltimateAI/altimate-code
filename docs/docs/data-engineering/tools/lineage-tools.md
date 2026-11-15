---
title: "Lineage Tools — Column-Level Lineage — Altimate Code"
description: "Trace column-level data lineage across your warehouse with Altimate Code's lineage_check tool."
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

## impact_analysis

Shows what a change to a dbt model, or to one of its columns, affects downstream, from the project's `manifest.json`.

```
impact_analysis({ model: "stg_orders", column: "order_id", change_type: "rename" })
impact_analysis({ model: "fct_orders", column: "revenue", change_type: "modify", direction: "upstream" })
```

| Parameter | Meaning |
|---|---|
| `model` | The model, by name or unique id |
| `column` | Optional. Without it, the report is model-level only |
| `change_type` | The change you plan: `remove`, `rename`, `retype`, `add` or `modify` |
| `manifest_path` | Path to `manifest.json`; `target/manifest.json` by default |
| `direction` | With a column: `downstream` (default) says where its value goes; `upstream` traces where it comes from |
| `dialect` | Optional SQL dialect; read from the manifest when left out |

The report lists the directly and transitively affected models, their tests, and the exposures (dashboards) on them. With a column, it also traces each model's compiled SQL hop by hop and adds a column answer: the columns that carry the value, in which models, how many hops, and where it ends. A model the trace cannot settle (for example a `select *`, a natural join, or SQL the engine cannot read) is listed as one that *may carry* it, with the reason, rather than dropped. The full answer is in the tool's `metadata.column_answer`. If the column answer cannot be built, the report says why, and the model-level impact still stands.
