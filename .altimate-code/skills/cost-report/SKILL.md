---
name: cost-report
description: Analyze Snowflake query costs and identify optimization opportunities
---

# Cost Report

## Requirements
**Agent:** any (read-only analysis)
**Tools used:** sql_execute, sql_analyze, sql_predict_cost, sql_record_feedback

Analyze Snowflake warehouse query costs, identify the most expensive queries, detect anti-patterns, and recommend optimizations.

## Workflow

1. **Query SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY** for the top 20 most expensive queries by credits used:

   ```sql
   SELECT
       query_id,
       query_text,
       user_name,
       warehouse_name,
       query_type,
       credits_used_cloud_services,
       bytes_scanned,
       rows_produced,
       total_elapsed_time,
       execution_status,
       start_time
   FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
   WHERE start_time >= DATEADD('day', -30, CURRENT_TIMESTAMP())
     AND execution_status = 'SUCCESS'
     AND credits_used_cloud_services > 0
   ORDER BY credits_used_cloud_services DESC
   LIMIT 20;
   ```

   Use `sql_execute` to run this query against the connected Snowflake warehouse.

2. **Group and summarize** the results by:
   - **User**: Which users are driving the most cost?
   - **Warehouse**: Which warehouses consume the most credits?
   - **Query type**: SELECT vs INSERT vs CREATE TABLE AS SELECT vs MERGE, etc.

   Present each grouping as a markdown table.

3. **Analyze the top offenders** - For each of the top 10 most expensive queries:
   - Run `sql_analyze` on the query text to detect anti-patterns (SELECT *, missing LIMIT, cartesian products, correlated subqueries, etc.)
   - Run `sql_predict_cost` to get the cost tier prediction based on historical feedback data
   - Summarize anti-patterns found and their severity

4. **Classify each query into a cost tier**:

   | Tier | Credits | Label | Action |
   |------|---------|-------|--------|
   | 1 | < $0.01 | Cheap | No action needed |
   | 2 | $0.01 - $1.00 | Moderate | Review if frequent |
   | 3 | $1.00 - $100.00 | Expensive | Optimize or review warehouse sizing |
   | 4 | > $100.00 | Dangerous | Immediate review required |

5. **Record feedback** - For each query analyzed, call `sql_record_feedback` to store the execution metrics so future predictions improve:
   - Pass `bytes_scanned`, `execution_time_ms`, `credits_used`, and `warehouse_size` from the query history results

6. **Output the final report** as a structured markdown document:

   ```
   # Snowflake Cost Report (Last 30 Days)

   ## Summary
   - Total credits consumed: X
   - Number of unique queries: Y
   - Most expensive query: Z credits

   ## Cost by User
   | User | Total Credits | Query Count | Avg Credits/Query |
   |------|--------------|-------------|-------------------|

   ## Cost by Warehouse
   | Warehouse | Total Credits | Query Count | Avg Credits/Query |
   |-----------|--------------|-------------|-------------------|

   ## Cost by Query Type
   | Query Type | Total Credits | Query Count | Avg Credits/Query |
   |------------|--------------|-------------|-------------------|

   ## Top 10 Expensive Queries (Detailed Analysis)

   ### Query 1 (X credits) - DANGEROUS
   **User:** user_name | **Warehouse:** wh_name | **Type:** SELECT
   **Anti-patterns found:**
   - SELECT_STAR (warning): Query uses SELECT * ...
   - MISSING_LIMIT (info): ...

   **Optimization suggestions:**
   1. Select only needed columns
   2. Add LIMIT clause
   3. Consider partitioning strategy

   **Cost prediction:** Tier 1 (fingerprint match, high confidence)

   ...

   ## Recommendations
   1. Top priority optimizations
   2. Warehouse sizing suggestions
   3. Scheduling recommendations
   ```

## Usage

The user invokes this skill with:
- `/cost-report` -- Analyze the last 30 days
- `/cost-report 7` -- Analyze the last 7 days (adjust the DATEADD interval)

Use the tools: `sql_execute`, `sql_analyze`, `sql_predict_cost`, `sql_record_feedback`.
