# Commands

## Built-in Commands

altimate ships with six built-in slash commands:

| Command | Description |
|---------|-------------|
| `/init` | Create or update an AGENTS.md file with build commands and code style guidelines. |
| `/discover` | Scan your data stack and set up warehouse connections. Detects dbt projects, warehouse connections from profiles/Docker/env vars, installed tools, and config files. Walks you through adding and testing new connections, then indexes schemas. |
| `/review` | Review changes. Accepts `commit`, `branch`, or `pr` as an argument (defaults to uncommitted changes). |
| `/feedback` | Submit product feedback as a GitHub issue. Guides you through title, category, description, and optional session context. |
| `/configure-claude` | Configure altimate as a `/altimate` slash command in [Claude Code](https://claude.com/claude-code). Writes `~/.claude/commands/altimate.md` so you can invoke altimate from within Claude Code sessions. |
| `/configure-codex` | Configure altimate as a skill in [Codex CLI](https://developers.openai.com/codex). Creates `~/.codex/skills/altimate/SKILL.md` so Codex can delegate data engineering tasks to altimate. |

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

### `/feedback`

Submit product feedback directly from the CLI. The agent walks you through:

1. **Title**, a short summary of your feedback
2. **Category**: bug, feature, improvement, or ux
3. **Description** with a detailed explanation
4. **Session context** (opt-in), which includes working directory name and session ID for debugging

```
/feedback                    # start the guided feedback flow
/feedback dark mode support  # pre-fill the description
```

Requires the `gh` CLI to be installed and authenticated (`gh auth login`).

### `/configure-claude`

Set up altimate as a tool inside Claude Code:

```
/configure-claude
```

This creates `~/.claude/commands/altimate.md`, which registers a `/altimate` slash command in Claude Code. After running this, you can use `/altimate` in any Claude Code session to delegate data engineering tasks:

```
# In Claude Code
/altimate analyze the cost of our top 10 most expensive queries
```

### `/configure-codex`

Set up altimate as a skill inside Codex CLI:

```
/configure-codex
```

This creates `~/.codex/skills/altimate/SKILL.md`. Restart Codex after running this command. Codex will then automatically invoke altimate when you ask about data engineering tasks.

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

## External CLI Integration

The `/configure-claude` and `/configure-codex` commands write integration files to external CLI tools:

| Command | File created | Purpose |
|---------|-------------|---------|
| `/configure-claude` | `~/.claude/commands/altimate.md` | Registers `/altimate` slash command in Claude Code |
| `/configure-codex` | `~/.codex/skills/altimate/SKILL.md` | Registers altimate as a Codex CLI skill |

These files allow you to invoke altimate's data engineering capabilities from within other AI coding agents.
