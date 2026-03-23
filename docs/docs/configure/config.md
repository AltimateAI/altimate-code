# Configuration

altimate uses JSON (or JSONC) configuration files. The config file is named `altimate-code.json` or `altimate-code.jsonc`.

## Config File Locations

Configuration is loaded from multiple sources, with later sources overriding earlier ones:

| Priority | Source | Location |
|----------|--------|----------|
| 1 (lowest) | Remote defaults | `.well-known/altimate-code` (organization) |
| 2 | Global config | `~/.config/altimate-code/altimate-code.json` |
| 3 | Custom config | Path from `ALTIMATE_CLI_CONFIG` env var |
| 4 | Project config | `altimate-code.json` (searched up directory tree) |
| 5 | Directory config | `.altimate-code/altimate-code.json` (searched up tree) |
| 6 | Inline config | `ALTIMATE_CLI_CONFIG_CONTENT` env var (JSON string) |
| 7 (highest) | Managed config | `/Library/Application Support/altimate-code/` (macOS, enterprise) |

!!! tip
    For most projects, create a `altimate-code.json` in your project root or use the `.altimate-code/` directory for a cleaner setup.

## Minimal Example

```json
{
  "provider": {
    "anthropic": {
      "apiKey": "{env:ANTHROPIC_API_KEY}"
    }
  },
  "model": "anthropic/claude-sonnet-4-6"
}
```

## Full Schema

| Field | Type | Description |
|-------|------|-------------|
| `$schema` | `string` | JSON schema URL for editor autocompletion |
| `theme` | `string` | UI theme name |
| `username` | `string` | Custom display username |
| `model` | `string` | Default model (`provider/model`) |
| `small_model` | `string` | Smaller model for lightweight tasks |
| `default_agent` | `string` | Default agent to use on startup |
| `logLevel` | `string` | Log level: `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `share` | `string` | Session sharing: `"manual"`, `"auto"`, `"disabled"` |
| `autoupdate` | `boolean \| "notify"` | Auto-update behavior: `true` (default) auto-upgrades, `"notify"` shows an indicator without upgrading, `false` disables auto-upgrade but still shows the update indicator |
| `provider` | `object` | Provider configurations (see [Providers](providers.md)) |
| `mcp` | `object` | MCP server configurations (see [MCP Servers](mcp-servers.md)) |
| `formatter` | `object \| false` | Formatter settings (see [Formatters](formatters.md)) |
| `lsp` | `object \| false` | LSP server settings (see [LSP Servers](lsp.md)) |
| `permission` | `object` | Permission rules (see [Permissions](permissions.md)) |
| `agent` | `object` | Agent definitions (see [Agents](agents.md)) |
| `keybinds` | `object` | Keybinding overrides (see [Keybinds](keybinds.md)) |
| `tui` | `object` | TUI settings |
| `server` | `object` | Server settings |
| `skills` | `object` | Skill paths and URLs |
| `plugin` | `string[]` | Plugin specifiers |
| `instructions` | `string[]` | Glob patterns for instruction files |
| `telemetry` | `object` | Telemetry settings (see [Telemetry](../reference/telemetry.md)) |
| `compaction` | `object` | Context compaction settings (see [Context Management](context-management.md)) |
| `experimental` | `object` | Experimental feature flags |

### Experimental Flags

These flags are under `experimental` and may change or be removed in future releases.

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `env_fingerprint_skill_selection` | `boolean` | `false` | Use environment fingerprint (dbt, airflow, databricks, SQL) to select relevant skills once per session via LLM. When enabled, the configured model runs once at session start to filter skills based on detected project environment. Results are cached per working directory. When disabled (default), all skills are shown. |
| `auto_enhance_prompt` | `boolean` | `false` | Automatically rewrite prompts with AI before sending. Uses a small model to clarify rough prompts. |

Example:

```json
{
  "experimental": {
    "env_fingerprint_skill_selection": true
  }
}
```

## Value Substitution

Config values support dynamic substitution so you never need to hardcode secrets.

### Environment Variables

Use `{env:VAR_NAME}` to inject environment variables:

```json
{
  "provider": {
    "anthropic": {
      "apiKey": "{env:ANTHROPIC_API_KEY}"
    }
  }
}
```

### File Contents

Use `{file:path}` to read a secret from a file:

```json
{
  "provider": {
    "anthropic": {
      "apiKey": "{file:~/.secrets/anthropic-key}"
    }
  }
}
```

!!! warning
    Never commit plaintext API keys to version control. Always use `{env:...}` or `{file:...}` substitution.

## Project Structure

A typical project layout using the `.altimate-code/` directory:

```
my-project/
  .altimate-code/
    altimate-code.json    # Project config
    agents/               # Custom agent definitions
    commands/             # Custom slash commands
    plugins/              # Custom plugins
    tools/                # Custom tools
    skill/                # Custom skills
  altimate-code.json      # Alternative project config location
```

## Compaction Settings

Control how context is managed when conversations grow long:

```json
{
  "compaction": {
    "auto": true,
    "prune": true,
    "reserved": 4096
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `auto` | `true` | Auto-compact when context is full |
| `prune` | `true` | Prune old tool outputs |
| `reserved` | (none) | Token buffer to reserve |

!!! info
    Compaction automatically summarizes older messages to free up context window space, allowing longer conversations without losing important context. See [Context Management](context-management.md) for full details.
