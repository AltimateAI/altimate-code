---
layout: default
title: FinOps Tools
parent: Tools
nav_order: 3
---

# FinOps Tools

Cost optimization and warehouse governance. These tools help you find where money is being wasted and fix it.

## finops_query_history

Fetch recent query execution history from your warehouse.

```
> finops_query_history prod-snowflake --days 7

Recent Queries (top 10 by cost):
┌───┬──────────────────────────────────┬──────────┬────────┬───────────┬─────────┐
│ # │ Query (truncated)                │ Credits  │ Rows   │ Duration  │ Runs    │
├───┼──────────────────────────────────┼──────────┼────────┼───────────┼─────────┤
│ 1 │ SELECT * FROM events JOIN use... │ 89.3     │ 2.1B   │ 4m 12s    │ 47      │
│ 2 │ CREATE TABLE AS SELECT DISTIN... │ 45.1     │ 340M   │ 12m 33s   │ 1       │
│ 3 │ SELECT COUNT(DISTINCT user_id... │ 23.7     │ 890M   │ 1m 45s    │ 312     │
│ 4 │ INSERT INTO daily_agg SELECT... │ 18.2     │ 45M    │ 3m 21s    │ 7       │
│ 5 │ SELECT * FROM raw_clickstream...│ 12.8     │ 1.5B   │ 2m 08s    │ 3       │
└───┴──────────────────────────────────┴──────────┴────────┴───────────┴─────────┘

Summary:
  Total queries: 4,231
  Total credits: 847.2
  Avg credits/query: 0.20
```

**Parameters:**
- `warehouse` (required) — Connection name
- `days` (optional, default: 7) — Lookback period
- `limit` (optional, default: 100) — Max queries returned
- `user` (optional) — Filter by username
- `warehouse_filter` (optional) — Filter by compute warehouse name

**Data sources by warehouse:**
- Snowflake: `QUERY_HISTORY` function
- BigQuery: `INFORMATION_SCHEMA.JOBS`
- Databricks: `system.query.history`
- PostgreSQL: `pg_stat_statements`

---

## finops_analyze_credits

Break down credit consumption by warehouse, time, and user.

```
> finops_analyze_credits prod-snowflake --days 30

Credit Analysis (last 30 days):

Daily Usage Trend:
  Feb 1:  ████████████░░░░░░░░  28.4 credits
  Feb 2:  ███████████████░░░░░  35.1 credits
  ...
  Feb 26: ██████████████████░░  42.7 credits

By Warehouse:
  TRANSFORM_WH (XL):    523.1 credits (62%) ← largest cost driver
  ANALYTICS_WH (M):     187.3 credits (22%)
  LOADING_WH (S):        89.4 credits (11%)
  DEV_WH (XS):           47.4 credits (6%)

Recommendations:
  1. TRANSFORM_WH runs at 23% utilization — consider downsizing to L
  2. 340 queries on ANALYTICS_WH scan >1GB but return <100 rows — add filters
  3. DEV_WH has 0 queries between 2am-8am — enable auto-suspend
```

---

## finops_expensive_queries

Find your most expensive queries ranked by cost.

```
> finops_expensive_queries prod-snowflake --days 7 --limit 5

Top 5 Expensive Queries:

1. 89.3 credits | 47 executions | TRANSFORM_WH
   SELECT * FROM events e JOIN users u ON e.user_id = u.id
   Anti-patterns: SELECT_STAR, MISSING_LIMIT
   Fix: Add column list + date filter → estimated 71% savings

2. 45.1 credits | 1 execution | TRANSFORM_WH
   CREATE TABLE daily_snapshot AS SELECT DISTINCT ...
   Anti-patterns: None (legitimate full-table operation)
   Suggestion: Use incremental logic instead of full refresh

3. 23.7 credits | 312 executions | ANALYTICS_WH
   SELECT COUNT(DISTINCT user_id) FROM events WHERE ...
   Anti-patterns: None
   Suggestion: Pre-aggregate in a materialized view — saves ~23 credits/week

4. 18.2 credits | 7 executions | TRANSFORM_WH
   INSERT INTO daily_agg SELECT ... FROM raw_events
   Anti-patterns: SELECT_STAR_IN_SUBQUERY
   Fix: Explicit columns → estimated 40% savings

5. 12.8 credits | 3 executions | ANALYTICS_WH
   SELECT * FROM raw_clickstream WHERE event_type = 'page_view'
   Anti-patterns: SELECT_STAR
   Fix: Add column list + LIMIT → estimated 80% savings
```

---

## finops_warehouse_advice

