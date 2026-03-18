---
name: dbt-troubleshoot
description: Debug dbt errors — compilation failures, runtime database errors, test failures, wrong data, and performance issues. Use when something is broken, producing wrong results, or failing to build. Powered by altimate-dbt.
---

# dbt Troubleshooting

## Requirements
**Agent:** any (read-only diagnosis), builder (if applying fixes)
**Tools used:** bash (runs `altimate-dbt` commands), read, glob, edit, altimate_core_semantics, altimate_core_column_lineage, altimate_core_correct, altimate_core_fix, sql_fix

## When to Use This Skill

**Use when:**
- A dbt model fails to compile or build
- Tests are failing
- Model produces wrong or unexpected data
- Builds are slow or timing out
- User shares an error message from dbt

**Do NOT use for:**
- Creating new models → use `dbt-develop`
- Adding tests → use `dbt-test`
- Analyzing change impact → use `dbt-analyze`

## Iron Rules

1. **Never modify a test to make it pass without understanding why it's failing.**
2. **Fix ALL errors, not just the reported one.** After fixing the specific issue, run a full `dbt build`. If other models fail — even ones not mentioned in the error report — fix them too. Your job is to leave the project in a fully working state. Never dismiss errors as "pre-existing" or "out of scope".

## Diagnostic Workflow

### Step 1: Health Check

```bash
altimate-dbt doctor
altimate-dbt info
```

If `doctor` fails, fix the environment first. Common issues:
- Python not found → reinstall or set `--python-path`
- dbt-core not installed → `pip install dbt-core`
- No `dbt_project.yml` → wrong directory
- Missing packages → if `packages.yml` exists but `dbt_packages/` doesn't, run `dbt deps`

### Step 2: Classify the Error

| Error Type | Symptom | Jump To |
|-----------|---------|---------|
| Compilation Error | Jinja/YAML parse failure | [references/compilation-errors.md](references/compilation-errors.md) |
| Runtime/Database Error | SQL execution failure | [references/runtime-errors.md](references/runtime-errors.md) |
| Test Failure | Tests return failing rows | [references/test-failures.md](references/test-failures.md) |
| Wrong Data | Model builds but data is incorrect | Step 3 below |

### Step 3: Isolate the Problem

```bash
# Compile only — catches Jinja errors without hitting the database
altimate-dbt compile --model <name>

# If compile succeeds, try building
altimate-dbt build --model <name>

# Probe the data directly
altimate-dbt execute --query "SELECT count(*) FROM {{ ref('<name>') }}" --limit 1
altimate-dbt execute --query "SELECT * FROM {{ ref('<name>') }}" --limit 5
```

### Step 3b: Offline SQL Analysis

Before hitting the database, analyze the compiled SQL offline:

```bash
# Check for semantic issues (wrong joins, cartesian products, NULL comparisons)
altimate_core_semantics --sql <compiled_sql>

# Trace column lineage to find where wrong data originates
altimate_core_column_lineage --sql <compiled_sql>

# Auto-suggest fixes for SQL errors
altimate_core_correct --sql <compiled_sql>
```

**Quick-fix tools** — use these when the error type is clear:

```
# Schema-based fix: fuzzy-matches table/column names against schema to fix typos and wrong references
altimate_core_fix(sql: <compiled_sql>, schema_context: <schema_object>)

# Error-message fix: given a failing query + database error, analyzes root cause and proposes corrections
sql_fix(sql: <compiled_sql>, error_message: <error_message>, dialect: <dialect>)
```

