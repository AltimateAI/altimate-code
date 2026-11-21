---
title: Config File Reference — Altimate Code
description: "JSON and JSONC configuration file locations, priority order, and all available settings for Altimate Code."
---

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
| `offline` | `boolean` | Restrict network access to the configured model endpoint |
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

## Offline / air-gapped mode

Offline mode is for running Altimate Code against a local or self-hosted model with no other network access. Altimate Code then sends network requests only to the configured model endpoint. Local work keeps running: tools, shell commands, local databases, language servers, local MCP servers and local Git.

With offline mode off, nothing on this page applies and Altimate Code behaves exactly as before.

### Turn it on

Set `ALTIMATE_OFFLINE=1` before starting Altimate Code, or add `"offline": true` to a global or project configuration file (or `OPENCODE_CONFIG_CONTENT`). Altimate Code checks those files for the setting when it starts, so startup requests are covered too. Organisation-managed configuration, remote (well-known) configuration and the legacy TOML `config` file apply the setting only once they load, after some startup requests; use `ALTIMATE_OFFLINE=1` there. Any one of these sources turns it on; a value of `false` elsewhere does not turn it back off. `ALTIMATE_OFFLINE` values of empty, `0`, `false`, `off` and `no` mean off. Once on, offline mode lasts for the rest of the process, including any server that loaded the project.

Configure a provider with an explicit HTTP(S) `options.baseURL` and use one of its models (`provider/model`). For an OpenAI-compatible server, use the bundled `@ai-sdk/openai-compatible` provider, and define the model under the provider if it is not in the bundled or cached catalog. Model requests go only to a provider's explicit `baseURL`, never to a catalog URL, and are not redirected. They respect `HTTPS_PROXY` and `HTTP_PROXY`. A `small_model` is used only if its provider also has an explicit `baseURL`.

### Before going offline

While still online:

- Run `altimate-code workspace refresh` to save the workspace skill snapshot. Offline runs use it as it is, without refreshing it.
- Install the warehouse drivers you need (the `warehouse_install_driver` tool), any language servers, and ripgrep.
- Run `dbt deps` for dbt projects, and install any DuckDB extensions your profiles use.

### What keeps working

- Local warehouses: DuckDB and SQLite files, and Postgres, MySQL, SQL Server, ClickHouse, Trino, Oracle and MongoDB servers reached through a Unix socket or a host of `localhost`, `::1` or `127.x.x.x`. Other hosts, connection strings that cannot be parsed (including Oracle Easy Connect strings; set `host` instead), and account-addressed warehouses such as Snowflake, BigQuery and Databricks are refused.
- dbt commands whose selected profile and target are local. Values written as Jinja templates (for example `{{ env_var('DBT_HOST') }}`) cannot be checked and are refused; write them literally to use them offline. dbt-duckdb profiles can use extensions, local attachments and plugins; settings that point at remote storage, a remote server or a remote extension repository (`s3://`, `https://`, `gcs://`, `md:` and similar) are refused. Named extensions and plugins are not checked: install extensions while online, and do not configure plugins that call remote services.
- DuckDB loads extensions that are already installed and does not install new ones automatically.
- The shell tool, installed language servers, stdio MCP servers and MCP servers at `localhost`, `127.0.0.1`, `[::1]` or `0.0.0.0`, including `tool run --daemon`.
- Git diffs, session snapshots and revert, and worktree create, remove and reset. Reset uses the locally cached base branch and leaves submodules at their current commits. Worktree create and reset leave Git LFS files as pointer files.
- `attach` and `run --attach` to a server on this machine. The attached server applies its own policy, so start it with offline mode too.

### What is blocked

Each of these fails with a one-line message or is skipped:

- telemetry, account and remote configuration requests;
- model catalog downloads and update checks;
- workspace and workspace engine sync, and session sharing;
- the web fetch, web search, code search, `datamate_manager`, feedback and memory refresh tools;
- MCP servers at other URLs, and MCP sign-in;
- automatic installs of warehouse drivers, language servers, plugins and ripgrep;
- warehouse connections to other hosts, SSH tunnels, and cloud sign-in methods for dbt;
- `dbt deps` and dbt's usage reporting and version check;
- `git clone`, `fetch`, `pull`, `push` and other Git commands that use a remote;
- commands that need a remote service, such as `github`, `pr`, `web`, `upgrade`, `review --post` and `attach` to another machine.

### What offline mode does not police

Programs you run or configure yourself keep their own network access and proxy settings: shell commands, language servers, local MCP servers and their child processes. Offline mode does not sandbox them. They inherit `ALTIMATE_OFFLINE=1`, so an `altimate-code` started from the shell is offline too, and `NO_PROXY` gains `localhost,127.0.0.1,[::1],0.0.0.0` so that local requests do not go through a proxy.

Some network use happens inside programs Altimate Code starts and is not checked either:

- Git in a partial (blobless or treeless) clone fetches missing objects on demand, even for local commands such as `diff`, and Git LFS can download missing objects during a checkout outside worktree reset.
- dbt reads libpq environment variables such as `PGHOSTADDR` and `PGSERVICE`, which can point a Postgres profile at another host.
- Cloud sign-in configured on a local warehouse (for example SQL Server `authentication: azure-active-directory-*` or MongoDB `authMechanism=MONGODB-AWS`) contacts its identity provider.
- When offline mode turns on after startup (organisation-managed or remote configuration, or a server started without it that then loads an offline project), internal HTTP requests made through the shared HTTP client stay unguarded for the rest of that process. Set `ALTIMATE_OFFLINE=1` before starting a server.

SQL that runs an explicit `INSTALL`, or loads an installed network extension (such as `httpfs`) and reads a remote path, is not blocked. The `altimate-dbt` command runs through the shell tool and is not policed either, although it turns off its own dependency installs and usage reporting.
