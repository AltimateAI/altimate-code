# Agents

Agents define different AI personas with specific models, prompts, permissions, and capabilities.

## Built-in Agents

| Agent | Description | Access Level |
|-------|------------|-------------|
| `builder` | Create and modify dbt models, SQL pipelines, and data transformations | Full read/write. SQL mutations prompt for approval. |
| `analyst` | Explore data, run SELECT queries, inspect schemas, generate insights | Read-only (enforced). SQL writes denied. Safe bash commands auto-allowed. |
| `plan` | Plan before acting, restricted to planning files only | Minimal: no edits, no bash, no SQL |

### Builder

Full access mode. Can read/write files, run any bash command (with approval), execute SQL, and modify dbt models. SQL write operations (`INSERT`, `UPDATE`, `DELETE`, `CREATE`, etc.) prompt for user approval. Destructive SQL (`DROP DATABASE`, `DROP SCHEMA`, `TRUNCATE`) is hard-blocked.

### Analyst

Truly read-only mode for safe data exploration:

- **File access**: Read, grep, glob without prompts
- **SQL**: SELECT queries execute freely. Write queries are denied (not prompted, blocked entirely)
- **Bash**: Safe commands auto-allowed (`ls`, `grep`, `cat`, `head`, `tail`, `find`, `wc`). dbt read commands allowed (`dbt list`, `dbt ls`, `dbt debug`, `dbt deps`). Everything else denied.
- **Web**: Fetch and search allowed without prompts
- **Schema/warehouse/finops**: All inspection tools available

!!! tip
    Use `analyst` when exploring data to ensure no accidental writes. Switch to `builder` when you're ready to create or modify models.

### Plan

Planning mode with minimal permissions. Can only read files and edit plan files. No SQL, no bash, no file modifications.

## SQL Write Access Control

All SQL queries are classified before execution:

| Query Type | Builder | Analyst |
|-----------|---------|---------|
| `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN` | Allowed | Allowed |
| `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER` | Prompts for approval | Denied |
| `DROP DATABASE`, `DROP SCHEMA`, `TRUNCATE` | Blocked (cannot override) | Blocked |

The classifier detects write operations including: `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE`, `DROP`, `ALTER`, `TRUNCATE`, `GRANT`, `REVOKE`, `COPY INTO`, `CALL`, `EXEC`, `EXECUTE IMMEDIATE`, `BEGIN`, `DECLARE`, `REPLACE`, `UPSERT`, `RENAME`.

Multi-statement queries (`SELECT 1; INSERT INTO ...`) are classified as write if any statement is a write.

## Custom Agents

Define custom agents in `altimate-code.json`:

```json
{
  "agent": {
    "reviewer": {
      "model": "anthropic/claude-sonnet-4-6",
      "prompt": "You are a data engineering code reviewer. Focus on SQL best practices, dbt conventions, and warehouse cost efficiency.",
      "description": "Reviews data engineering code",
      "permission": {
        "write": "deny",
        "edit": "deny",
        "bash": {
          "dbt docs generate": "allow",
          "*": "deny"
        }
      }
    }
  }
}
```

## Agent Configuration

| Field | Type | Description |
|-------|------|-------------|
| `model` | `string` | Model to use (`provider/model`) |
| `variant` | `string` | Model variant |
| `temperature` | `number` | Sampling temperature |
| `top_p` | `number` | Nucleus sampling |
| `prompt` | `string` | System prompt |
| `description` | `string` | Agent description |
| `disable` | `boolean` | Disable this agent |
| `mode` | `string` | `"primary"`, `"subagent"`, or `"all"` |
| `hidden` | `boolean` | Hide from agent list (subagents only) |
| `color` | `string` | Hex color or theme color name |
| `steps` | `number` | Max agentic iterations |
| `permission` | `object` | Agent-specific permissions |
| `options` | `object` | Custom options |

## Markdown Agent Definitions

Create agents as markdown files in `.altimate-code/agents/`:

```markdown
---
name: cost-reviewer
model: anthropic/claude-sonnet-4-6
description: Reviews queries for cost efficiency
---

You are a Snowflake cost optimization expert. For every query:
1. Estimate credit consumption
2. Suggest warehouse size optimization
3. Flag full table scans and cartesian joins
4. Recommend clustering keys where appropriate
```

!!! info
    Markdown agent files use YAML frontmatter for configuration and the body as the system prompt.

## Agent Permissions

Each agent can have its own permission overrides:

```json
{
  "agent": {
    "analyst": {
      "permission": {
        "write": "deny",
        "edit": "deny",
        "sql_execute_write": "deny",
        "bash": {
          "*": "deny",
          "dbt list *": "allow",
          "ls *": "allow"
        }
      }
    }
  }
}
```

!!! warning
    Agent-specific permissions override global permissions. A `"deny"` at the agent level cannot be overridden by a global `"allow"`.

## Switching Agents

- **TUI**: Press leader + `a` or use `/agent <name>`
- **CLI**: `altimate --agent analyst`
- **In conversation**: Type `/agent analyst`
