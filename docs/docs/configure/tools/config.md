# Tools

altimate includes built-in tools that agents use to interact with your codebase and environment.

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

In addition to built-in tools, altimate provides 55+ specialized data engineering tools. See the [Data Engineering Tools](index.md) section for details.

## Tool Permissions

Control which tools agents can use via the [permission system](../permissions.md). Permission values can be `"allow"`, `"deny"`, or `"ask"` (prompts the user for confirmation). You can set permissions globally or per-agent to disable specific tools or restrict destructive operations.

For full details and examples, see the [Permissions reference](../permissions.md).

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

When [LSP servers](../lsp.md) are configured, the `lsp` tool provides:

- Diagnostics (errors, warnings)
- Go-to-definition
- Hover information
- Completions
