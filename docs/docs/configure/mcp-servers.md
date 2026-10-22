---
title: MCP Servers — Altimate Code
description: "Configure Model Context Protocol (MCP) servers in Altimate Code to connect external tool providers."
---
# MCP Servers

altimate supports the Model Context Protocol (MCP) for connecting to external tool servers.

## Use Altimate Code tools from another MCP client

Run `altimate-code mcp serve` to expose data tools over stdio. Your MCP client's model handles reasoning; this server runs tools directly without calling a model.

Add this entry to your MCP client's configuration (for example, Claude Code's `.mcp.json`):

```json
{
  "mcpServers": {
    "altimate-code": {
      "command": "altimate-code",
      "args": ["mcp", "serve", "--connections", "/absolute/path/to/connections.json"]
    }
  }
}
```

By default the server exposes `warehouse_list`, `warehouse_add`, `sql_execute`, `sql_materialize` and `answer_commit`. Pass `tables` to `sql_execute` to get those tables' columns and value profiles in the same call as its queries. Start with `--all-tools` to also expose `schema_inspect` and `sql_check`. Without `--connections`, the server reads the usual connection sources and re-reads them while none are configured, so a connections file written mid-session, or a connection added with `warehouse_add`, is picked up without a restart. A connections file is a JSON object keyed by connection name:

```json
{
  "local": { "type": "sqlite", "path": "./analytics.sqlite" }
}
```

Relative database paths resolve beside this file. With `--connections`, this file is the only source of connections: global and project `connections.json` files and `ALTIMATE_CODE_CONN_*` overrides are ignored. Omit `--connections` to use normal connection discovery: global and project `.altimate-code/connections.json` files, followed by `ALTIMATE_CODE_CONN_*` environment overrides. Set your client's working directory to the project when using project discovery.

At startup the server lists each connection's name and type in its instructions, read from configuration only: it does not connect to remote or server databases or run queries on them. For local SQLite and DuckDB files it also lists table names from one catalog query (no row counts); a file with more than 40 tables is noted as such instead. Call `warehouse_list` for columns and sample rows.

<!-- altimate_change start — MCP read-only limits and private output lifecycle -->

Source writes are refused by default. Without `--allow-write`, source queries request database-enforced read-only execution on PostgreSQL, SQLite and DuckDB. For other connection types, read-only is enforced by SQL classification only; stored functions with side effects are not blocked — use a read-only database user. The server prints this caveat on stderr at startup and includes it in `warehouse_list` for each affected connection. Add `--allow-write` to enable SQL write permissions; existing hard safety blocks still apply. `sql_materialize` always requires a read-only source query and writes only into the server session's temporary `scratch` warehouse. Scratch tables disappear when the server exits. Large results may include a local spill file path that your client can open with any file reader. Spill files use a private directory and are deleted when the server exits. Local `tool_output.max_lines` and `tool_output.max_bytes` settings control output limits; remote agent configuration is not loaded.

<!-- altimate_change end -->

The server writes only MCP protocol messages to stdout and sends logs to stderr. It does not initialize telemetry and honors `ALTIMATE_TELEMETRY_DISABLED`.

## Local MCP Servers

Run an MCP server as a local subprocess:

```json
{
  "mcp": {
    "my-tools": {
      "type": "local",
      "command": ["npx", "-y", "@my-org/mcp-server"],
      "environment": {
        "API_KEY": "{env:MY_API_KEY}"
      }
    }
  }
}
```

### Environment variable interpolation

Both syntaxes work anywhere in the config:

| Syntax | Injection mode | Example |
|--------|----------------|---------|
| `${VAR}` | String-safe (JSON-escaped) | `"API_KEY": "${MY_API_KEY}"` — shell / dotenv style |
| `${VAR:-default}` | String-safe with fallback | `"MODE": "${APP_MODE:-production}"` — used when `VAR` is unset or empty |
| `{env:VAR}` | Raw text | `"count": {env:NUM}` — use for unquoted structural injection |
| `$${VAR}` | Escape hatch | `"template": "$${VAR}"` — preserves literal `${VAR}` (docker-compose style) |

