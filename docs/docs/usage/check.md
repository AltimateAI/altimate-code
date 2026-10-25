---
title: "SQL Check (Headless) — Altimate Code"
description: "Run deterministic SQL checks without an LLM in Altimate Code. CI/CD-ready with exit codes and JSON output."
---

# SQL Check (Headless)

Run deterministic SQL checks without an LLM. Ideal for CI/CD pipelines, pre-commit hooks, and GitHub Actions.

The `check` command analyzes SQL files for anti-patterns, validation errors, safety issues, policy violations, PII exposure, and semantic problems -- all without requiring a model provider or API key.

---

## Quick Start

```bash
# Lint all SQL files in current directory
altimate-code check

# Check specific files
altimate-code check models/staging/stg_orders.sql models/marts/fct_revenue.sql

# Run all checks with JSON output
altimate-code check --checks lint,validate,safety --format json

# Use with a schema for DataFusion validation
altimate-code check --checks validate --schema schema.yml

# Enforce policy guardrails
altimate-code check --checks policy --policy policy.json --fail-on error

# Only show warnings and errors (hide info)
altimate-code check --severity warning

# Exit non-zero on any warning or error
altimate-code check --fail-on warning
```

---

## Available Checks

| Check      | What It Does                                                 | Needs Schema? | Default |
|------------|--------------------------------------------------------------|---------------|---------|
| `lint`     | Anti-pattern detection (SELECT *, cartesian JOINs, etc.) — [rules](#lint-rules) | Optional      | Yes     |
| `validate` | DataFusion SQL validation (column exists, type matches)      | Yes           | No      |
| `safety`   | SQL injection and dangerous pattern detection — [rules](#safety-rules) | No            | Yes     |
| `policy`   | Custom guardrails (block SELECT *, require LIMIT, etc.) — [rules](#policy-rules) | Optional      | No      |
| `pii`      | PII column detection and query exposure                      | Optional      | No      |
| `semantic` | Semantic validation (cartesian products, wrong JOINs)        | Optional      | No      |
| `grade`    | SQL quality grading with recommendations                     | Optional      | No      |

`policy` and `semantic` never report a statement the engine cannot plan as clean. Such statements include table-valued functions (`TABLE(fn())`, Snowflake `LATERAL FLATTEN`, DuckDB `read_csv(...)`). `policy` fails closed: it reports a `policy_not_evaluated` error and treats the statement as blocked. `semantic` reports the skip as a finding: an error when `--schema` is given, and a warning without it, which does not fail a run with `--fail-on error`. Earlier versions rejected these statements as invalid SQL.

Findings usually carry a machine-readable `rule` field (e.g. `unbalanced_quote`, `select_star`) visible in `--format json` output — see the [Finding Object](#finding-object) schema below and the [Rule Catalog](#rule-catalog). `safety` and `policy` findings always include one; `lint` findings also carry the engine's `code` (e.g. `L001`), but may omit both `rule` and `code` if the engine didn't attach them, so switch on presence rather than assuming.

By default, `lint` and `safety` are enabled. Override with `--checks`:

```bash
# Run everything
altimate-code check --checks lint,validate,safety,policy,pii,semantic,grade \
  --schema schema.yml --policy policy.json

# Just lint
altimate-code check --checks lint
```

---

## Options Reference

| Option          | Type     | Default       | Description                                               |
|-----------------|----------|---------------|-----------------------------------------------------------|
| `[files..]`     | string[] | `**/*.sql`    | SQL files or glob patterns to check                       |
| `--format`      | string   | `text`        | Output format: `text` or `json`                           |
| `--checks`      | string   | `lint,safety` | Comma-separated list of checks to run                     |
| `--schema`      | string   | -             | Path to schema file for validation context                |
| `--policy`      | string   | -             | Path to policy JSON file (required for `policy` check)    |
| `--severity`    | string   | `info`        | Minimum severity level to report: `info`, `warning`, `error` |
| `--fail-on`     | string   | `none`        | Exit 1 if findings at this level or above: `none`, `warning`, `error` |

---

## JSON Output Format

When using `--format json`, the command writes structured JSON to stdout (diagnostic messages go to stderr):

```json
{
  "version": 1,
  "files_checked": 3,
  "checks_run": ["lint", "safety"],
  "schema_resolved": false,
  "results": {
    "lint": {
      "findings": [
        {
          "file": "models/staging/stg_orders.sql",
          "line": 5,
          "code": "L001",
          "rule": "select_star",
          "severity": "warning",
          "message": "SELECT * is used — consider listing columns explicitly",
          "suggestion": "Replace * with specific column names for clarity and performance"
        }
      ],
      "error_count": 0,
      "warning_count": 1
    },
    "safety": {
      "findings": [],
      "error_count": 0,
      "warning_count": 0
    }
  },
  "summary": {
    "total_findings": 1,
    "errors": 0,
    "warnings": 1,
    "info": 0,
    "pass": true
  }
}
```

### Schema

| Field             | Type                              | Description                                    |
|-------------------|-----------------------------------|------------------------------------------------|
| `version`         | `1`                               | Schema version (always 1)                      |
| `files_checked`   | number                            | Number of SQL files processed                  |
| `checks_run`      | string[]                          | List of check names that were executed         |
| `schema_resolved` | boolean                           | Whether a schema file was loaded               |
| `results`         | Record&lt;string, CategoryResult&gt; | Per-check category results                   |
| `summary.total_findings` | number                     | Total findings across all checks               |
| `summary.errors`  | number                            | Total error-severity findings                  |
| `summary.warnings`| number                            | Total warning-severity findings                |
| `summary.info`    | number                            | Total info-severity findings                   |
| `summary.pass`    | boolean                           | Whether the run passes the `--fail-on` threshold |

### Finding Object

| Field        | Type              | Description                                |
|--------------|-------------------|--------------------------------------------|
| `file`       | string            | Relative path to the SQL file              |
| `line`       | number (optional) | Line number of the finding                 |
| `column`     | number (optional) | Column number of the finding               |
| `code`       | string (optional) | Machine-readable finding code              |
| `rule`       | string (optional) | Rule or check that produced the finding    |
| `severity`   | string            | `"error"`, `"warning"`, or `"info"`        |
| `message`    | string            | Human-readable description of the finding  |
| `suggestion` | string (optional) | Suggested fix for the finding              |

---

## Text Output Format

The default `text` format is designed for human consumption:

```text
Checked 3 file(s) with [lint, safety]

--- LINT ---
  WARNING models/staging/stg_orders.sql:5 [select_star]: SELECT * is used — consider listing columns explicitly
    suggestion: Replace * with specific column names for clarity and performance

1 finding(s): 0 error(s), 1 warning(s), 0 info
PASS
```

The final line is `PASS` or `FAIL` based on the `--fail-on` setting.

---

## Policy File Format

The `--policy` flag accepts a JSON file that defines custom guardrails. Example:

```json
{
  "rules": [
    {
      "name": "no-select-star",
      "description": "SELECT * is not allowed in production models",
      "severity": "error",
      "pattern": "SELECT\\s+\\*"
    },
    {
      "name": "require-limit",
      "description": "All ad-hoc queries must include a LIMIT clause",
      "severity": "warning",
      "pattern_absent": "LIMIT\\s+\\d+"
    },
    {
      "name": "no-drop-table",
      "description": "DROP TABLE is forbidden",
      "severity": "error",
      "pattern": "DROP\\s+TABLE"
    }
  ]
}
```

### Common Policy Scenarios

**Block dangerous operations:**
```json
{
  "rules": [
    { "name": "no-truncate", "severity": "error", "pattern": "TRUNCATE\\s+TABLE" },
    { "name": "no-drop", "severity": "error", "pattern": "DROP\\s+(TABLE|VIEW|SCHEMA)" },
    { "name": "no-delete-all", "severity": "error", "pattern": "DELETE\\s+FROM\\s+\\w+\\s*$" }
  ]
}
```

**Enforce best practices:**
```json
{
  "rules": [
    { "name": "require-where", "severity": "warning", "pattern_absent": "WHERE" },
    { "name": "no-select-star", "severity": "warning", "pattern": "SELECT\\s+\\*" },
    { "name": "require-alias", "severity": "info", "pattern_absent": "\\bAS\\b" }
  ]
}
```

---

## Schema File Format

The `--schema` flag provides table and column metadata for checks that need it (`validate`, `pii`, `semantic`, `grade`). The schema file is typically a YAML file that describes your database structure:

```yaml
tables:
  - name: orders
    schema: staging
    columns:
      - name: order_id
        type: INTEGER
      - name: customer_id
        type: INTEGER
      - name: order_date
        type: DATE
      - name: total_amount
        type: DECIMAL(10,2)
  - name: customers
    schema: staging
    columns:
      - name: customer_id
        type: INTEGER
      - name: email
        type: VARCHAR
        pii: true
      - name: full_name
        type: VARCHAR
        pii: true
```

If you use dbt, you can reference your `schema.yml` files directly.

---

## Severity Levels

Findings have three severity levels:

| Level     | Rank | Meaning                                        |
|-----------|------|------------------------------------------------|
| `error`   | 2    | Must fix -- query will fail or is dangerous    |
| `warning` | 1    | Should fix -- anti-pattern or risk detected    |
| `info`    | 0    | Informational -- style suggestion or note      |

The `--severity` flag controls the minimum level to include in output. The `--fail-on` flag controls the exit code:

```bash
# Show only errors in output, exit 1 if any errors exist
altimate-code check --severity error --fail-on error

# Show everything, but only fail on warnings or errors
altimate-code check --severity info --fail-on warning
```

---

## Rule Catalog

The engine does not publish a rule list. The rules below are the ones `check` actually reported when run against a probe corpus with the `@altimateai/altimate-core` version pinned in `packages/opencode/package.json` (0.9.0 when this list was made). Rules change when the engine is upgraded, and the engine may emit rules not listed here. To see what fires on your SQL, run `--format json` and read each finding's `rule` field (and `code` for lint).

`check` itself adds a `<check>-error` rule (for example `safety-error`) when an engine call throws.

### Safety Rules

`check --checks safety` maps engine severities to `check` severities: `critical` and `high` become `error`, `medium` becomes `warning`, `low` becomes `info`. Safety findings carry no `code`.

| Rule | What it flags | Example | Severity |
|------|---------------|---------|----------|
| `multi_statement` | A semicolon followed by a dangerous statement, or a disallowed statement type (`DROP`, `BEGIN`, `COMMIT`, …) | `SELECT 1; DROP TABLE users` | error |
| `stacked_queries` | More than one statement in a single input | `SELECT 1; SELECT 2` | error |
| `union_injection` | `UNION SELECT`, including comment-obfuscated `UNION/**/SELECT` | `SELECT name FROM users WHERE id = 1 UNION SELECT password FROM admins` | error |
| `tautology_attack` | Always-true predicates: `OR 1=1`, `OR 'a'='a'`, `OR TRUE`, `OR NOT FALSE` | `SELECT * FROM users WHERE name = 'a' OR 1=1` | error |
| `unbalanced_quote` | An unclosed single-quoted string (possible injection breakout) | `SELECT * FROM users WHERE name = 'abc` | error |
| `comment_injection` | A string literal followed by `--`, `#` or `/* */`, or the `';--` truncation pattern | `SELECT * FROM users WHERE name = 'a' -- x` | error |
| `info_schema_probe` | Reads from `information_schema` or Snowflake system functions | `SELECT * FROM information_schema.tables` | error |
| `transaction_escape` | A transaction control statement | `COMMIT; SELECT 1` | error |
| `string_concat_predicate` | `CONCAT()`, `||` or `+` string concatenation in a `WHERE` clause | `SELECT * FROM users WHERE name = CONCAT('a', 'b')` | warning |
| `sleep_attack` | Time-based blind injection (`SLEEP(...)`) | `SELECT * FROM users WHERE id = 1 AND SLEEP(5)` | error |
| `encoding_bypass` | `CHAR()` encoding, URL-encoded payloads, Jinja statement tags in SQL, hex literals | `SELECT * FROM users WHERE name = CHAR(97,100,109,105,110)` | error (hex literal `0x…`: warning) |

### Lint Rules

Lint findings carry both a `code` and a `rule`. Almost every `SELECT` without a `LIMIT` also reports `L030`, so the examples below list only the rule they demonstrate.

| Code | Rule | What it flags | Example | Severity |
|------|------|---------------|---------|----------|
| `L001` | `select_star` | `SELECT *` | `SELECT * FROM orders` | warning |
| `L002` | `missing_where_update` | `UPDATE` without `WHERE` | `UPDATE orders SET status = 'x'` | error |
| `L003` | `missing_where_delete` | `DELETE` without `WHERE` | `DELETE FROM orders` | error |
| `L004` | `cartesian_product` | Several tables in `FROM` with no `WHERE` relating them | `SELECT a.id, b.id FROM a, b` | warning |
| `L005` | `select_distinct_smell` | `SELECT DISTINCT` with joins (may hide a bad join) | `SELECT DISTINCT o.id FROM orders o JOIN customers c ON o.customer_id = c.id` | info |
| `L006` | `order_by_in_subquery` | `ORDER BY` inside a subquery | `SELECT id FROM (SELECT id FROM orders ORDER BY id) t` | warning |
| `L008` | `like_leading_wildcard` | `LIKE` pattern starting with `%` | `SELECT id FROM orders WHERE name LIKE '%abc'` | warning |
| `L009` | `not_null_comparison` | `= NULL` or `!= NULL` | `SELECT id FROM orders WHERE status = NULL` | error |
| `L010` | `count_star_vs_column` | `COUNT(column)`, which skips NULLs | `SELECT count(id) FROM orders` | info |
| `L011` | `redundant_distinct_with_group_by` | `DISTINCT` together with `GROUP BY` | `SELECT DISTINCT id FROM orders GROUP BY id` | info |
| `L012` | `missing_table_alias` | Multi-table query without table aliases | `SELECT a.id, b.id FROM a, b` | info |
| `L013` | `correlated_subquery` | Correlated subquery (N+1 pattern) | `SELECT id FROM orders WHERE NOT EXISTS (SELECT 1 FROM x WHERE x.id = orders.id)` | warning |
| `L014` | `non_sargable_predicate` | Column wrapped in a function in a predicate | `SELECT id FROM orders WHERE upper(name) = 'X'` | warning |
| `L015` | `not_in_nullable` | `NOT IN (subquery)`, which returns nothing if the subquery yields a NULL | `SELECT id FROM orders WHERE name NOT IN (SELECT name FROM x)` | error |
| `L016` | `unused_cte` | CTE defined but never referenced | `WITH a AS (SELECT 1 AS x) SELECT 2` | info |
| `L017` | `union_without_all` | `UNION` without `ALL` (forces a dedup sort) | `SELECT id FROM orders UNION SELECT id FROM other` | warning |
| `L018` | `implicit_cross_join` | Comma-separated tables in `FROM` | `SELECT a.id, b.id FROM a, b` | warning |
| `L019` | `select_star_in_subquery` | `SELECT *` inside a subquery | `SELECT id FROM orders o WHERE EXISTS (SELECT * FROM x)` | warning |
| `L020` | `or_in_join` | `OR` in a `JOIN ... ON` condition | `SELECT o.id FROM orders o JOIN customers c ON o.customer_id = c.id OR o.id = c.id` | warning |
| `L021` | `order_by_without_limit_subquery` | `ORDER BY` in a subquery that has no `LIMIT` | `SELECT id FROM (SELECT id FROM orders ORDER BY id) t` | warning |
| `L022` | `large_in_list` | `IN` list with more than 100 values | `SELECT id FROM orders WHERE id IN (1, 2, …, 101)` | warning |
| `L024` | `non_equi_join` | Join on a non-equality condition | `SELECT o.id FROM orders o JOIN customers c ON o.customer_id > c.id` | warning |
| `L025` | `window_without_partition` | `ROW_NUMBER()` and similar window functions without `PARTITION BY` | `SELECT row_number() OVER () FROM t` | info |
| `L027` | `function-on-filter-column` | Function applied to a column in `WHERE` | `SELECT id FROM orders WHERE upper(name) = 'X'` | warning |
| `L028` | `function-on-join-column` | Function applied to a column in a join condition | `SELECT o.id FROM orders o JOIN customers c ON upper(o.name) = c.name` | warning |
| `L029` | `aggregation-before-join` | Aggregation in a subquery that is then joined | `SELECT o.id FROM orders o JOIN (SELECT customer_id, sum(amount) s FROM orders GROUP BY customer_id) a ON a.customer_id = o.customer_id` | error |
| `L030` | `select-without-limit` | `SELECT` without `LIMIT` | `SELECT id FROM orders` | warning |
| `L031` | `create-or-replace-table` | `CREATE OR REPLACE TABLE` (drops and recreates) | `CREATE OR REPLACE TABLE x AS SELECT id FROM orders` | info |
| `L032` | `division_by_column_no_guard` | Division by a column with no zero guard | `SELECT amount / qty FROM orders` | warning |
| `L033` | `non_portable_function` | Dialect-specific function (`NVL`, `IFF`, …) | `SELECT nvl(a, 0) FROM t` | info |
| `L035` | `non_portable_type` | Dialect-specific type (`VARIANT`, …) | `SELECT id::VARIANT FROM orders` | info |
| `L038` | `timezone_in_hash_key` | Row-key hash over a timezone-dependent value | `SELECT md5(convert_timezone('UTC', created_at)::varchar) FROM orders` | warning |
| `L040` | `monetary_float_cast` | Money-like column cast to `FLOAT`/`DOUBLE`/`REAL` | `SELECT CAST(amount AS FLOAT) FROM orders` | warning |
| `L042` | `case_sensitive_like` | `LIKE`, which is case-sensitive on most warehouses | `SELECT id FROM orders WHERE name LIKE 'abc%'` | info |
| `L043` | `outer_join_filter_in_where` | `WHERE` predicate on the outer side of a `LEFT`/`RIGHT` join (turns it into an inner join) | `SELECT o.id FROM orders o LEFT JOIN customers c ON o.cid = c.id WHERE c.name = 'x'` | warning |
| `L044` | `null_propagating_concat` | `||` concatenation, which is NULL if any operand is NULL | `SELECT a || b FROM t` | warning |
| `L045` | `greatest_least_null` | `GREATEST`/`LEAST` over nullable columns | `SELECT greatest(qty, price) FROM orders` | warning |
| `L046` | `distinct_with_window` | `SELECT DISTINCT` together with a window function | `SELECT DISTINCT id, row_number() OVER (PARTITION BY id ORDER BY id) FROM orders` | warning |
| `L048` | `cast_division_to_int` | Division result cast to an integer (truncates) | `SELECT CAST(qty / price AS INTEGER) FROM orders` | warning |
| `L049` | `clock_in_filter` | `current_date`/`now()` in a `WHERE` or join predicate | `SELECT id FROM orders WHERE created_at > current_date` | warning |
| `L051` | `full_outer_join` | `FULL OUTER JOIN` | `SELECT id FROM orders FULL OUTER JOIN x ON orders.id = x.id` | info |
| `L052` | `join_without_condition` | Join with no real condition (`ON 1=1`, `ON true`, no `ON`) | `SELECT id FROM orders o JOIN customers c ON 1=1` | warning |
| `L053` | `null_in_in_list` | `NULL` inside an `IN (...)` list | `SELECT id FROM orders WHERE id IN (1, NULL)` | warning |
| `L054` | `sum_of_ratio` | `SUM()` of a per-row ratio | `SELECT sum(amount / qty) FROM orders` | warning |

### Policy Rules

Policy findings are named after the built-in check that fired. Each check is switched on by a key in the `--policy` JSON file. In this engine version the `rules` / `pattern` entries shown under [Policy File Format](#policy-file-format) produced no findings in testing; use the keys below.

Except `allowed_statements` and `blocked_tables`, these checks run only when `--schema` resolves the query's tables. Otherwise `check` reports `validation_failed`, and `blocked_columns` reports nothing. The examples were checked with a JSON schema file such as `{"tables": {"customers": {"columns": [{"name": "email", "type": "VARCHAR"}]}}}`.

| Rule | Enabled by | Example | Severity |
|------|------------|---------|----------|
| `max_joins` | `{"cost_control": {"max_joins": 1}}` | A query with two joins | error |
| `max_tables` | `{"cost_control": {"max_tables": 1}}` | `SELECT o.id FROM orders o JOIN customers c ON o.customer_id = c.id` | error |
| `block_select_star` | `{"cost_control": {"block_select_star": true}}` | `SELECT * FROM orders` | error |
| `require_limit` | `{"cost_control": {"require_limit": true}}` | `SELECT id FROM orders` | error |
| `max_complexity_score` | `{"cost_control": {"max_complexity_score": 5}}` | A join plus an `IN` subquery and `GROUP BY` (score 9) | error |
| `blocked_columns` | `{"data_protection": {"blocked_columns": [{"table": "customers", "columns": ["email"]}]}}` | `SELECT email FROM customers` | error |
| `blocked_tables` | `{"data_protection": {"blocked_tables": [{"table": "customers"}]}}` | `SELECT id FROM customers` | error |
| `require_where_clause` | `{"data_protection": {"require_where_clause": true}}` | `DELETE FROM orders` | error |
| `allowed_statements` | `{"query_patterns": {"allowed_statements": ["SELECT"]}}` | `DROP TABLE orders` | error |
| `validation_failed` | Any policy (even `{}`), when the query does not validate against `--schema` or no `--schema` is given | `SELECT * FROM orders` with no schema | error |
| `policy_not_evaluated` | Any policy, on statements the engine cannot plan (see [Available Checks](#available-checks)) | `SELECT * FROM TABLE(my_fn())` | error |

---

## CI/CD Integration

### GitHub Actions

```yaml
name: SQL Check
on: [pull_request]

jobs:
  sql-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install altimate-code
        run: npm install -g altimate-code

      - name: Lint and safety check
        run: altimate-code check --checks lint,safety --format json --fail-on error

      - name: Policy check
        run: altimate-code check --checks policy --policy .sql-policy.json --fail-on error
```

### GitHub Actions with JSON parsing

```yaml
      - name: SQL Check
        id: sql-check
        run: |
          altimate-code check --format json --fail-on warning > check-results.json 2>/dev/null || true
          echo "findings=$(jq '.summary.total_findings' check-results.json)" >> $GITHUB_OUTPUT
          echo "pass=$(jq '.summary.pass' check-results.json)" >> $GITHUB_OUTPUT

      - name: Comment on PR
        if: steps.sql-check.outputs.pass == 'false'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const results = JSON.parse(fs.readFileSync('check-results.json', 'utf8'));
            const body = `## SQL Check Failed\n\n${results.summary.errors} errors, ${results.summary.warnings} warnings`;
            github.rest.issues.createComment({ ...context.repo, issue_number: context.issue.number, body });
```

### Pre-commit Hook

Add to `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: local
    hooks:
      - id: altimate-sql-check
        name: SQL Check
        entry: altimate-code check --fail-on warning
        language: system
        types: [sql]
        pass_filenames: true
```

Or add a simple git hook in `.git/hooks/pre-commit`:

```bash
#!/usr/bin/env bash
set -e

# Find staged SQL files
SQL_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep '\.sql$' || true)
if [ -n "$SQL_FILES" ]; then
  altimate-code check $SQL_FILES --fail-on warning
fi
```

### GitLab CI

```yaml
sql-check:
  stage: test
  script:
    - npm install -g altimate-code
    - altimate-code check --checks lint,safety --format json --fail-on error
  rules:
    - changes:
        - "**/*.sql"
```

---

## Examples

### 1. Basic lint of all SQL files

```bash
altimate-code check
```

Searches for `**/*.sql` in the current directory and runs `lint` + `safety` checks.

### 2. Check specific models before deploying

```bash
altimate-code check models/marts/*.sql --checks lint,validate,semantic \
  --schema models/schema.yml --fail-on warning
```

### 3. PII audit across the entire project

```bash
altimate-code check --checks pii --schema schema.yml --format json > pii-report.json
```

### 4. Grade SQL quality and get improvement suggestions

```bash
altimate-code check --checks grade --schema schema.yml
```

### 5. Full check suite in CI

```bash
altimate-code check \
  --checks lint,validate,safety,policy,pii,semantic \
  --schema schema.yml \
  --policy .sql-policy.json \
  --format json \
  --fail-on error
```

### 6. Check only changed files in a PR

```bash
# Get changed SQL files from git
CHANGED=$(git diff --name-only origin/main...HEAD -- '*.sql')
if [ -n "$CHANGED" ]; then
  altimate-code check $CHANGED --fail-on warning
fi
```

### 7. Use glob patterns

```bash
# Check all staging models
altimate-code check "models/staging/**/*.sql"

# Check multiple directories
altimate-code check "models/staging/*.sql" "models/marts/*.sql"
```

---

## Exit Codes

| Code | Meaning                                                         |
|------|-----------------------------------------------------------------|
| `0`  | All checks passed (or no findings above `--fail-on` threshold)  |
| `1`  | Findings found above `--fail-on` threshold                      |

When `--fail-on` is `none` (the default), the command always exits `0` regardless of findings.

---

## How It Works

The `check` command does not use an LLM. It calls deterministic analysis routines through the `altimate_core` engine:

1. **File resolution** -- resolves file paths and glob patterns, filters to `.sql` files
2. **Batch processing** -- processes files in batches of 10 for performance
3. **Check execution** -- runs each enabled check against each file via the Dispatcher
4. **Severity filtering** -- filters results by the `--severity` threshold
5. **Output formatting** -- formats results as text (stderr) or JSON (stdout)
6. **Exit code** -- returns non-zero if findings exceed the `--fail-on` threshold