`altimate_core_fix` is best for compilation errors (wrong names, missing objects). `sql_fix` is best for runtime errors (the database told you what's wrong). Use `altimate_core_correct` for iterative multi-round correction when the first fix doesn't resolve the issue.


Common findings:
- **Wrong join type**: `INNER JOIN` dropping rows that should appear → switch to `LEFT JOIN`
- **Fan-out**: One-to-many join inflating row counts → add deduplication or aggregate
- **Column mismatch**: Output columns don't match schema.yml definition → reorder SELECT
- **NULL comparison**: Using `= NULL` instead of `IS NULL` → silent data loss

### Step 3c: Wrong Data Diagnosis — Deep Data Exploration

When a model builds but produces wrong results, the bug is almost always in the data assumptions, not the SQL syntax. **You must explore the actual data to find it.**

```bash
# 1. Check the output for unexpected NULLs
altimate-dbt execute --query "SELECT count(*) as total, count(<col>) as non_null, count(*) - count(<col>) as nulls FROM {{ ref('<name>') }}" --limit 1

# 2. Check value ranges — are metrics within expected bounds?
altimate-dbt execute --query "SELECT min(<metric>), max(<metric>), avg(<metric>) FROM {{ ref('<name>') }}" --limit 1

# 3. Check distinct values for key columns — do they look right?
altimate-dbt execute --query "SELECT <col>, count(*) FROM {{ ref('<name>') }} GROUP BY 1 ORDER BY 2 DESC" --limit 20

# 4. Compare row counts between model output and parent tables
altimate-dbt execute --query "SELECT count(*) FROM {{ ref('<parent>') }}" --limit 1
```

**Common wrong-data root causes:**
- **Fan-out from joins**: If row count is higher than expected, a join key isn't unique — check with `SELECT key, count(*) ... GROUP BY 1 HAVING count(*) > 1`
- **Missing rows from INNER JOIN**: If row count is lower than expected, switch to LEFT JOIN and check for NULL join keys
- **Date spine issues**: If using `current_date` or `dbt_utils.date_spine`, output changes daily — check min/max dates

### Step 4: Check Upstream

Most errors cascade from upstream models:

```bash
altimate-dbt parents --model <name>
```

Read the parent models. Build them individually. **Query the parent data** — don't assume it's correct:
```bash
altimate-dbt execute --query "SELECT count(*), count(DISTINCT <pk>) FROM {{ ref('<parent>') }}" --limit 1
altimate-dbt execute --query "SELECT * FROM {{ ref('<parent>') }}" --limit 5
```

### Step 5: Fix and Verify

After applying a fix:

```bash
altimate-dbt build --model <name> --downstream
```

Always build with `--downstream` to catch cascading impacts.

**Then verify the fix with data queries** — don't just trust the build:
```bash
altimate-dbt execute --query "SELECT count(*) FROM {{ ref('<name>') }}" --limit 1
altimate-dbt execute --query "SELECT * FROM {{ ref('<name>') }}" --limit 10
# Check the specific metric/column that was wrong:
altimate-dbt execute --query "SELECT min(<col>), max(<col>), count(*) - count(<col>) as nulls FROM {{ ref('<name>') }}" --limit 1
```

## Rationalizations to Resist

| You're Thinking... | Reality |
|--------------------|---------|
| "Just make the test pass" | The test is telling you something. Investigate first. |
| "Let me delete this test" | Ask WHY it exists before removing it. |
| "It works on my machine" | Check the adapter, Python version, and profile config. |
| "I'll fix it later" | Later never comes. Fix it now. |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Changing tests before understanding failures | Read the error. Query the data. Understand the root cause. |
| Fixing symptoms instead of root cause | Trace the problem upstream. The bug is often 2 models back. |
| Not checking upstream models | Run `altimate-dbt parents` and build parents individually |
| Ignoring warnings | Warnings often become errors. Fix them proactively. |
| Not running offline SQL analysis | Use `altimate_core_semantics` before building to catch join issues |
| Column names/order don't match schema | Use `altimate_core_column_lineage` to verify output columns match schema.yml |
| Not querying the actual data when debugging wrong results | Always run data exploration queries — check NULLs, value ranges, distinct values |
| Trusting build success as proof of correctness | Build only checks syntax and constraints — wrong values pass silently |

## Reference Guides

| Guide | Use When |
|-------|----------|
| [references/altimate-dbt-commands.md](references/altimate-dbt-commands.md) | Need the full CLI reference |
| [references/compilation-errors.md](references/compilation-errors.md) | Jinja, YAML, or parse errors |
| [references/runtime-errors.md](references/runtime-errors.md) | Database execution errors |
| [references/test-failures.md](references/test-failures.md) | Understanding and fixing test failures |
