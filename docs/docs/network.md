# Network

Configure network settings for proxied or restricted environments.

## HTTP Proxy

Set the `HTTPS_PROXY` environment variable:

```bash
export HTTPS_PROXY=http://proxy.example.com:8080
altimate
```

Also supports `HTTP_PROXY` and `NO_PROXY`:

```bash
export HTTPS_PROXY=http://proxy.example.com:8080
export NO_PROXY=localhost,127.0.0.1,.internal.com
```

## Custom CA Certificates

For environments with custom certificate authorities:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/ca-bundle.crt
altimate
```

This is common in corporate environments with TLS inspection.

## Firewall Requirements

altimate needs outbound HTTPS access to:

| Destination | Purpose |
|-------------|---------|
| Your LLM provider API | Model inference (Anthropic, OpenAI, etc.) |
| `registry.npmjs.org` | Package updates |
| `models.dev` | Model catalog (can be disabled) |
| Your warehouse endpoints | Database connections |

### Disable Model Fetching

If `models.dev` is unreachable:

```bash
export ALTIMATE_CLI_DISABLE_MODELS_FETCH=true
```

Or provide a local models file:

```bash
export ALTIMATE_CLI_MODELS_PATH=/path/to/models.json
```
