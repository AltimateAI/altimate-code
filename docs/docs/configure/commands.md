# Commands

## Built-in Commands

altimate ships with three built-in slash commands:

| Command | Description |
|---------|-------------|
| `/init` | Create or update an AGENTS.md file with build commands and code style guidelines. |
| `/discover` | Scan your data stack and set up warehouse connections. Detects dbt projects, warehouse connections from profiles/Docker/env vars, installed tools, and config files. Walks you through adding and testing new connections, then indexes schemas. |
| `/review` | Review changes — accepts `commit`, `branch`, or `pr` as an argument (defaults to uncommitted changes). |

### `/discover`

The recommended way to set up a new data engineering project. Run `/discover` in the TUI and the agent will:

1. Call `project_scan` to detect your full environment
2. Present what was found (dbt project, connections, tools, config files)
3. Offer to add each new connection discovered (from dbt profiles, Docker, environment variables)
4. Test each connection with `warehouse_test`
5. Offer to index schemas for autocomplete and context-aware analysis
6. Show available skills and agent modes

### `/review`

```
/review              # review uncommitted changes
/review commit       # review the last commit
/review branch       # review all changes on the current branch
/review pr           # review the current pull request
```

## Custom Commands

Custom commands let you define reusable slash commands.

## Creating Commands

Create markdown files in `.altimate-code/commands/`:

```
.altimate-code/
  commands/
    review.md
    optimize.md
    test-coverage.md
```

### Command Format

```markdown
---
name: review
description: Review SQL for anti-patterns and best practices
---

Review the following SQL file for:
1. Anti-patterns (SELECT *, missing WHERE clauses, implicit joins)
2. Cost efficiency (full table scans, unnecessary CTEs)
3. dbt best practices (ref() usage, naming conventions)

File: $ARGUMENTS
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Command name (used as `/name`) |
| `description` | Yes | Description shown in command list |

### Variables

| Variable | Description |
|----------|------------|
| `$ARGUMENTS` | Everything typed after the command name |

## Using Commands

In the TUI:

```
/review models/staging/stg_orders.sql
/optimize warehouse queries
```

## Discovery

Commands are loaded from:

1. `.altimate-code/commands/` in the project directory
2. `~/.config/altimate-code/commands/` globally

Press leader + `/` to see all available commands.
