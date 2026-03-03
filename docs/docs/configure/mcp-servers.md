# MCP Servers

altimate-code supports the Model Context Protocol (MCP) for connecting to external tool servers.

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
| `headers` | `object` | Custom HTTP headers |
| `enabled` | `boolean` | Enable/disable (default: `true`) |
| `oauth` | `object \| false` | OAuth configuration |
| `timeout` | `number` | Timeout in ms (default: `5000`) |

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

```bash
# List configured MCP servers
altimate-code mcp

# Test a server connection
altimate-code mcp test my-tools
```

## Experimental Settings

```json
{
  "experimental": {
    "mcp_timeout": 10000
  }
}
```
