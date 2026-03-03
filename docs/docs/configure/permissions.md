# Permissions

Permissions control which tools agents can use and what actions they can perform.

## Permission Levels

| Level | Behavior |
|-------|----------|
| `"allow"` | Tool runs without confirmation |
| `"ask"` | User is prompted before each use |
| `"deny"` | Tool is blocked entirely |

## Global Permissions

Set in `altimate-code.json`:

```json
{
  "permission": {
    "read": "allow",
    "glob": "allow",
    "grep": "allow",
    "list": "allow",
    "edit": "ask",
    "write": "ask",
    "bash": "ask",
    "webfetch": "ask",
    "websearch": "ask"
  }
}
```

## Pattern-Based Permissions

For tools that accept arguments (like `bash`), use pattern matching:

```json
{
  "permission": {
    "bash": {
      "dbt *": "allow",
      "git status": "allow",
      "git diff *": "allow",
      "rm *": "deny",
      "DROP *": "deny",
      "*": "ask"
    }
  }
}
```

Patterns are matched in order -- first match wins. Use `*` as a wildcard.

## Per-Agent Permissions

Override permissions for specific agents:

```json
{
  "agent": {
    "analyst": {
      "permission": {
        "write": "deny",
        "edit": "deny",
        "bash": {
          "SELECT *": "allow",
          "dbt docs *": "allow",
          "*": "deny"
        }
      }
    }
  }
}
```

## All Permissioned Tools

| Tool | Supports Patterns | Description |
|------|-------------------|-------------|
| `read` | Yes | Read files |
| `edit` | Yes | Edit files |
| `write` | Yes | Write files |
| `glob` | Yes | Find files |
| `grep` | Yes | Search files |
| `list` | Yes | List directories |
| `bash` | Yes | Shell commands |
| `task` | Yes | Spawn subagents |
| `lsp` | Yes | LSP operations |
| `skill` | Yes | Execute skills |
| `external_directory` | Yes | Access outside project |
| `webfetch` | No | Fetch web pages |
| `websearch` | No | Web search |
| `codesearch` | No | Code search |
| `question` | No | Ask user questions |
| `todowrite` | No | Write tasks |
| `todoread` | No | Read tasks |
| `doom_loop` | No | Loop detection |

## Environment Variable

Set permissions via environment variable:

```bash
export ALTIMATE_CLI_PERMISSION='{"bash":"deny","write":"deny"}'
altimate-code
```
