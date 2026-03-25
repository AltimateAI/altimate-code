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
| `lint`     | Anti-pattern detection (SELECT *, cartesian JOINs, etc.)     | Optional      | Yes     |
| `validate` | DataFusion SQL validation (column exists, type matches)      | Yes           | No      |
| `safety`   | SQL injection and dangerous pattern detection                | No            | Yes     |
| `policy`   | Custom guardrails (block SELECT *, require LIMIT, etc.)      | Optional      | No      |
| `pii`      | PII column detection and query exposure                      | Optional      | No      |
| `semantic` | Semantic validation (cartesian products, wrong JOINs)        | Optional      | No      |
| `grade`    | SQL quality grading with recommendations                     | Optional      | No      |

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
          "column": 1,
          "rule": "L003",
          "severity": "warning",
          "message": "SELECT * used -- enumerate columns explicitly",
          "suggestion": "Replace SELECT * with explicit column list"
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
  WARNING models/staging/stg_orders.sql:5:1 [L003]: SELECT * used -- enumerate columns explicitly
    suggestion: Replace SELECT * with explicit column list

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
