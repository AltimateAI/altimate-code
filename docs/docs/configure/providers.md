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
    If you have AWS SSO or IAM roles configured, Bedrock will use your default credential chain automatically, so no explicit keys are needed.

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

## Google Vertex AI

```json
{
  "provider": {
    "google-vertex": {
      "project": "my-gcp-project",
      "location": "us-central1"
    }
  },
  "model": "google-vertex/gemini-2.5-pro"
}
```

Uses Google Cloud Application Default Credentials. Authenticate with:

```bash
gcloud auth application-default login
```

The `project` and `location` fields can also be set via environment variables:

| Field | Environment Variables (checked in order) |
|-------|----------------------------------------|
| `project` | `GOOGLE_CLOUD_PROJECT`, `GCP_PROJECT`, `GCLOUD_PROJECT` |
| `location` | `GOOGLE_VERTEX_LOCATION`, `GOOGLE_CLOUD_LOCATION`, `VERTEX_LOCATION` |

If `location` is not set, it defaults to `us-central1`.

!!! tip
    You can also access Anthropic models through Vertex AI using the `google-vertex` provider (e.g., `google-vertex/claude-sonnet-4-6`).

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

No API key needed. Runs entirely on your local machine.

!!! info
    Make sure Ollama is running before starting altimate. Install it from [ollama.com](https://ollama.com) and pull your desired model with `ollama pull llama3.1`.

## LM Studio (Local)

Run local models through [LM Studio](https://lmstudio.ai)'s OpenAI-compatible server:

```json
{
  "provider": {
    "lmstudio": {
      "name": "LM Studio",
      "npm": "@ai-sdk/openai-compatible",
      "env": ["LMSTUDIO_API_KEY"],
      "options": {
        "apiKey": "lm-studio",
        "baseURL": "http://localhost:1234/v1"
      },
      "models": {
        "qwen2.5-7b-instruct": {
          "name": "Qwen 2.5 7B Instruct",
          "tool_call": true,
          "limit": { "context": 131072, "output": 8192 }
        }
      }
    }
  },
  "model": "lmstudio/qwen2.5-7b-instruct"
}
```

**Setup:**

1. Open LM Studio → **Developer** tab → **Start Server** (default port: 1234)
2. Load a model in LM Studio
3. Find your model ID: `curl http://localhost:1234/v1/models`
4. Add the model ID to the `models` section in your config
5. Use it: `altimate-code run -m lmstudio/<model-id>`

!!! tip
    The model key in your config must match the model ID returned by LM Studio's `/v1/models` endpoint. If you change models in LM Studio, update the config to match.

!!! note
    If you changed LM Studio's default port, update the `baseURL` accordingly. No real API key is needed — the `"lm-studio"` placeholder satisfies the SDK requirement.

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

## Snowflake Cortex

```json
{
  "provider": {
    "snowflake-cortex": {}
  },
  "model": "snowflake-cortex/claude-sonnet-4-6"
}
```

Authenticate with `altimate auth snowflake-cortex` using a Programmatic Access Token (PAT). Enter credentials as `account-identifier::pat-token`.

Create a PAT in Snowsight: **Admin > Security > Programmatic Access Tokens**.

Billing flows through your Snowflake credits — no per-token costs.

**Available models:**

| Model | Tool Calling |
|-------|-------------|
| `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-sonnet-4-5`, `claude-opus-4-5`, `claude-haiku-4-5`, `claude-4-sonnet`, `claude-3-7-sonnet`, `claude-3-5-sonnet` | Yes |
| `openai-gpt-4.1`, `openai-gpt-5`, `openai-gpt-5-mini`, `openai-gpt-5-nano`, `openai-gpt-5-chat` | Yes |
| `llama4-maverick`, `snowflake-llama-3.3-70b`, `llama3.1-70b`, `llama3.1-405b`, `llama3.1-8b` | No |
| `mistral-large`, `mistral-large2`, `mistral-7b` | No |
| `deepseek-r1` | No |

!!! note
    Model availability depends on your Snowflake region. Enable cross-region inference with `ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION'` for full model access.

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
| `project` | `string` | GCP project ID (Google Vertex AI only) |
| `location` | `string` | GCP region (Google Vertex AI only, default: `us-central1`) |
