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

| Command     | Description                    |
| ----------- | ------------------------------ |
| `run`       | Run a prompt non-interactively |
| `serve`     | Start the HTTP API server      |
| `web`       | Start the web UI               |
| `agent`     | Agent management               |
| `auth`      | Authentication                 |
| `mcp`       | Model Context Protocol tools   |
| `acp`       | Agent Communication Protocol   |
| `models`    | List available models          |
| `stats`     | Usage statistics               |
| `export`    | Export session data            |
| `import`    | Import session data            |
| `session`   | Session management             |
| `trace`     | List and view session traces (recordings of agent sessions) |
| `github`    | GitHub integration             |
| `pr`        | Pull request tools             |
| `upgrade`   | Upgrade to latest version      |
| `uninstall` | Uninstall altimate             |

## Global Flags

| Flag | Description |
|------|------------|
| `--model <provider/model>` | Override the default model |
| `--agent <name>` | Start with a specific agent |
| `--yolo` | Auto-approve all permission prompts (explicit `deny` rules still enforced) |
| `--print-logs` | Print logs to stderr |
| `--log-level <level>` | Set log level: `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `--help`, `-h` | Show help |
| `--version`, `-v` | Show version |

## Environment Variables

Configuration can be controlled via environment variables:

### Core Configuration

| Variable                      | Description                  |
| ----------------------------- | ---------------------------- |
| `ALTIMATE_CLI_CONFIG`         | Path to custom config file   |
| `ALTIMATE_CLI_CONFIG_DIR`     | Custom config directory      |
| `ALTIMATE_CLI_CONFIG_CONTENT` | Inline config as JSON string |
| `ALTIMATE_CLI_GIT_BASH_PATH`  | Path to Git Bash (Windows)   |

### Feature Toggles

| Variable                               | Description                          |
| -------------------------------------- | ------------------------------------ |
| `ALTIMATE_CLI_DISABLE_AUTOUPDATE`      | Disable automatic updates (still shows upgrade indicator) |
| `ALTIMATE_CLI_DISABLE_LSP_DOWNLOAD`    | Don't auto-download LSP servers      |
| `ALTIMATE_CLI_DISABLE_AUTOCOMPACT`     | Disable automatic context compaction |
| `ALTIMATE_CLI_DISABLE_DEFAULT_PLUGINS` | Skip loading default plugins         |
| `ALTIMATE_CLI_DISABLE_EXTERNAL_SKILLS` | Disable external skill discovery     |
| `ALTIMATE_CLI_DISABLE_PROJECT_CONFIG`  | Ignore project-level config files    |
| `ALTIMATE_CLI_DISABLE_TERMINAL_TITLE`  | Don't set terminal title             |
| `ALTIMATE_CLI_DISABLE_PRUNE`           | Disable database pruning             |
| `ALTIMATE_CLI_DISABLE_MODELS_FETCH`    | Don't fetch models from models.dev   |

### Server & Security

| Variable                       | Description                     |
| ------------------------------ | ------------------------------- |
| `ALTIMATE_CLI_SERVER_USERNAME` | Server HTTP basic auth username |
| `ALTIMATE_CLI_SERVER_PASSWORD` | Server HTTP basic auth password |
| `ALTIMATE_CLI_PERMISSION`      | Permission config as JSON       |

### Permissions & Safety

| Variable | Description |
|----------|------------|
| `ALTIMATE_CLI_YOLO` | Auto-approve all permission prompts (`true`/`false`). Explicit `deny` rules still enforced. |
| `OPENCODE_YOLO` | Fallback for `ALTIMATE_CLI_YOLO`. When both are set, `ALTIMATE_CLI_YOLO` takes precedence. |

### Memory & Training

| Variable | Description |
|----------|------------|
| `ALTIMATE_DISABLE_MEMORY` | Disable the persistent memory system |
| `ALTIMATE_MEMORY_AUTO_EXTRACT` | Auto-extract memories at session end |
| `ALTIMATE_DISABLE_TRAINING` | Disable the AI teammate training system |

### Experimental

| Variable                                            | Description                                                                                                                                                                                                                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALTIMATE_CLI_EXPERIMENTAL`                         | Enable all experimental features                                                                                                                                                                                                                                              |
| `ALTIMATE_CLI_EXPERIMENTAL_FILEWATCHER`             | Enable file watcher                                                                                                                                                                                                                                                           |
| `ALTIMATE_CLI_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS` | Custom bash timeout (ms)                                                                                                                                                                                                                                                      |
| `ALTIMATE_CLI_EXPERIMENTAL_OUTPUT_TOKEN_MAX`        | Max output tokens                                                                                                                                                                                                                                                             |
| `ALTIMATE_CLI_EXPERIMENTAL_PLAN_MODE`               | Enable plan mode                                                                                                                                                                                                                                                              |
| `ALTIMATE_CLI_ENABLE_EXA`                           | Enable Exa web search                                                                                                                                                                                                                                                         |
| `ALTIMATE_CALM_MODE`                                | Enables all streaming optimizations: smooth rendering, line-at-a-time buffering, and 100-column width cap. Recommended for a Claude Code-like experience. Equivalent to setting `ALTIMATE_SMOOTH_STREAMING=true ALTIMATE_LINE_STREAMING=true ALTIMATE_CONTENT_MAX_WIDTH=100`. |
| `ALTIMATE_SMOOTH_STREAMING`                         | Uses lightweight `<code>` rendering during LLM streaming, then swaps to rich markdown after completion. Reduces text jumps and scroll jitter. Included in `ALTIMATE_CALM_MODE`.                                                                                               |
| `ALTIMATE_LINE_STREAMING`                           | Buffers LLM output and reveals one complete line at a time (on `\n`). Gives a calm, steady flow. Remaining text flushes on message completion or abort. Included in `ALTIMATE_CALM_MODE`.                                                                                     |
| `ALTIMATE_CONTENT_MAX_WIDTH`                        | Cap text content width in columns (e.g. `100`). Improves readability on wide screens. Automatically disabled on small terminals. Set to `100` by `ALTIMATE_CALM_MODE`.                                                                                                        |

#### Calm Mode Quick Start

For a Claude Code-like streaming experience, add to your shell profile:

```bash
export ALTIMATE_CALM_MODE=true
```

Or use individual flags for fine-grained control:

```bash
# Smooth rendering only (no line buffering)
export ALTIMATE_SMOOTH_STREAMING=true

# Line buffering only (no rendering changes)
export ALTIMATE_LINE_STREAMING=true

# Custom width cap (e.g., 80 columns)
export ALTIMATE_CONTENT_MAX_WIDTH=80
```

## Non-interactive Usage

```bash
# Pipe input
echo "explain this SQL" | altimate run

# With a specific model
altimate run --model anthropic/claude-sonnet-4-6 "optimize my warehouse"

# Print logs for debugging
altimate --print-logs --log-level DEBUG run "test query"

# Disable tracing for a single run
altimate run --no-trace "quick question"
```

For CI pipelines and headless automation, see [CI & Automation](ci-headless.md).

## Trace

Every `run` command automatically saves a trace file (a recording of the agent session) with the full session details, including generations, tool calls, tokens, cost, and timing. See [Trace](../configure/trace.md) for configuration options.

```bash
# List recent traces
altimate trace list

# View a trace in the browser
altimate trace view <session-id>
```
