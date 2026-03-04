# Rules

Rules are instructions that guide agent behavior. They are loaded automatically from well-known file patterns and merged into the agent's system prompt.

## Instruction Files

altimate looks for instruction files in these locations:

- `AGENTS.md` — Primary instruction file (searched up directory tree)
- `CLAUDE.md` — Fallback instruction file
- `.altimate-code/AGENTS.md` — Project-specific instructions
- Custom patterns via the `instructions` config field

!!! tip
    Start with a single `AGENTS.md` in your project root. Add more instruction files as your project grows.

### Config-based Instructions

Specify additional instruction sources in your config:

```json
{
  "instructions": [
    "AGENTS.md",
    ".altimate-code/**/*.md",
    "docs/ai-guidelines.md",
    "https://example.com/team-guidelines.md"
  ]
}
```

Patterns support:

- **Glob patterns** — `*.md`, `docs/**/*.md`
- **URLs** — fetched at startup
- **Relative paths** — resolved from project root

## Writing Effective Rules

A good `AGENTS.md` file provides project context, coding conventions, and workflow guidance:

```markdown
# AGENTS.md

## Project Context
This is a dbt project for our analytics warehouse on Snowflake.

## Conventions
- Always use `ref()` instead of hardcoded table names
- Follow our naming convention: `stg_`, `int_`, `fct_`, `dim_`
- Run `dbt build --select state:modified+` to test changes

## Warehouse Rules
- Never run DDL on production
- Always use the ANALYST_ROLE for queries
- Prefer incremental models over full refreshes
```

!!! example "Tips for effective rules"
    - Be specific and actionable — vague rules get ignored
    - Include project-specific terminology and conventions
    - Reference file paths and commands that agents should use
    - Keep rules concise; overly long instructions dilute focus

## Instruction Scope

Instructions apply based on file location:

| Location | Scope |
|----------|-------|
| Project root `AGENTS.md` | All agents in project |
| `.altimate-code/AGENTS.md` | Project-specific |
| Subdirectory `AGENTS.md` | Active when working in that subtree |
| Global `~/.config/altimate-code/AGENTS.md` | All projects |

!!! note
    When multiple instruction files match, they are merged together. More specific files (deeper in the directory tree) take precedence for conflicting guidance.

## Remote Instructions

Organizations can host shared instructions at a well-known URL:

```
https://your-domain.com/.well-known/altimate-code
```

These are loaded as the lowest-priority configuration source, allowing individual projects and users to override them.

## Instruction Format

Instruction files are plain Markdown. Use headings and lists to organize your rules clearly:

```markdown
# Project: Analytics Pipeline

## Stack
- Warehouse: Snowflake
- Orchestrator: Airflow
- Transform: dbt 1.8

## SQL Style
- Use CTEs instead of subqueries
- Alias all columns in SELECT
- One join condition per line

## Testing
- Every model must have a `unique` test on its primary key
- Use `dbt_expectations` for data quality checks
```