Get warehouse sizing recommendations based on actual usage patterns.

```
> finops_warehouse_advice prod-snowflake --days 14

Warehouse Analysis:

TRANSFORM_WH (currently: X-Large)
  Avg utilization: 23%
  Peak utilization: 67% (Wed 2-4am during batch jobs)
  Avg queue time: 0.3s
  Recommendation: ↓ Downsize to LARGE
  Estimated savings: 210 credits/month ($630/month)

ANALYTICS_WH (currently: Medium)
  Avg utilization: 71%
  Peak utilization: 95% (Mon-Fri 9am-12pm)
  Avg queue time: 4.2s during peak
  Recommendation: → Keep current size, enable auto-scaling (max 2 clusters)
  Estimated impact: Queue time drops to <1s during peak

LOADING_WH (currently: Small)
  Avg utilization: 45%
  Peak utilization: 89% (daily at 6am)
  Recommendation: → Keep current size
  Auto-suspend: Currently 5min, recommend 1min (saves 12 credits/month)

DEV_WH (currently: X-Small)
  Avg utilization: 8%
  Active hours: 9am-6pm weekdays only
  Recommendation: → Keep size, set auto-suspend to 1min
  Estimated savings: 15 credits/month
```

---

## finops_unused_resources

Find tables and warehouses that are costing money but not being used.

```
> finops_unused_resources prod-snowflake --days 30

Unused Tables (no reads in 30 days):
  1. RAW.LEGACY_EVENTS — 450GB, last accessed 2025-11-03
  2. STAGING.STG_OLD_USERS — 12GB, last accessed 2025-12-15
  3. ANALYTICS.TMP_MIGRATION_2024 — 89GB, last accessed 2025-08-22
  Total storage: 551GB → ~$23/month in storage costs

Idle Warehouses (no queries in 7+ days):
  1. MIGRATION_WH (Medium) — last query 2026-02-10
  2. TEST_WH (Small) — last query 2026-01-28

Recommendations:
  1. Archive or drop the 3 unused tables → save $23/month
  2. Suspend MIGRATION_WH and TEST_WH → save credits on auto-resume
```

---

## finops_role_grants

Analyze role permissions and access patterns (RBAC).

```
> finops_role_grants prod-snowflake --role ANALYST_ROLE

Grants for ANALYST_ROLE:
┌──────────────┬───────────┬──────────────────────────┐
│ Privilege    │ Type      │ Object                   │
├──────────────┼───────────┼──────────────────────────┤
│ USAGE        │ WAREHOUSE │ ANALYTICS_WH             │
│ USAGE        │ DATABASE  │ ANALYTICS                │
│ USAGE        │ SCHEMA    │ ANALYTICS.MARTS          │
│ SELECT       │ TABLE     │ ANALYTICS.MARTS.*        │
│ SELECT       │ TABLE     │ ANALYTICS.STAGING.*      │
│ USAGE        │ SCHEMA    │ ANALYTICS.RAW            │
│ SELECT       │ TABLE     │ ANALYTICS.RAW.*          │
└──────────────┴───────────┴──────────────────────────┘

Privilege Summary:
  SELECT on 847 tables across 3 schemas
  No INSERT/UPDATE/DELETE privileges ✓
  No DDL privileges ✓
```

---

## finops_role_hierarchy

Visualize role inheritance.

```
> finops_role_hierarchy prod-snowflake

Role Hierarchy:
  ACCOUNTADMIN
  ├── SYSADMIN
  │   ├── TRANSFORM_ROLE
  │   │   └── DBT_ROLE
  │   ├── LOADING_ROLE
  │   └── ADMIN_ROLE
  ├── SECURITYADMIN
  │   └── USERADMIN
  └── PUBLIC
      ├── ANALYST_ROLE
      └── VIEWER_ROLE

8 roles total
```

---

## finops_user_roles

List user-to-role assignments.

```
> finops_user_roles prod-snowflake

┌──────────────────┬────────────────┬───────────────┐
│ User             │ Role           │ Default Role  │
├──────────────────┼────────────────┼───────────────┤
│ alice@company.com│ ANALYST_ROLE   │ YES           │
│ alice@company.com│ VIEWER_ROLE    │ NO            │
│ bob@company.com  │ TRANSFORM_ROLE │ YES           │
│ bob@company.com  │ DBT_ROLE       │ NO            │
│ svc_dbt          │ DBT_ROLE       │ YES           │
│ svc_fivetran     │ LOADING_ROLE   │ YES           │
└──────────────────┴────────────────┴───────────────┘
```
