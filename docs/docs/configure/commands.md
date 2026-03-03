# Commands

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
