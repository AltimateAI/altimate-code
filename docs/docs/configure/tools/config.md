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

In addition to built-in tools, altimate provides 100+ specialized data engineering tools. See the [Data Engineering Tools](index.md) section for details.

## Tool Permissions

Control which tools agents can use via the [permission system](../permissions.md). For full details, pattern-based rules, and recommended configurations, see the [Permissions reference](../permissions.md).

## Tool Behavior

### Bash Tool

The `bash` tool executes shell commands in the project directory. Commands run in a non-interactive shell with the user's environment.

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

### Tool Retrieval

With the full data-engineering toolset (~78 tools), sending every tool definition on every turn floods the context window and adds distractors that hurt the model's tool selection. **Tool retrieval** trims the exposed set per turn to a relevant subset, cutting input tokens substantially at the same task quality.

It is **off by default** and enabled with an environment variable:

```bash
ALTIMATE_TOOL_RETRIEVAL=1 altimate-code run "..."
```

When enabled, each turn exposes:

- an always-on **core** set of essentials that are never trimmed (`bash`, `read`, `write`, `edit`, `glob`, `grep`, `list`, `task`, `todowrite`, `skill`),
- any tool already **referenced by an in-flight tool call** (so a mid-trajectory tool is never dropped), and
- the highest-scoring remaining tools by a deterministic lexical match against the turn's request, up to a fixed budget.

Selection is deterministic and dependency-free; small tool sets are left untouched (nothing to gain). In internal benchmarks this cut input tokens by ~50% at an identical task-resolution rate.
