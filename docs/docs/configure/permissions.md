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
      "*": "ask",
      "dbt *": "allow",
      "git status": "allow",
      "git diff *": "allow",
      "rm *": "deny",
      "DROP *": "deny"
    }
  }
}
```

Patterns are matched in order — **last matching rule wins**. Use `*` as a wildcard. Place your catch-all `"*"` rule first and more specific rules after it.

For example, with `"*": "ask"` first and `"rm *": "deny"` after it, all `rm` commands are denied while everything else prompts. If you put `"*": "ask"` last, it would override the deny rule.

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
altimate
```

## Yolo Mode

Auto-approve all permission prompts without asking. Useful for CI/CD pipelines, benchmarks, scripted workflows, and trusted environments.

**CLI flag (works with any subcommand):**

```bash
altimate-code --yolo run "build all dbt models"
altimate-code --yolo                              # launches TUI in yolo mode
```

**Environment variable:**

```bash
export ALTIMATE_CLI_YOLO=true
altimate-code run "analyze my queries"
```

The fallback `OPENCODE_YOLO` env var is also supported. When both are set, `ALTIMATE_CLI_YOLO` takes precedence — setting it to `false` disables yolo even if `OPENCODE_YOLO=true`.

**Safety:** Explicit `deny` rules in your config are still enforced. Deny rules throw an error *before* any permission prompt is created, so yolo mode never sees them. If you've denied `rm *` or `DROP *`, those remain blocked even with `--yolo`.

When yolo mode is active in the TUI, a `△ YOLO` indicator appears in the footer status bar.

## Recommended Configurations

### Data Engineering (Default — Balanced)

A good starting point for most data engineering workflows. Allows safe read operations, prompts for writes and commands:

```json
{
  "permission": {
    "read": "allow",
    "glob": "allow",
    "grep": "allow",
    "list": "allow",
    "edit": "ask",
    "write": "ask",
    "bash": {
      "*": "ask",
      "dbt *": "allow",
      "git status": "allow",
      "git diff *": "allow",
      "git log *": "allow",
      "ls *": "allow",
      "cat *": "allow",
      "rm *": "deny",
      "DROP *": "deny",
      "DELETE *": "deny",
      "TRUNCATE *": "deny"
    },
    "external_directory": "ask"
  }
}
```

### Strict (Production-Adjacent Work)

When working near production systems. Blocks destructive operations entirely and requires confirmation for everything else:

```json
{
  "permission": {
    "read": "allow",
    "glob": "allow",
    "grep": "allow",
    "list": "allow",
    "edit": "ask",
    "write": "ask",
    "bash": {
      "*": "ask",
      "dbt *": "ask",
      "git status": "allow",
      "rm *": "deny",
      "DROP *": "deny",
      "DELETE *": "deny",
      "TRUNCATE *": "deny",
      "ALTER *": "deny",
      "git push *": "deny",
      "git reset *": "deny"
    },
    "external_directory": "deny"
  }
}
```

### Per-Agent Lockdown

Give each agent only the permissions it needs:

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
    },
    "builder": {
      "permission": {
        "bash": {
          "*": "ask",
          "dbt *": "allow",
          "git *": "ask",
          "DROP *": "deny"
        }
      }
    }
  }
}
```

## How Permissions Work

When the agent wants to use a tool, the permission system evaluates your rules in order:

1. **Config rules** — from `altimate-code.json`
2. **Agent-level rules** — per-agent overrides
3. **Session approvals** — patterns you've approved with "Allow always" during the current session

If a rule matches, it applies. If no rule matches, the default is `"ask"` — you'll be prompted.

When prompted, you have three choices:

| Choice | Effect |
|--------|--------|
| **Allow once** | Approves this single action |
| **Allow always** | Approves this pattern for the rest of the session |
| **Reject** | Blocks the action (optionally with feedback for the agent) |

"Allow always" approvals persist for your current session only. They reset when you restart Altimate Code.

## Tips

- **Start with `"ask"` and relax as you build confidence.** You can always approve patterns with "Allow always" during a session.
- **Use `"deny"` for truly dangerous commands** like `rm *`, `DROP *`, `git push --force *`, and `git reset --hard *`. These are blocked even if other rules would allow them.
- **Use per-agent permissions** to enforce least-privilege. An analyst doesn't need write access. A builder doesn't need `DROP`.
- **Review the prompt before approving.** The TUI shows you exactly what will run — including diffs for file edits and the full command for bash operations.
