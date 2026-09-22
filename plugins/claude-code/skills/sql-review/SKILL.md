---
name: sql-review
description: >
  Deterministic SQL quality gate for .sql files — parsed lint (not regex), syntax
  validation, injection/safety scan, PII exposure, and an A-F grade. Use before
  committing SQL, when reviewing SQL changes, or when asked whether a query has
  anti-patterns. Runs the altimate engine locally; no model calls.
allowed-tools: Bash, Read, Glob
---

# SQL review

Runs `altimate check`, which calls the Rust analysis engine directly. Findings are
parsed from the AST, so they do not suffer the false positives a regex sweep produces.

## Preflight

```bash
command -v altimate >/dev/null || echo "altimate not on PATH — install: curl -fsSL https://www.altimate.sh/install | bash"
```

## Jinja is a silent false green — read this before trusting a clean report

The engine parses SQL, not Jinja. A dbt model beginning `{{ config(...) }}` fails to parse
at line 1, **every lint rule is skipped, and the lint block still reports zero findings.**
A clean report on a raw dbt model means nothing.

Verified: one model reported `0 errors, 0 warnings` raw, and 3 real findings
(`L049 clock_in_filter`, `L027 function-on-filter-column`, `L030 select-without-limit`)
once the Jinja was resolved.

So: always check `results.validate` first. If it carries `E000 Syntax error`, the lint
result is void — say so, and re-run against compiled SQL:

```bash
dbt compile --select <model>          # writes target/compiled/**/<model>.sql
altimate check target/compiled/**/<model>.sql --format json --checks lint,validate,grade
```

`E001 Table '<name>' not found` from `validate` is different — that is missing schema
context, not a parse failure, and the lint findings alongside it are valid.

## Run

```bash
altimate check $ARGUMENTS --format json --checks lint,validate,safety,grade --severity info
```

- `$ARGUMENTS` is one or more `.sql` / `.ddl` paths or globs. With no argument, review
  the SQL files changed in the working tree (`git diff --name-only -- '*.sql'`).
- Available checks: `lint`, `validate`, `safety`, `policy`, `pii`, `semantic`, `grade`.
  Add `pii` when the SQL touches user data; add `policy --policy <file.json>` when the
  repo ships a policy file.
- `--severity info|warning|error` filters the report; `--fail-on warning|error` makes it
  exit non-zero, which is what a CI invocation should use.

## Reporting

Group findings by severity, highest first. For each: the rule code, the file and line,
what is wrong, and the concrete fix. State the grade if `grade` ran.

Two rules when reporting:

- **Do not restate a finding you cannot see in the source.** Open the file and confirm
  the line before repeating what the engine said.
- **A finding inside a comment is not a finding.** The engine parses, so this should not
  happen — if it does, say so, because that is an engine bug worth filing.

If the engine reports zero findings, say that plainly rather than manufacturing advice.
