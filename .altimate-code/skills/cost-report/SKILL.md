---
name: cost-report
description: >
  Generate a warehouse cost and efficiency report -- credit consumption, expensive queries,
  warehouse sizing, unused resources, and savings estimates. Also audits for waste: unused tables,
  idle warehouses, and over-provisioned clusters. Use when the user asks about query costs, credit
  consumption, warehouse spend, cost optimization, resource cleanup, or wants a spending breakdown.
---

# Cost Report

## Requirements
**Agent:** any (read-only analysis)
**Tools used:** finops_analyze_credits, finops_expensive_queries, finops_warehouse_advice, finops_unused_resources, finops_role_grants, finops_user_roles, sql_analyze, sql_predict_cost, schema_inspect

Generate a comprehensive cost, efficiency, and resource waste report for any supported warehouse. Uses finops tools for data gathering -- no raw SQL needed.

## Workflow
1. **Gather cost data** -- Call `finops_analyze_credits` to get credit/cost breakdown over the requested time period (default: 30 days). This returns total spend, daily trends, and cost by service category.
2. **Find expensive queries** -- Call `finops_expensive_queries` with the time period to get the top costly queries ranked by resource consumption. This surfaces the biggest optimization targets.
3. **Analyze warehouse efficiency** -- Call `finops_warehouse_advice` to get sizing recommendations, utilization metrics, and auto-suspend configuration for each warehouse/cluster.
4. **Audit for waste** -- Call `finops_unused_resources` to identify stale objects:
   - Unused tables: no reads in the lookback period (default: 90 days)
   - Idle warehouses: running but with zero or near-zero query volume
   - Stale schemas: entire schemas with no recent activity
   For key unused tables, call `schema_inspect` to get row count, storage size, and column count for concrete savings estimates.
5. **Review access patterns** (Snowflake only, optional) -- If the user has a Snowflake connection and wants cost attribution by role or user:
   - Call `finops_role_grants` to see which roles have access to expensive resources
   - Call `finops_user_roles` to map users to roles for cost allocation
   - Skip this step for non-Snowflake warehouses -- these tools query Snowflake ACCOUNT_USAGE views
6. **Analyze anti-patterns** -- For each of the top 5-10 expensive queries from step 2:
   - Call `sql_analyze` with the query text and detected `dialect` to identify optimization opportunities (SELECT *, missing LIMIT, cartesian joins, correlated subqueries, etc.)
   - Note which anti-patterns have the highest cost impact
7. **Predict savings** -- For queries where `sql_analyze` found actionable anti-patterns:
   - Call `sql_predict_cost` on the original query to get a cost tier baseline
   - Estimate savings potential based on the anti-patterns found (e.g., removing SELECT * reduces I/O, adding partition filters reduces scan volume)
8. **Estimate total savings** -- Aggregate savings across all categories:
   - Storage savings: sum of unused table sizes
   - Compute savings: idle warehouse credits that could be reclaimed with auto-suspend
   - Right-sizing savings: difference between current and recommended warehouse sizes
   - Query optimization savings: estimated reduction from fixing anti-patterns
9. **Generate the report** as structured markdown:

```
# Cost Report ({warehouse_type}, last {N} days)

## Executive Summary
- Total spend: $X / Y credits
- Daily average: $X/day
- Top cost driver: {warehouse or query category}
- Total estimated savings: $X/month

## Cost Breakdown
### By Warehouse/Cluster
| Warehouse | Credits | % of Total | Avg Utilization |
|-----------|---------|------------|-----------------|

### By User
| User | Credits | Query Count | Avg Cost/Query |
|------|---------|-------------|----------------|

### By Query Type
| Type | Credits | Count | Avg Cost |
|------|---------|-------|----------|

## Top Expensive Queries

### Query 1 — {credits} credits
**User:** {user} | **Warehouse:** {wh} | **Type:** {type}
**Anti-patterns:** {list from sql_analyze}
**Savings potential:** {estimated reduction}
**Recommended fix:** {specific optimization}

...

## Warehouse Efficiency
| Warehouse | Current Size | Recommended | Utilization | Monthly Cost | Action |
|-----------|-------------|-------------|-------------|-------------|--------|

### Auto-Suspend Configuration
| Warehouse | Current Setting | Recommended |
|-----------|----------------|-------------|

## Unused Resources
### Unused Tables
| Table | Last Accessed | Rows | Storage | Recommendation |
|-------|--------------|------|---------|----------------|
Estimated storage savings: $X/month

### Idle Warehouses
| Warehouse | Size | Queries (last {N}d) | Auto-Suspend | Monthly Cost | Recommendation |
|-----------|------|---------------------|-------------|-------------|----------------|
Estimated compute savings: $X/month

## Action Items (Prioritized by Savings)
1. {Highest-impact recommendation with estimated savings}
2. {Second recommendation}
3. {Third recommendation}
...
```

## Resource Categories

| Category | Signal | Risk of Removal |
|----------|--------|-----------------|
| Temporary tables | Name contains tmp_, temp_, test_ | Low -- safe to drop |
| Old partitions | Date suffix > 1 year old | Medium -- verify retention policy |
| Idle warehouses | Zero queries in 30+ days | Low -- suspend, don't drop |
| Dev/staging objects | In non-production schemas | Low -- confirm with team |
| Unused views | No downstream queries | Low -- drop after confirming |

## Usage

- `/cost-report` -- Full cost analysis and resource audit (last 30 days)
- `/cost-report 7` -- Analyze the last 7 days
- `/cost-report warehouse=ANALYTICS_WH` -- Focus on a specific warehouse
- `/cost-report --days 90` -- Use a 90-day lookback for unused resources
