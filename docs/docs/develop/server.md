# Server

altimate includes an HTTP API server for remote access and integrations.

## Starting the Server

```bash
altimate serve
```

Or use the web UI (which includes the API):

```bash
altimate web
```

## Configuration

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

## Authentication

Set credentials via environment variables:

```bash
export ALTIMATE_CLI_SERVER_USERNAME=admin
export ALTIMATE_CLI_SERVER_PASSWORD=secret
altimate serve
```

The server uses HTTP Basic Authentication when credentials are set.

## API Endpoints

The server exposes REST endpoints for:

- **Sessions** — Create, list, delete sessions
- **Messages** — Send messages, stream responses
- **Models** — List available models
- **Agents** — List and switch agents
- **Tools** — Execute tools programmatically
- **Export/Import** — Session data management

Use the [SDK](sdk.md) for a typed client, or call the API directly.

## mDNS Discovery

Enable mDNS to discover altimate servers on your local network:

```json
{
  "server": {
    "mdns": true,
    "mdnsDomain": "altimate-code.local"
  }
}
```
