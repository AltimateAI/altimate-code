# Web

altimate includes a web-based interface for browser access.

```bash
altimate web
```

## Configuration

Configure the web server in `altimate-code.json`:

```json
{
  "server": {
    "port": 3000,
    "hostname": "localhost",
    "cors": ["https://myapp.example.com"],
    "mdns": true,
    "mdnsDomain": "altimate-code.local"
  }
}
```

| Option | Default | Description |
|--------|---------|------------|
| `port` | 3000 | HTTP port |
| `hostname` | `localhost` | Bind address |
| `cors` | `[]` | Allowed CORS origins |
| `mdns` | `false` | Enable mDNS discovery |
| `mdnsDomain` | — | Custom mDNS domain |

## Authentication

Set basic auth credentials:

```bash
export ALTIMATE_CLI_SERVER_USERNAME=admin
export ALTIMATE_CLI_SERVER_PASSWORD=secret
altimate web
```

## Features

The web UI provides the same conversational interface as the TUI:

- Full chat interface with streaming responses
- File references and tool call results
- Agent switching
- Session management

!!! note
    The web UI is the general-purpose agent interface. For data-engineering-specific UIs, see the [Data Engineering guides](../data-engineering/guides/index.md).
