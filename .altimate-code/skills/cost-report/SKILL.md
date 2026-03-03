---
name: cost-report
description: >
  Generate a warehouse cost and efficiency report using finops tools.
  Use when the user asks about query costs, credit consumption, warehouse spend,
  cost optimization, or wants a spending breakdown by user, warehouse, or query type.
domain: finops
persona:
  - data-engineer
  - platform-engineer
tools:
  - warehouse_list
  - dbt_profiles
  - finops_analyze_credits
  - finops_expensive_queries
  - finops_warehouse_advice
  - finops_unused_resources
  - finops_role_grants
  - finops_user_roles
  - sql_analyze
  - sql_predict_cost
docs:
  - title: "Snowflake Cost Management"
    url: "https://docs.snowflake.com/en/user-guide/cost-managing"
    context: "Credit consumption, warehouse billing, resource monitors, cost controls"
  - title: "BigQuery Pricing"
    url: "https://cloud.google.com/bigquery/pricing"
    context: "On-demand vs capacity pricing, storage costs, free tier limits"
---

# Cost Report

## Requirements
**Agent:** any (read-only analysis)
**Tools used:** warehouse_list, dbt_profiles, finops_analyze_credits, finops_expensive_queries, finops_warehouse_advice, finops_unused_resources, finops_role_grants, finops_user_roles, sql_analyze, sql_predict_cost

Generate a comprehensive cost and efficiency report for any supported warehouse. Uses finops tools for data gathering -- no raw SQL needed.

## Workflow
1. **Detect the warehouse** -- This is the critical first step. Never assume a dialect.
   - Call `warehouse_list` to check for configured connections
   - If no connections found, call `dbt_profiles` to discover warehouse type from dbt configuration
   - If neither yields a result, ask the user which warehouse they are using
   - Load the appropriate reference file from `references/` for warehouse-specific cost context
2. **Gather cost data** -- Call `finops_analyze_credits` to get credit/cost breakdown over the requested time period (default: 30 days). This returns total spend, daily trends, and cost by service category.
3. **Find expensive queries** -- Call `finops_expensive_queries` with the time period to get the top costly queries ranked by resource consumption. This surfaces the biggest optimization targets.
4. **Analyze warehouse efficiency** -- Call `finops_warehouse_advice` to get sizing recommendations, utilization metrics, and auto-suspend configuration for each warehouse/cluster.
5. **Check for waste** -- Call `finops_unused_resources` to identify unused tables, idle warehouses, and stale objects that incur storage or compute cost with no return.
6. **Review access patterns** (optional) -- If the user wants cost attribution by role or user:
   - Call `finops_role_grants` to see which roles have access to expensive resources
   - Call `finops_user_roles` to map users to roles for cost allocation
7. **Analyze anti-patterns** -- For each of the top 5-10 expensive queries from step 3:
   - Call `sql_analyze` with the query text and detected `dialect` to identify optimization opportunities (SELECT *, missing LIMIT, cartesian joins, correlated subqueries, etc.)
   - Note which anti-patterns have the highest cost impact
8. **Predict savings** -- For queries where `sql_analyze` found actionable anti-patterns:
   - Call `sql_predict_cost` on the original query to get a cost tier baseline
   - Estimate savings potential based on the anti-patterns found (e.g., removing SELECT * reduces I/O, adding partition filters reduces scan volume)
9. **Generate the report** as structured markdown:

```
# Cost Report ({warehouse_type}, last {N} days)

## Executive Summary
- Total spend: $X / Y credits
- Daily average: $X/day
- Top cost driver: {warehouse or query category}
- Estimated savings opportunity: $X (from optimizations below)

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
| Warehouse | Size | Utilization | Recommendation |
|-----------|------|-------------|----------------|

## Waste Identification
- Unused tables: {count} ({storage cost})
- Idle warehouses: {count} ({compute waste})
- Stale objects: {count}

## Optimization Recommendations
1. {Highest-impact recommendation with estimated savings}
2. {Second recommendation}
3. {Third recommendation}
...
```

## Usage

- `/cost-report` -- Analyze the last 30 days
- `/cost-report 7` -- Analyze the last 7 days
- `/cost-report warehouse=ANALYTICS_WH` -- Focus on a specific warehouse

Use the tools: `warehouse_list`, `dbt_profiles`, `finops_analyze_credits`, `finops_expensive_queries`, `finops_warehouse_advice`, `finops_unused_resources`, `finops_role_grants`, `finops_user_roles`, `sql_analyze`, `sql_predict_cost`.
