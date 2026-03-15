# CLI

altimate provides subcommands for headless operation, automation, and integration.

## Basic Usage

```bash
# Launch the TUI (default)
altimate

# Run a prompt non-interactively
altimate run "analyze my most expensive queries"

# Start with a specific agent
altimate --agent analyst
```

> **Note:** `altimate-code` still works as a backward-compatible alias for all commands.

## Subcommands

| Command | Description |
|---------|------------|
| `run [message]` | Run a prompt non-interactively |
| `serve` | Start a headless server |
| `web` | Start server and open web interface |
| `attach <url>` | Attach to a running server |
| `agent` | Manage agents (`create`, `list`) |
| `auth` | Manage credentials (`login`, `logout`, `list`) |
| `mcp` | Manage MCP servers (`add`, `list`, `auth`, `logout`, `debug`) |
| `acp` | Start ACP server for editor integration |
| `models [provider]` | List available models |
| `stats` | Show token usage and cost statistics |
| `export [sessionID]` | Export session data as JSON |
| `import <file>` | Import session data from JSON file or URL |
| `session` | Manage sessions (`list`, `delete`) |
| `github` | Manage GitHub agent (`install`, `run`) |
| `pr <number>` | Fetch and checkout a GitHub PR branch, then run altimate |
| `db` | Database tools — SQLite shell, path, and migration |
| `debug` | Debugging tools — config, LSP, skills, agents, paths |
| `completion` | Generate shell completion script |
| `upgrade [target]` | Upgrade to latest or specific version |
| `uninstall` | Uninstall altimate and remove all related files |

## Global Flags

| Flag | Description |
|------|------------|
| `--model`, `-m <provider/model>` | Override the default model |
| `--agent <name>` | Start with a specific agent |
| `--continue`, `-c` | Continue the last session |
| `--session`, `-s <id>` | Continue a specific session by ID |
| `--fork` | Fork the session when continuing (use with `--continue` or `--session`) |
| `--prompt <text>` | Prompt to use |
| `--port <number>` | Port to listen on (default: `0`) |
| `--hostname <host>` | Hostname to listen on (default: `127.0.0.1`) |
| `--mdns` | Enable mDNS service discovery (defaults hostname to `0.0.0.0`) |
| `--cors <domains>` | Additional domains to allow for CORS |
| `--print-logs` | Print logs to stderr |
| `--log-level <level>` | Set log level: `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `--help`, `-h` | Show help |
| `--version`, `-v` | Show version |

## Environment Variables

Configuration can be controlled via environment variables:

### Core Configuration

| Variable | Description |
|----------|------------|
| `ALTIMATE_CLI_CONFIG` | Path to custom config file |
| `ALTIMATE_CLI_CONFIG_DIR` | Custom config directory |
| `ALTIMATE_CLI_CONFIG_CONTENT` | Inline config as JSON string |
| `ALTIMATE_CLI_GIT_BASH_PATH` | Path to Git Bash (Windows) |

### Feature Toggles

| Variable | Description |
|----------|------------|
| `ALTIMATE_CLI_DISABLE_AUTOUPDATE` | Disable automatic updates |
| `ALTIMATE_CLI_DISABLE_LSP_DOWNLOAD` | Don't auto-download LSP servers |
| `ALTIMATE_CLI_DISABLE_AUTOCOMPACT` | Disable automatic context compaction |
| `ALTIMATE_CLI_DISABLE_DEFAULT_PLUGINS` | Skip loading default plugins |
| `ALTIMATE_CLI_DISABLE_EXTERNAL_SKILLS` | Disable external skill discovery |
| `ALTIMATE_CLI_DISABLE_PROJECT_CONFIG` | Ignore project-level config files |
| `ALTIMATE_CLI_DISABLE_TERMINAL_TITLE` | Don't set terminal title |
| `ALTIMATE_CLI_DISABLE_PRUNE` | Disable database pruning |
| `ALTIMATE_CLI_DISABLE_MODELS_FETCH` | Don't fetch models from models.dev |

### Server & Security

| Variable | Description |
|----------|------------|
| `ALTIMATE_CLI_SERVER_USERNAME` | Server HTTP basic auth username |
| `ALTIMATE_CLI_SERVER_PASSWORD` | Server HTTP basic auth password |
| `ALTIMATE_CLI_PERMISSION` | Permission config as JSON |

### Experimental

| Variable | Description |
|----------|------------|
| `ALTIMATE_CLI_EXPERIMENTAL` | Enable all experimental features |
| `ALTIMATE_CLI_EXPERIMENTAL_FILEWATCHER` | Enable file watcher |
| `ALTIMATE_CLI_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS` | Custom bash timeout (ms) |
| `ALTIMATE_CLI_EXPERIMENTAL_OUTPUT_TOKEN_MAX` | Max output tokens |
| `ALTIMATE_CLI_EXPERIMENTAL_PLAN_MODE` | Enable plan mode |
| `ALTIMATE_CLI_ENABLE_EXA` | Enable Exa web search |

## Non-interactive Usage

```bash
# Pipe input
echo "explain this SQL" | altimate run

# With a specific model
altimate run --model anthropic/claude-sonnet-4-6 "optimize my warehouse"

# Continue the last session
altimate --continue

# Fork and continue a specific session
altimate --session abc123 --fork

# Print logs for debugging
altimate --print-logs --log-level DEBUG run "test query"
```
