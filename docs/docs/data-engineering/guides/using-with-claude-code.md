# Using altimate with Claude Code

altimate can work alongside Claude Code. While Claude Code handles general coding tasks, altimate provides specialized data engineering capabilities that Claude Code doesn't have.

## How it works

Claude Code can invoke altimate as a tool when working on data projects. The `/data` skill routes data engineering tasks to altimate's specialized tools.

```
# In Claude Code
/data "analyze the cost of our Snowflake warehouse"
```

This gives Claude Code access to:
- SQL analysis and anti-pattern detection
- Column-level lineage
- Cost prediction and FinOps analysis
- Schema inspection and PII detection
- dbt manifest parsing and model scaffolding
- Cross-dialect SQL translation

## Example workflows

### Code review with cost analysis

When Claude Code reviews a PR that includes SQL changes:

```
Claude Code: I see changes to models/marts/fct_revenue.sql. Let me check
             for data engineering concerns.

> /data "analyze fct_revenue.sql for anti-patterns and estimate cost"

altimate:
  sql_analyze: No anti-patterns detected ✓
  lineage_check: Sources stg_orders.amount, dim_products.category
  schema_diff: Added column revenue_category (low severity)
```

### dbt project setup

```
You (in Claude Code): Set up a new dbt model for our customer metrics

Claude Code: I'll create the model structure. Let me use altimate
             to inspect the source tables first.

> /data "inspect the raw.customers and raw.orders tables"

altimate:
  schema_inspect raw.customers → 12 columns
  schema_inspect raw.orders → 8 columns
  lineage_check [draft SQL] → verified column mappings

Claude Code: Here's the staging model based on the actual schema...
```

### FinOps during development

```
You (in Claude Code): This query is slow, can you optimize it?

Claude Code: Let me analyze it with altimate's SQL tools.

> /data "analyze and optimize: SELECT * FROM events WHERE YEAR(event_date) = 2026"

altimate:
  sql_analyze:
    ⚠ SELECT_STAR: Use explicit columns
    ⚠ FUNCTION_IN_FILTER: YEAR() prevents partition pruning
  sql_optimize:
    Optimized: explicit columns + range predicate
    Estimated improvement: 70-80% fewer bytes scanned
```

## Setup

1. Install altimate globally: `npm install -g altimate-code`
2. Configure warehouse connections in your project
3. Claude Code automatically discovers altimate's tools when the `/data` skill is invoked

## When to use which

| Task | Use Claude Code | Use altimate |
|---|---|---|
| Writing Python/JS code | Yes | No |
| SQL anti-pattern detection | No | Yes |
| Column-level lineage | No | Yes |
| Cost prediction | No | Yes |
| FinOps analysis | No | Yes |
| Schema inspection | No | Yes |
| dbt model scaffolding | Partially | Yes (better) |
| Cross-dialect translation | No | Yes |
| PII detection | No | Yes |
| General code review | Yes | Supplement with data checks |
| File editing | Yes | Yes (in builder mode) |
