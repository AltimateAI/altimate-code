# Agents

Agents define different AI personas with specific models, prompts, permissions, and capabilities.

## Built-in Agents

### General Purpose

| Agent | Description |
|-------|------------|
| `general` | Default general-purpose coding agent |
| `plan` | Planning agent that analyzes before acting |
| `build` | Build-focused agent that prioritizes code generation |
| `explore` | Read-only exploration agent |

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
    Markdown agent files use YAML frontmatter for configuration and the body as the system prompt. This is a convenient way to define agents without editing your main config file.

## Agent Permissions

Each agent can have its own permission overrides that restrict or expand the default permissions. For full details, examples, and recommended configurations, see the [Permissions reference](permissions.md#per-agent-permissions).

## Switching Agents

- **TUI**: Press leader + `a` or use `/agent <name>`
- **CLI**: `altimate --agent analyst`
- **In conversation**: Type `/agent validator`
