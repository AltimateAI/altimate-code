---
name: query-optimize
description: >
  Detect SQL anti-patterns and rewrite queries for better performance across any warehouse.
  Use when the user asks to optimize, tune, speed up, or review a SQL query for performance,
  or mentions slow queries, high cost, full table scans, or query performance issues.
domain: sql-analysis
persona:
  - data-engineer
  - analytics-engineer
  - data-analyst
tools:
  - sql_optimize
  - sql_analyze
  - warehouse_list
  - dbt_profiles
  - schema_inspect
  - read
  - glob
docs:
  - title: "Snowflake Query Performance"
    url: "https://docs.snowflake.com/en/user-guide/performance-query"
    context: "Clustering, pruning, result cache, warehouse sizing for Snowflake optimization"
  - title: "BigQuery Query Optimization"
    url: "https://cloud.google.com/bigquery/docs/best-practices-performance-compute"
    context: "Slot usage, partition pruning, clustering, materialized views for BigQuery"
---

# Query Optimize

## Requirements
**Agent:** any (read-only analysis)
**Tools used:** sql_optimize, sql_analyze, warehouse_list, dbt_profiles, schema_inspect, read, glob

Analyze SQL queries for performance anti-patterns, generate concrete rewrites, and provide warehouse-aware optimization advice.

## Workflow
1. **Detect the database dialect** -- Required: optimization advice is dialect-specific (Snowflake clustering, BigQuery partitioning, Postgres indexing). Pass the dialect to all tool calls.
2. **Get the SQL query** -- Either:
   - Read SQL from a file path provided by the user (use `read`)
   - Accept SQL directly from the conversation
   - Search for SQL files with `glob` if the user references a model by name
3. **Gather schema context** (when a warehouse connection exists):
   - Identify tables referenced in the query
   - Call `schema_inspect` on each table to get column names, types, and clustering/partition keys
   - Schema context enables more precise optimizations (e.g., expanding SELECT *, identifying type mismatches, confirming partition filter usage)
4. **Run the optimizer**:
   - Call `sql_optimize` with the SQL, detected `dialect`, and schema context if available
   - The optimizer produces a rewritten query with applied improvements
5. **Run anti-pattern analysis**:
   - Call `sql_analyze` with the same SQL and `dialect`
   - This returns a detailed breakdown of detected anti-patterns with severity and recommendations
6. **Present findings** in a structured report:

```
Query Optimization Report
=========================
Warehouse: <detected dialect>

Summary: X optimizations applied, Y anti-patterns detected

High Impact:
  1. [REWRITE] Replace SELECT * with explicit columns
     Before: SELECT *
     After:  SELECT id, name, email

  2. [REWRITE] Use UNION ALL instead of UNION (no duplicates to remove)
     Before: ... UNION ...
     After:  ... UNION ALL ...

Medium Impact:
  3. [PERFORMANCE] Add LIMIT to unbounded ORDER BY
     ...

Low Impact:
  4. [STYLE] Use explicit column list in GROUP BY
     ...

Optimized SQL:
--------------
SELECT id, name, email
FROM users
WHERE status = 'active'
ORDER BY name
LIMIT 100

Anti-Pattern Details:
---------------------
  [WARNING] SELECT_STAR: Query uses SELECT * ...
    -> Select only the columns you need to reduce I/O and improve cache efficiency.
```
7. **Add warehouse-specific guidance** based on the detected dialect:
   - **Snowflake**: Mention clustering keys, result cache behavior, warehouse sizing if spilling is likely
   - **BigQuery**: Mention partition pruning, clustering column order, slot utilization
   - **Databricks**: Mention Z-ordering, liquid clustering, broadcast join thresholds
   - **Postgres**: Mention index usage, EXPLAIN ANALYZE recommendations, vacuum/analyze
   - **Redshift**: Mention distribution keys, sort keys, late-binding views
8. **If schema context was used**, note which optimizations were informed by real table metadata (e.g., "Expanded SELECT * using 12 columns from the `orders` table schema").
9. **If no issues are found**, confirm the query is well-optimized and briefly explain why (no anti-patterns, proper use of limits, explicit columns, appropriate join strategy).

## Common Anti-Patterns (Cross-Warehouse)

These apply regardless of dialect:
- **SELECT ***: Reads all columns, wastes I/O, breaks downstream consumers when schema changes
- **UNION instead of UNION ALL**: Triggers a full dedup sort even when results are already distinct
- **Missing LIMIT on ORDER BY**: Sorts entire result set without bounds
- **Cartesian joins**: Missing or incorrect join conditions causing row explosion
- **Correlated subqueries**: Re-execute per row; rewrite as JOIN or window function
- **Functions on filtered columns**: Wrapping a column in a function (e.g., `UPPER(name) = 'FOO'`) prevents predicate pushdown and partition/index pruning
- **Implicit type conversions**: Comparing mismatched types forces casting at scan time
- **OR in WHERE on different columns**: Often prevents efficient index/partition usage; consider UNION ALL of separate filtered queries

## Usage

- `/query-optimize SELECT * FROM users ORDER BY name` -- Optimize inline SQL
- `/query-optimize models/staging/stg_orders.sql` -- Optimize SQL from a file
- `/query-optimize` -- Optimize the most recently discussed SQL in the conversation
