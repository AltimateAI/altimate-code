# CI & Headless Mode

Run any altimate prompt non-interactively from scripts, CI pipelines, or scheduled jobs. No TUI. Output is plain text or JSON.

---

## Basic Usage

```bash
altimate run "your prompt here"
```

Key flags:

| Flag | Description |
|---|---|
| `--output json` | Structured JSON output instead of plain text |
| `--model <id>` | Override the configured model |
| `--connection <name>` | Select a specific warehouse connection |
| `--no-color` | Disable ANSI color codes (for CI logs) |

See `altimate run --help` for the full flag list, or [CLI Reference](cli.md).

---

## Environment Variables for CI

Configure without committing an `altimate-code.json` file:

```bash
# LLM provider
ALTIMATE_PROVIDER=anthropic
ALTIMATE_ANTHROPIC_API_KEY=your-key-here

# Or OpenAI
ALTIMATE_PROVIDER=openai
ALTIMATE_OPENAI_API_KEY=your-key-here

# Warehouse (Snowflake example)
SNOWFLAKE_ACCOUNT=myorg-myaccount
SNOWFLAKE_USER=ci_user
SNOWFLAKE_PASSWORD=${{ secrets.SNOWFLAKE_PASSWORD }}
SNOWFLAKE_DATABASE=analytics
SNOWFLAKE_SCHEMA=public
SNOWFLAKE_WAREHOUSE=compute_wh
```

---

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success (task completed) |
| `1` | Task completed but result indicates issues (e.g., anti-patterns found) |
| `2` | Configuration error (missing API key, bad connection) |
| `3` | Tool execution error (warehouse unreachable, query failed) |

Use exit codes to fail CI on actionable findings:

```bash
altimate run "validate models in models/staging/ for anti-patterns" || exit 1
```

---

## Worked Examples

### Example 1: Nightly Cost Check (GitHub Actions)

```yaml
# .github/workflows/cost-check.yml
name: Nightly Cost Check

on:
  schedule:
    - cron: '0 8 * * 1-5'  # 8am UTC, weekdays

jobs:
  cost-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install altimate
        run: npm install -g altimate-code

      - name: Run cost report
        env:
          ALTIMATE_PROVIDER: anthropic
          ALTIMATE_ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          SNOWFLAKE_ACCOUNT: ${{ secrets.SNOWFLAKE_ACCOUNT }}
          SNOWFLAKE_USER: ${{ secrets.SNOWFLAKE_CI_USER }}
          SNOWFLAKE_PASSWORD: ${{ secrets.SNOWFLAKE_CI_PASSWORD }}
          SNOWFLAKE_DATABASE: analytics
          SNOWFLAKE_WAREHOUSE: compute_wh
        run: |
          altimate run "/cost-report" --output json > cost-report.json
          cat cost-report.json

      - name: Upload cost report
        uses: actions/upload-artifact@v4
        with:
          name: cost-report
          path: cost-report.json
```

### Example 2: Post-Deploy SQL Validation

Add to your dbt deployment workflow to catch anti-patterns before they reach production:

```yaml
      - name: SQL anti-pattern check
        env:
          ALTIMATE_PROVIDER: anthropic
          ALTIMATE_ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          altimate run "validate all SQL files in models/staging/ for anti-patterns and fail if any are found" \
            --no-color \
            --output json
```

### Example 3: Automated Test Generation (Pre-commit)

```bash
#!/bin/bash
# .git/hooks/pre-commit
# Generate tests for any staged SQL model files

STAGED_MODELS=$(git diff --cached --name-only --diff-filter=A | grep "models/.*\.sql")

if [ -n "$STAGED_MODELS" ]; then
  echo "Generating tests for new models..."
  altimate run "/generate-tests for: $STAGED_MODELS" --no-color
fi
```

---

## Tracing in Headless Mode

Tracing works in headless mode. View traces after the run:

```bash
altimate trace list
altimate trace view <trace-id>
```

See [Tracing](../configure/tracing.md) for the full trace reference.

---

## Security Recommendation

Use a **read-only warehouse user** for CI jobs that only need to read data. Reserve write-access credentials for jobs that explicitly need them (e.g., test generation that writes files). See [Security FAQ](../reference/security-faq.md) and [Permissions](../configure/permissions.md).
