# MCP Servers

altimate supports the Model Context Protocol (MCP) for connecting to external tool servers.

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
