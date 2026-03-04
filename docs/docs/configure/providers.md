# Providers

altimate supports 35+ LLM providers. Configure them in the `provider` section of your config file.

## Provider Configuration

Each provider has a key in the `provider` object:

```json
{
  "provider": {
    "<provider-name>": {
      "apiKey": "{env:API_KEY}",
      "baseURL": "https://custom.endpoint.com/v1",
      "headers": {
        "X-Custom-Header": "value"
      }
    }
  }
}
```

!!! tip
    Use `{env:...}` substitution for API keys so you never commit secrets to version control.

## Anthropic

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

Available models: `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`

## OpenAI

```json
{
  "provider": {
    "openai": {
      "apiKey": "{env:OPENAI_API_KEY}"
    }
  },
  "model": "openai/gpt-4o"
}
```

## AWS Bedrock

```json
{
  "provider": {
    "bedrock": {
      "region": "us-east-1",
      "accessKeyId": "{env:AWS_ACCESS_KEY_ID}",
      "secretAccessKey": "{env:AWS_SECRET_ACCESS_KEY}"
    }
  },
  "model": "bedrock/anthropic.claude-sonnet-4-6-v1"
}
```

Uses the standard AWS credential chain. Set `AWS_PROFILE` or provide credentials directly.

!!! note
    If you have AWS SSO or IAM roles configured, Bedrock will use your default credential chain automatically — no explicit keys needed.

## Azure OpenAI

```json
{
  "provider": {
    "azure": {
      "apiKey": "{env:AZURE_OPENAI_API_KEY}",
      "baseURL": "https://your-resource.openai.azure.com/openai/deployments/your-deployment"
    }
  },
  "model": "azure/gpt-4o"
}
```

## Google (Gemini)

```json
{
  "provider": {
    "google": {
      "apiKey": "{env:GOOGLE_API_KEY}"
    }
  },
  "model": "google/gemini-2.5-pro"
}
```

## Ollama (Local)

```json
{
  "provider": {
    "ollama": {
      "baseURL": "http://localhost:11434"
    }
  },
  "model": "ollama/llama3.1"
}
```

No API key needed — runs entirely on your local machine.

!!! info
    Make sure Ollama is running before starting altimate. Install it from [ollama.com](https://ollama.com) and pull your desired model with `ollama pull llama3.1`.

## OpenRouter

```json
{
  "provider": {
    "openrouter": {
      "apiKey": "{env:OPENROUTER_API_KEY}"
    }
  },
  "model": "openrouter/anthropic/claude-sonnet-4-6"
}
```

Access 150+ models through a single API key.

## Copilot

```json
{
  "provider": {
    "copilot": {}
  },
  "model": "copilot/gpt-4o"
}
```

Uses your GitHub Copilot subscription. Authenticate with `altimate auth`.

## Custom / OpenAI-Compatible

Any OpenAI-compatible endpoint can be used as a provider:

```json
{
  "provider": {
    "my-provider": {
      "api": "openai",
      "baseURL": "https://my-llm-proxy.example.com/v1",
      "apiKey": "{env:MY_API_KEY}"
    }
  },
  "model": "my-provider/my-model"
}
```

!!! tip
    This works with any service that exposes an OpenAI-compatible chat completions API, including vLLM, LiteLLM, and self-hosted inference servers.

## Model Selection

Set your default model and a smaller model for lightweight tasks:

```json
{
  "model": "anthropic/claude-sonnet-4-6",
  "small_model": "anthropic/claude-haiku-4-5-20251001"
}
```

The `small_model` is used for lightweight tasks like summarization and context compaction.

## Provider Options Reference

| Field | Type | Description |
|-------|------|-------------|
| `apiKey` | `string` | API key (supports `{env:...}` and `{file:...}`) |
| `baseURL` | `string` | Custom API endpoint URL |
| `api` | `string` | API type (e.g., `"openai"` for compatible endpoints) |
| `headers` | `object` | Custom HTTP headers to include with requests |
| `region` | `string` | AWS region (Bedrock only) |
| `accessKeyId` | `string` | AWS access key (Bedrock only) |
| `secretAccessKey` | `string` | AWS secret key (Bedrock only) |