If the variable is not set and no default is given, it resolves to an empty string. Bare `$VAR` (without braces) is **not** interpolated — use `${VAR}` or `{env:VAR}`.

**Why two syntaxes?** `${VAR}` JSON-escapes the value so tokens containing quotes or braces can't break the config structure — the safe default for secrets. `{env:VAR}` does raw text injection for the rare case where you need to inject numbers or structure into unquoted JSON positions.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"local"` | Local subprocess server |
| `command` | `string[]` | Command to start the server |
| `environment` | `object` | Environment variables |
| `enabled` | `boolean` | Enable/disable (default: `true`) |
| `timeout` | `number` | Timeout in ms (default: `5000`) |

## Remote MCP Servers

Connect to a remote MCP server over HTTP:

```json
{
  "mcp": {
    "remote-tools": {
      "type": "remote",
      "url": "https://mcp.example.com/sse",
      "headers": {
        "Authorization": "Bearer {env:MCP_TOKEN}"
      }
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"remote"` | Remote HTTP server |
| `url` | `string` | Server URL |
| `headers` | `object` | Static custom HTTP headers |
| `headersCommand` | `object` | Headers whose values are produced by running a command (see below) |
| `enabled` | `boolean` | Enable/disable (default: `true`) |
| `oauth` | `object \| false` | OAuth configuration |
| `timeout` | `number` | Timeout in ms (default: `5000`) |

## Dynamic / Bearer-Token Headers (`headersCommand`)

For servers gated by short-lived bearer tokens (e.g. **Microsoft Fabric Core MCP**, Azure Entra ID), use `headersCommand` to compute a header value by running a command. Each value is an **argv array** run directly via `execFile` (no shell — values are not subject to shell injection unless you explicitly invoke one like `sh -c`). It is **re-resolved on every connect**, so expiring tokens refresh automatically without editing config:

```json
{
  "mcp": {
    "fabric": {
      "type": "remote",
      "url": "https://api.fabric.microsoft.com/v1/mcp/core",
      "headersCommand": {
        "Authorization": ["sh", "-c", "printf 'Bearer %s' \"$(az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv)\""]
      }
    }
  }
}
```

Values from `headersCommand` override matching keys in `headers` (case-insensitively). When an `Authorization` header is supplied (via `headers` or `headersCommand`) and `oauth` is not explicitly configured, **OAuth auto-detection is disabled** so the static/dynamic bearer token is not overridden by a competing OAuth flow.

## OAuth Authentication

For remote servers requiring OAuth:

```json
{
  "mcp": {
    "protected-server": {
      "type": "remote",
      "url": "https://mcp.example.com",
      "oauth": {
        "client_id": "my-app",
        "authorization_url": "https://auth.example.com/authorize",
        "token_url": "https://auth.example.com/token"
      }
    }
  }
}
```

## CLI Management

Manage MCP servers from the command line with `altimate-code mcp`:

```bash
# List configured servers and their connection status (alias: ls)
altimate-code mcp list

# Add a local (stdio) server
altimate-code mcp add --name my-tools --type local --command "node ./server.js" \
  --env API_KEY=secret

# Add a remote (HTTP) server, with an extra header
altimate-code mcp add --name remote-tools --type remote \
  --url https://example.com/mcp --header "Authorization=Bearer TOKEN"

# Authenticate / re-authenticate an OAuth-enabled server
altimate-code mcp auth my-tools

# Remove stored OAuth credentials for a server
altimate-code mcp logout my-tools

# Remove a server from the config (alias: rm)
altimate-code mcp remove my-tools

# Debug an OAuth connection for a server
altimate-code mcp debug my-tools
```

`altimate-code mcp add` writes to the project config (`.altimate-code/altimate-code.json`) by default; pass `--global` to write to the global config (`~/.config/altimate-code/`) instead. Use `--type local` with `--command` for stdio servers, or `--type remote` with `--url` for HTTP servers; `--env` and `--header` are repeatable. OAuth is enabled by default (`--oauth`).

## Experimental Settings

```json
{
  "experimental": {
    "mcp_timeout": 10000
  }
}
```
