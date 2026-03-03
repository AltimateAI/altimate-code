---
name: resource-audit
description: >
  Find unused tables, idle warehouses, and wasted storage -- identify resources that can be downsized,
  suspended, or removed to reduce costs. Use when the user wants to cut cloud spend, find stale data,
  right-size warehouses, or run a resource cleanup.
persona:
  - data-engineer
  - platform-engineer
domain: finops
tools:
  - finops_unused_resources
  - finops_warehouse_advice
  - finops_expensive_queries
  - schema_inspect
docs:
  - title: "Snowflake Resource Monitors"
    url: "https://docs.snowflake.com/en/user-guide/resource-monitors"
    context: "Setting up resource monitors, credit quotas, alerts"
---

# Resource Audit

## Requirements
**Agent:** any (read-only analysis)
**Tools used:** finops_unused_resources, finops_warehouse_advice, finops_expensive_queries, schema_inspect

Find wasted resources across the warehouse: unused tables consuming storage, idle warehouses burning credits, over-provisioned clusters, and stale objects. Produces a savings estimate with prioritized action items.

## Workflow
1. **Find unused resources** -- Call `finops_unused_resources` to identify stale objects
   - Unused tables: no reads in the lookback period (default: 90 days)
   - Idle warehouses: running but with zero or near-zero query volume
   - Stale schemas: entire schemas with no recent activity
   - If the user specified `--days`, use that as the lookback period
3. **Analyze warehouse efficiency** -- Call `finops_warehouse_advice` to get sizing recommendations
   - Utilization metrics: what percentage of provisioned capacity is actually used
   - Auto-suspend configuration: which warehouses lack auto-suspend or have it set too high
   - Right-sizing: which warehouses are over-provisioned relative to their workload
   - If the user specified `--warehouse`, focus on that specific warehouse
4. **Find expensive query patterns** -- Call `finops_expensive_queries` to identify cost drivers
   - Cross-reference with unused resources: are expensive queries hitting stale tables?
   - Identify warehouses that are both under-utilized AND running expensive queries (mis-sized)
5. **Inspect flagged resources** -- For key unused tables:
   - Call `schema_inspect` to get row count, storage size, last DDL time, and column count
   - This provides concrete data for the savings estimate
   - Prioritize tables by storage footprint
6. **Estimate savings** -- Calculate potential cost reduction:
   - Storage savings: sum of unused table sizes
   - Compute savings: idle warehouse credits that could be reclaimed with auto-suspend
   - Right-sizing savings: difference between current and recommended warehouse sizes
7. **Generate the resource audit report**:

```
Resource Audit Report
=====================
Warehouse: <detected dialect>
Lookback period: <N> days
Total potential savings: $X,XXX/month (estimated)

## Unused Tables
| Table | Last Accessed | Rows | Storage | Recommendation |
|-------|--------------|------|---------|----------------|
| raw.logs_2022 | 2023-06-15 | 50M | 12 GB | Archive or drop |
| staging.tmp_migration | 2023-01-01 | 200K | 500 MB | Drop (temporary) |
| analytics.old_dashboard | Never | 1M | 2 GB | Drop |
Estimated storage savings: $X/month

## Idle Warehouses
| Warehouse | Size | Queries (last {N}d) | Auto-Suspend | Monthly Cost | Recommendation |
|-----------|------|---------------------|-------------|-------------|----------------|
| DEV_WH | M | 3 | 10 min | $200 | Suspend or downsize to XS |
| LEGACY_ETL | L | 0 | Never | $800 | Suspend immediately |
Estimated compute savings: $X/month

## Warehouse Sizing
| Warehouse | Current Size | Recommended | Utilization | Action |
|-----------|-------------|-------------|-------------|--------|
| ANALYTICS_WH | XL | L | 35% | Downsize |
| ETL_WH | M | M | 78% | Keep |
| REPORTING_WH | L | M | 42% | Downsize |
Estimated right-sizing savings: $X/month

## Auto-Suspend Configuration
| Warehouse | Current Setting | Recommended |
|-----------|----------------|-------------|
| ANALYTICS_WH | 5 min | 1 min |
| DEV_WH | 10 min | 1 min |
| LEGACY_ETL | Never | 1 min (or suspend) |

## Action Items (Prioritized by Savings)
1. Suspend LEGACY_ETL warehouse -- $800/month savings, zero recent usage
2. Downsize ANALYTICS_WH from XL to L -- ~$500/month savings, only 35% utilized
3. Drop 3 unused tables -- $X/month storage savings
4. Set auto-suspend to 1 min on DEV_WH -- $X/month savings
5. Archive raw.logs_2022 to cold storage -- $X/month savings
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

- `/resource-audit` -- Full audit with 90-day lookback
- `/resource-audit --days 30` -- Use a 30-day lookback period
- `/resource-audit --warehouse ANALYTICS_WH` -- Focus on a specific warehouse
- `/resource-audit --database raw` -- Scope to a specific database

Use the tools: `finops_unused_resources`, `finops_warehouse_advice`, `finops_expensive_queries`, `schema_inspect`.
