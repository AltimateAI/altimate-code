# Tools

altimate-code includes built-in tools that agents use to interact with your codebase and environment.

## Built-in Tools

| Tool | Description |
|------|------------|
| `bash` | Execute shell commands |
| `read` | Read file contents |
| `edit` | Edit files with find-and-replace |
| `write` | Create or overwrite files |
| `glob` | Find files by pattern |
| `grep` | Search file contents with regex |
| `list` | List directory contents |
| `patch` | Apply multi-file patches |
| `lsp` | Language server operations (diagnostics, completions) |
| `webfetch` | Fetch and process web pages |
| `websearch` | Search the web |
| `question` | Ask the user a question |
| `todo_read` | Read task list |
| `todo_write` | Create/update tasks |
| `skill` | Execute a skill |

## Data Engineering Tools

In addition to built-in tools, altimate-code provides 55+ specialized data engineering tools. See the [Data Engineering Tools](../data-engineering/tools/index.md) section for details.

## Tool Permissions

Control which tools agents can use via the [permission system](permissions.md):

```json
{
  "permission": {
    "bash": {
      "dbt *": "allow",
      "rm *": "deny",
      "*": "ask"
    },
    "write": "ask",
    "read": "allow"
  }
}
```

!!! info
    Permission values can be `"allow"`, `"deny"`, or `"ask"`. The `"ask"` permission prompts the user for confirmation before executing.

## Disabling Tools

Disable a tool for a specific agent by setting its permission to `"deny"`:

```json
{
  "agent": {
    "analyst": {
      "permission": {
        "write": "deny",
        "edit": "deny",
        "bash": {
          "dbt run *": "deny",
          "*": "ask"
        }
      }
    }
  }
}
```

!!! example "Read-only analyst"
    The configuration above creates an analyst agent that cannot modify files. It can only read and explore the codebase, and must ask before running shell commands (except `dbt run`, which is blocked entirely).

## Tool Behavior

### Bash Tool

The `bash` tool executes shell commands in the project directory. Commands run in a non-interactive shell with the user's environment.

```json
{
  "permission": {
    "bash": {
      "dbt *": "allow",
      "git *": "allow",
      "python *": "allow",
      "rm -rf *": "deny",
      "*": "ask"
    }
  }
}
```

!!! warning
    Bash permissions use glob-style pattern matching. Be specific with `"deny"` rules to prevent destructive commands while allowing productive ones.

### Read / Write / Edit Tools

File tools respect the project boundaries and permission settings:

- **`read`** — Reads file contents, supports line ranges
- **`write`** — Creates or overwrites entire files
- **`edit`** — Surgical find-and-replace edits within files

### LSP Tool

When [LSP servers](lsp.md) are configured, the `lsp` tool provides:

- Diagnostics (errors, warnings)
- Go-to-definition
- Hover information
- Completions
