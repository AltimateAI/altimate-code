---
name: query-optimize
description: Analyze and optimize SQL queries for better performance
---

# Query Optimize

## Requirements
**Agent:** any (read-only analysis)
**Tools used:** altimate_core_rewrite (with `verify_equivalence: true`), sql_analyze, sql_explain, read, glob, schema_inspect, warehouse_list

Analyze SQL queries for performance issues and suggest concrete optimizations including rewritten SQL.

## Workflow

1. **Get the SQL query** -- Either:
   - Read SQL from a file path provided by the user
   - Accept SQL directly from the conversation
   - Read from clipboard or stdin if mentioned

2. **Determine the dialect** -- Default to `snowflake`. If the user specifies a dialect (postgres, bigquery, duckdb, etc.), use that instead. Check the project for warehouse connections using `warehouse_list` if unsure.

3. **Run the verified optimizer**:
   - If the user has a warehouse connection, first call `schema_inspect` on the relevant tables to build schema context (needed both for better rewrites — e.g. SELECT * expansion — and to verify equivalence)
   - Call `altimate_core_rewrite` with the SQL, schema context, and **`verify_equivalence: true`**. This proposes rewrites AND proves each one returns the same results as the original in a single step. The result is partitioned into **verified-equivalent** rewrites (safe to apply) and **unverified** rewrites (review before applying), so you never recommend a rewrite that silently changes semantics.

4. **Run detailed analysis**:
   - Call `sql_analyze` with the same SQL and dialect to get the full anti-pattern breakdown with recommendations

5. **Get execution plan** (if warehouse connected):
   - Call `sql_explain` to run EXPLAIN on the query and get the execution plan
   - Look for: full table scans, sort operations on large datasets, inefficient join strategies, missing partition pruning
   - Include key findings in the report under "Execution Plan Insights"

6. **Equivalence verification is built into step 3** (`verify_equivalence: true`):
   - Present the **verified-equivalent** rewrites as safe to apply.
   - Present **unverified** rewrites separately with their reason ("review before applying") — do not recommend applying these without manual review.
   - If no schema was available, all rewrites come back unverified; say so and recommend supplying a schema (or a warehouse connection) to enable verification.

7. **Present findings** in a structured format:

```
Query Optimization Report
=========================

Summary: X suggestions found, Y anti-patterns detected

High Impact:
  1. [REWRITE] Replace SELECT * with explicit columns
     Before: SELECT *
     After:  SELECT id, name, email

  2. [REWRITE] Use UNION ALL instead of UNION
     Before: ... UNION ...
     After:  ... UNION ALL ...

Medium Impact:
  3. [PERFORMANCE] Add LIMIT to ORDER BY
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
    -> Consider selecting only the columns you need.
```

8. **If schema context is available**, mention that the optimization used real table schemas for more accurate suggestions (e.g., expanding SELECT * to actual columns).

9. **If no issues are found**, confirm the query looks well-optimized and briefly explain why (no anti-patterns, proper use of limits, explicit columns, etc.).

## Usage

The user invokes this skill with SQL or a file path:
- `/query-optimize SELECT * FROM users ORDER BY name` -- Optimize inline SQL
- `/query-optimize models/staging/stg_orders.sql` -- Optimize SQL from a file
- `/query-optimize` -- Optimize the most recently discussed SQL in the conversation

Use the tools: `altimate_core_rewrite` with `verify_equivalence: true` (proposes rewrites AND proves they preserve results in one step), `sql_analyze`, `sql_explain` (execution plans), `read` (for file-based SQL), `glob` (to find SQL files), `schema_inspect` (for schema context), `warehouse_list` (to check connections).
