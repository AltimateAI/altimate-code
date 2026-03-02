---
layout: default
title: Cost Optimization Guide
parent: Guides
nav_order: 1
---

# Cost Optimization Guide

altimate-code is your cost advocate. Here's how to use it to cut warehouse spend.

## Step 1: Find where money is going

```
You: What's driving our Snowflake costs?

> finops_analyze_credits prod-snowflake --days 30
> finops_expensive_queries prod-snowflake --days 30 --limit 20
```

This gives you:
- Credit breakdown by warehouse, user, and time
- Top 20 most expensive queries with anti-pattern flags
- Trend data (are costs increasing?)

## Step 2: Fix the worst offenders

For each expensive query, the agent automatically runs `sql_analyze` to find anti-patterns:

### SELECT * → explicit columns

**Before:** 89.3 credits/week
```sql
SELECT * FROM events e JOIN users u ON e.user_id = u.id
```

**After:** ~25 credits/week (72% savings)
```sql
SELECT e.event_id, e.event_type, e.created_at, u.name, u.email
FROM events e
JOIN users u ON e.user_id = u.id
```

### Missing date filter on partitioned tables

**Before:** 45.1 credits (full table scan)
```sql
SELECT DISTINCT customer_id FROM orders WHERE status = 'active'
```

**After:** ~2.3 credits (95% savings)
```sql
SELECT DISTINCT customer_id
FROM orders
WHERE status = 'active'
  AND order_date >= DATEADD(day, -90, CURRENT_DATE())
```

### Non-sargable predicates

**Before:** Scans entire column, can't use clustering
```sql
WHERE YEAR(order_date) = 2026
```

**After:** Enables partition pruning
```sql
WHERE order_date >= '2026-01-01' AND order_date < '2027-01-01'
```

## Step 3: Right-size warehouses

```
You: Are our warehouses the right size?

> finops_warehouse_advice prod-snowflake --days 14
```

Common findings:
- **Over-provisioned warehouses** — Utilization below 30% means you're paying for idle compute
- **Missing auto-suspend** — Warehouses running 24/7 when only used during business hours
- **Wrong size for workload** — Small queries on XL warehouses waste credits

## Step 4: Clean up unused resources

```
You: What tables and warehouses are unused?

> finops_unused_resources prod-snowflake --days 30
```

This finds:
- Tables with no reads in 30+ days (costing storage)
- Warehouses with no queries in 7+ days
- Temporary tables from old migrations

## Step 5: Predict before you execute

Every query goes through cost prediction before execution:

```
You: How much will this query cost?

> sql_predict_cost "SELECT * FROM raw_clickstream"

  Tier 3 estimate: ~45 credits
  Table size: 890GB, 12B rows
  Recommendation: Add date filter + column pruning → estimated 2-3 credits
```

## Step 6: Build a cost feedback loop

After each query, `sql_record_feedback` stores actual execution metrics. This trains the cost prediction model to be more accurate over time.

```
Query executed: 0.84 credits (predicted: 0.79, Tier 2)
Feedback recorded → next prediction will be more accurate
```

## Automation: CI cost gate

Use `ci_cost_gate` in your CI/CD pipeline to block expensive queries from reaching production:

```
> ci_cost_gate --threshold 10 models/marts/fct_revenue.sql

Cost Gate Results:
  fct_revenue.sql: 2.3 credits (PASS — under 10 credit threshold)
  fct_orders.sql: 0.8 credits (PASS)
  fct_daily_snapshot.sql: 45.1 credits (FAIL — exceeds threshold)

1 model blocked. Fix fct_daily_snapshot.sql before deploying.
```

## Quick wins checklist

| Action | Typical savings | Effort |
|---|---|---|
| Replace SELECT * with explicit columns | 50-80% per query | Low |
| Add date filters to large table scans | 80-95% per query | Low |
| Fix non-sargable WHERE clauses | 30-60% per query | Low |
| Downsize over-provisioned warehouses | 30-50% monthly | Medium |
| Enable auto-suspend (1 min) | 10-20% monthly | Low |
| Drop unused tables | Storage savings | Low |
| Materialized views for repeated queries | 90%+ per query | Medium |
| Incremental models instead of full refresh | 50-90% per run | Medium |
