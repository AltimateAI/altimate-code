---
name: cost-report
description: Analyze warehouse query costs and identify optimization opportunities. Use when reviewing cloud data warehouse spending, finding expensive queries, or generating cost optimization reports for Snowflake, BigQuery, Databricks, or PostgreSQL.
---

# Cost Report

## Requirements
**Agent:** any (read-only analysis)
**Tools used:** `warehouse_list`, `finops_expensive_queries`, `finops_analyze_credits`, `finops_warehouse_advice`, `finops_unused_resources`, `sql_analyze`, `sql_predict_cost`, `sql_record_feedback`, `sql_execute`

Generate a cost analysis report for any connected data warehouse. Identifies expensive queries, detects anti-patterns, and recommends optimizations.

## Workflow

1. **Detect warehouse** — Call `warehouse_list` to discover connected warehouses. Identify the warehouse type (Snowflake, BigQuery, Databricks, PostgreSQL). If multiple connections exist, ask the user which to analyze.

2. **Gather cost data** — Branch by warehouse type:

   **Snowflake** — Use the built-in FinOps tools (no raw SQL needed):
   - `finops_expensive_queries` with `days` and `limit` parameters → returns top expensive queries
   - `finops_analyze_credits` with `days` parameter → returns daily credit breakdown by warehouse, total credits, and recommendations
   - `finops_warehouse_advice` → returns warehouse sizing and load analysis
   - `finops_unused_resources` → returns stale tables and idle warehouses

   **BigQuery, Databricks, PostgreSQL** — Load the appropriate reference file for warehouse-specific queries:
   - Read [references/bigquery-cost-queries.md](references/bigquery-cost-queries.md) for BigQuery
   - Read [references/databricks-cost-queries.md](references/databricks-cost-queries.md) for Databricks
   - Read [references/postgres-cost-queries.md](references/postgres-cost-queries.md) for PostgreSQL

   Run the queries from the reference file using `sql_execute`.

3. **Analyze top offenders** — For the top 10 most expensive queries from step 2:
   - Run `sql_analyze` on each query's SQL text (pass the correct `dialect`) to detect anti-patterns
   - Run `sql_predict_cost` to get cost tier predictions based on historical feedback

4. **Record feedback** — For each analyzed query, call `sql_record_feedback` with execution metrics (`bytes_scanned`, `execution_time_ms`, `credits_used`, `warehouse_size`) to improve future predictions.

5. **Output the report** in this standardized format (regardless of warehouse type):

   ```
   # Cost Report — {Warehouse Type} (Last {N} Days)

   ## Summary
   - Total cost: {credits or dollars}
   - Queries analyzed: {count}
   - Most expensive query: {cost}
   - Anti-patterns found: {count}

   ## Cost by Dimension
   | {User/Principal} | Total Cost | Query Count | Avg Cost/Query |
   |------------------|-----------|-------------|----------------|

   | {Warehouse/Project/Cluster} | Total Cost | Query Count | Avg Cost/Query |
   |-----------------------------|-----------|-------------|----------------|

   ## Top 10 Expensive Queries

   ### Query 1 — {cost} — {TIER}
   **User:** {name} | **Warehouse:** {name} | **Type:** {SELECT/INSERT/...}
   **Anti-patterns found:**
   - {pattern}: {description}
   **Optimization suggestions:**
   1. {suggestion}
   **Cost prediction:** {tier} ({confidence})

   ...

   ## Recommendations
   1. {Top priority optimizations}
   2. {Warehouse/cluster sizing suggestions}
   3. {Unused resource cleanup opportunities}
   ```

### Cost Tiers

| Tier | Cost | Label | Action |
|------|------|-------|--------|
| 1 | Minimal | Cheap | No action needed |
| 2 | Low–moderate | Moderate | Review if frequent |
| 3 | High | Expensive | Optimize or review sizing |
| 4 | Very high | Dangerous | Immediate review required |

Tier thresholds vary by warehouse — Snowflake measures credits, BigQuery measures bytes billed, Databricks measures DBUs, PostgreSQL measures execution time.

## Usage

- `/cost-report` — Analyze the last 30 days on the default warehouse
- `/cost-report 7` — Analyze the last 7 days
- `/cost-report my_warehouse 14` — Analyze a specific connection for 14 days

Use the tools: `warehouse_list`, `finops_expensive_queries`, `finops_analyze_credits`, `finops_warehouse_advice`, `finops_unused_resources`, `sql_analyze`, `sql_predict_cost`, `sql_record_feedback`, `sql_execute`.
