---
name: debug-query
description: >
  Diagnose and fix failing, slow, or messy SQL queries using explain plans, anti-pattern detection,
  formatting, and automated fixes. Use when the user has a broken query, a syntax error, a slow query,
  or wants help understanding why a query fails or performs poorly.
domain: sql-analysis
tools:
  - sql_explain
  - sql_fix
  - sql_format
  - sql_analyze
  - sql_execute
  - sql_validate
  - warehouse_list
  - dbt_profiles
  - read
  - glob
docs:
  - title: "Reading Query Explain Plans"
    url: "https://docs.snowflake.com/en/user-guide/ui-query-profile"
    context: "Snowflake query profile interpretation, operator nodes, spilling"
---

# Debug Query

## Requirements
**Agent:** any (read-only analysis; optional execute for testing)
**Tools used:** sql_validate, sql_fix, sql_explain, sql_analyze, sql_format, sql_execute, warehouse_list, dbt_profiles, read, glob

Diagnose and fix SQL queries that fail, run slowly, or produce unexpected results. Combines syntax validation, explain plan analysis, anti-pattern detection, and automated rewrites into a single diagnostic workflow.

## Workflow
1. **Detect the database dialect** -- Required: the dialect (e.g., `snowflake`, `bigquery`, `postgres`, `databricks`) determines how to parse, explain, and fix the SQL. Pass it to all subsequent tool calls.
2. **Get the problematic SQL** -- This skill works with any SQL, not just dbt models:
   - **Raw SQL**: Accept SQL pasted directly in the conversation or from any `.sql` file
   - **dbt model**: If the user references a dbt model name, search with `glob` for `**/models/**/{name}.sql` and read the file
   - **File path**: Read SQL from a file path provided by the user (use `read`)
   - **Non-SQL files**: If the user points to a stored procedure, view definition, or migration file, extract the SQL portion
   - If the user mentions a recent error, ask for the full error message
3. **Validate syntax** -- Call `sql_validate` with the SQL and detected `dialect`
   - If valid: proceed to performance analysis (step 5)
   - If invalid: the error message identifies the problem location
4. **Fix syntax errors** -- When validation fails:
   - Call `sql_fix` with the SQL, error message, and `dialect`
   - The tool returns a corrected query and explanation of what was wrong
   - Show a before/after diff of the fix
   - Re-validate the fixed query with `sql_validate` to confirm the fix
5. **Analyze performance** -- For queries that parse correctly but run slowly:
   - Call `sql_explain` with the SQL and `dialect` to get the explain plan
   - Look for: full table scans, missing partition pruning, spilling to disk, skewed joins, high row estimates
   - Call `sql_analyze` with the SQL and `dialect` to detect anti-patterns
   - Cross-reference explain plan bottlenecks with anti-pattern findings
6. **Format the cleaned SQL** -- Call `sql_format` with the final (fixed or original) SQL and `dialect` to produce clean, readable output
7. **Test the fix** (optional, only if the user requests it):
   - Call `sql_execute` with a `LIMIT 100` wrapper to verify the query runs
   - Confirm the output schema and sample rows look correct
8. **Generate the diagnostic report**:

```
Query Diagnostic Report
=======================
Warehouse: <detected dialect>
Status: <SYNTAX_ERROR | SLOW_QUERY | CLEAN>

## Error Diagnosis (if syntax error)
Error: <original error message>
Root Cause: <what was wrong and why>
Fix Applied: <description of the correction>

## Performance Analysis (if slow query)
Explain Plan Summary:
  - Scan type: <full table scan / partition pruned / index seek>
  - Estimated rows: <N>
  - Spilling: <yes/no>
  - Bottleneck: <specific operator or join>

Anti-Patterns Found:
  1. [SEVERITY] PATTERN_NAME: <description>
     Recommendation: <specific fix>
  2. ...

## Formatted SQL
<clean, formatted version of the final query>

## Next Steps
- <actionable recommendation 1>
- <actionable recommendation 2>
```

## Common Diagnostic Patterns

| Symptom | Likely Cause | Tool to Use |
|---------|-------------|-------------|
| "syntax error at line N" | Typo, missing comma, wrong keyword | `sql_validate` + `sql_fix` |
| Query runs but takes minutes | Full table scan, missing filters | `sql_explain` + `sql_analyze` |
| "ambiguous column" error | Missing table alias | `sql_fix` with error message |
| Unexpected empty results | Wrong join type or filter logic | `sql_explain` to check row counts |
| Out of memory / spilling | Cartesian join or unbounded sort | `sql_explain` + `sql_analyze` |

## Usage

- `/debug-query SELECT * FROM users WHER active = true` -- Fix a broken query (raw SQL)
- `/debug-query models/staging/stg_orders.sql` -- Debug a slow dbt model
- `/debug-query scripts/etl/daily_load.sql` -- Debug a standalone SQL script
- `/debug-query` -- Debug the most recently discussed query in the conversation

Use the tools: `sql_validate`, `sql_fix`, `sql_explain`, `sql_analyze`, `sql_format`, `sql_execute`, `warehouse_list`, `dbt_profiles`, `read`, `glob`.
