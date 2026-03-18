---
name: sql-review
description: Pre-merge SQL quality gate — lint 26 anti-patterns, grade readability/performance A-F, validate syntax, and scan for injection threats. Use before committing or reviewing SQL changes.
---

# SQL Review

## Requirements
**Agent:** any (read-only analysis)
**Tools used:** altimate_core_check, altimate_core_grade, sql_analyze, read, glob, bash (for git operations)

## When to Use This Skill

**Use when the user wants to:**
- Review SQL quality before merging a PR
- Get a quality grade (A-F) on a query or model
- Run a comprehensive lint + safety + syntax check in one pass
- Audit SQL files in a directory for anti-patterns

**Do NOT use for:**
- Optimizing query performance -> use `query-optimize`
- Fixing broken SQL -> use `dbt-troubleshoot`
- Translating between dialects -> use `sql-translate`

## Workflow

### 1. Collect SQL to Review

Either:
- Read SQL from a file path provided by the user
- Accept SQL directly from the conversation
- Auto-detect changed SQL files from git:

```bash
git diff --name-only HEAD~1 | grep '\.sql$'
```

For dbt models, compile first to get the full SQL:
```bash
altimate-dbt compile --model <name>
```

### 2. Run Comprehensive Check

Call `altimate_core_check` — this is the single-call code review that composes:
- **Syntax validation**: Parse errors with line/column positions
- **Lint (26 anti-patterns)**: SELECT *, unused CTEs, implicit casts, NULL comparisons, missing WHERE on DELETE/UPDATE, cartesian joins, non-sargable predicates, missing partition filters, and more
- **Injection scan**: Tautology attacks, UNION injection, stacked queries, comment injection, Jinja template injection
- **PII exposure**: Flags queries accessing columns classified as PII

```
altimate_core_check(sql: <sql>, schema_context: <schema_object>)
```

### 3. Grade the SQL

Call `altimate_core_grade` to get an A-F quality score with per-category breakdown:

```
altimate_core_grade(sql: <sql>, schema_context: <schema_object>)
```

Categories scored:
- **Readability**: Naming, formatting, CTE structure
- **Performance**: Anti-patterns, index usage, scan efficiency
- **Correctness**: NULL handling, join logic, type safety
- **Best Practices**: Explicit columns, proper materialization hints

### 4. Run Anti-Pattern Analysis

Call `sql_analyze` for the detailed anti-pattern breakdown with severity levels and concrete recommendations:

```
sql_analyze(sql: <sql>, dialect: <dialect>)
```

### 5. Present the Review

```
SQL Review: <file_or_query_name>
==============================

Grade: B+ (82/100)
  Readability:  A  (clear CTEs, good naming)
  Performance:  B- (missing partition filter on large table)
  Correctness:  A  (proper NULL handling)
  Best Practices: C (SELECT * in staging model)

Issues Found: 3
  [HIGH]   SELECT_STAR — Use explicit column list for contract stability
  [MEDIUM] MISSING_PARTITION_FILTER — Add date filter to avoid full scan
  [LOW]    IMPLICIT_CAST — VARCHAR compared to INTEGER on line 23

Safety: PASS (no injection vectors detected)
PII: PASS (no PII columns exposed)

Verdict: Fix HIGH issues before merging. MEDIUM issues are recommended.
```

### 6. Batch Mode

When reviewing multiple files (e.g., all changed SQL in a PR):
- Run the check on each file
- Present a summary table:

```
| File | Grade | Issues | Safety | Verdict |
|------|-------|--------|--------|---------|
| stg_orders.sql | A | 0 | PASS | Ship |
| int_revenue.sql | B- | 2 | PASS | Fix HIGH |
| mart_daily.sql | C | 5 | WARN | Block |
```

## Usage

- `/sql-review models/marts/fct_orders.sql` -- Review a specific file
- `/sql-review` -- Review all SQL files changed in the current git diff
- `/sql-review --all models/` -- Review all SQL files in a directory
