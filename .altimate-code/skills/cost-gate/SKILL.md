---
name: cost-gate
description: >
  CI/CD pre-merge cost and quality gate -- scan changed SQL files for anti-patterns, estimate cost
  impact, and produce a pass/fail report. Use when the user wants to check SQL changes before merging,
  run a cost review on a PR, or enforce quality gates on SQL modifications.
domain: finops
tools:
  - ci_cost_gate
  - sql_analyze
  - sql_predict_cost
  - sql_optimize
  - glob
  - read
  - bash
docs:
  - title: "dbt CI/CD Best Practices"
    url: "https://docs.getdbt.com/docs/deploy/continuous-integration"
    context: "Setting up CI jobs, slim CI, state comparison"
---

# Cost Gate

## Requirements
**Agent:** any (read-only analysis)
**Tools used:** ci_cost_gate, sql_analyze, sql_predict_cost, sql_optimize, glob, read, bash

Pre-merge cost and quality gate for SQL changes. Scans modified SQL files against a base branch, detects anti-patterns, estimates cost impact, and produces a pass/fail verdict with optimization suggestions.

## Workflow
1. **Detect changed SQL files** -- Identify what changed since the base branch:
   - Use `bash` to run `git diff --name-only <base>...HEAD -- '*.sql'` to list changed SQL files
   - Default base branch is `main`; the user can specify an alternative with `--base`
   - If the user provides a directory path, scope the diff to that directory
   - If no git context, fall back to `glob` to find SQL files in the specified path
2. **Read each changed file** -- Use `read` to get the current content of each changed SQL file
3. **Analyze anti-patterns** -- For each changed SQL file:
   - Call `sql_analyze` with the file content
   - Record issues by severity: error (blocking), warning (review), info (suggestion)
   - Track which files have the highest issue density
4. **Estimate cost impact** -- For each changed SQL file:
   - Call `sql_predict_cost` to get a cost tier estimate (low / medium / high / very_high)
   - Flag any queries estimated at "high" or "very_high" for mandatory review
5. **Run the cost gate** -- Call `ci_cost_gate` with the list of changed files and their analysis results
   - This produces an overall pass/fail verdict based on configurable thresholds
   - Default: fail on any "error" severity anti-pattern or "very_high" cost estimate
6. **Generate optimization suggestions** -- For each failing query:
   - Call `sql_optimize` to get concrete rewrite suggestions
   - Include before/after snippets in the report
7. **Generate the CI report**:

```
Cost Gate Report
================
Base: <base_branch> | Files scanned: <N> | Verdict: PASS / FAIL

## Summary
| Metric | Count |
|--------|-------|
| Files scanned | N |
| Anti-patterns (error) | N |
| Anti-patterns (warning) | N |
| High-cost queries | N |
| Optimization suggestions | N |

## File Results

### models/marts/fct_orders.sql -- FAIL
Anti-patterns:
  [ERROR] SELECT_STAR: Query uses SELECT * (line 12)
  [WARNING] MISSING_LIMIT: Unbounded ORDER BY (line 18)
Cost estimate: HIGH
Suggested fix:
  - Replace SELECT * with explicit column list
  - Add LIMIT clause or remove ORDER BY

### models/staging/stg_events.sql -- PASS
Anti-patterns: none
Cost estimate: LOW

## Optimization Suggestions

### fct_orders.sql
Before:
  SELECT * FROM orders ORDER BY created_at
After:
  SELECT order_id, status, amount FROM orders ORDER BY created_at LIMIT 1000

## Verdict
FAIL -- 1 file has blocking issues. Fix errors above before merging.
```

## Gate Thresholds

| Severity | Default Action | Override |
|----------|---------------|---------|
| error | Block merge | Cannot override |
| warning | Report only | `--strict` to block |
| info | Report only | Always pass |
| cost: very_high | Block merge | `--allow-high-cost` to pass |
| cost: high | Report only | `--strict` to block |

## Usage

- `/cost-gate` -- Scan SQL changes against main branch
- `/cost-gate --base develop` -- Use a different base branch
- `/cost-gate models/marts/` -- Scope to a specific directory
- `/cost-gate --strict` -- Fail on warnings too

Use the tools: `ci_cost_gate`, `sql_analyze`, `sql_predict_cost`, `sql_optimize`, `glob`, `read`, `bash`.
