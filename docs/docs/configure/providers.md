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

## Altimate LLM Gateway

Managed LLM access with dynamic routing across Sonnet 4.6, Opus 4.6, GPT-5.4, GPT-5.3, and more. No API keys to manage — 10M tokens free to get started.

```json
{
  "provider": {
    "altimate": {}
  },
  "model": "altimate/auto"
}
```

For pricing, security, and data handling details, see the [Altimate LLM Gateway guide](https://datamates-docs.myaltimate.com/user-guide/components/llm-gateway/).

!!! tip "Automatic model selection"
    When Altimate credentials are configured and no model is explicitly chosen, the Altimate LLM Gateway is selected automatically. You can override this by setting `model` in your config or by restricting the `provider` section to specific providers only.

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

## Amazon Bedrock

```json
{
  "provider": {
    "amazon-bedrock": {
      "options": {
        "region": "us-east-1"
      }
    }
  },
  "model": "amazon-bedrock/anthropic.claude-sonnet-4-6-v1"
}
```

Uses the standard AWS credential chain: environment variables (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`), named profiles (`AWS_PROFILE`), SSO sessions, IAM roles, and container credentials.

!!! note
    If you have AWS SSO, IAM roles, or environment credentials (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) configured, Bedrock will use your default credential chain automatically.

### Custom Endpoints (API Gateways)

If your organization routes Bedrock traffic through a custom API gateway or proxy, set the `baseURL` in the provider options:

```json
{
  "provider": {
    "amazon-bedrock": {
      "options": {
        "baseURL": "https://your-gateway.example.com/v1",
        "region": "us-east-1"
      }
    }
  },
  "model": "amazon-bedrock/anthropic.claude-sonnet-4-6-v1"
}
```

For a complete walkthrough — including bearer token authentication, cross-region model IDs, and troubleshooting — see the [Amazon Bedrock Custom Endpoints guide](bedrock-custom-endpoints.md).

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

!!! note "Codespaces & GitHub Actions"
    In GitHub Codespaces and GitHub Actions, the machine-scoped `GITHUB_TOKEN` lacks `models:read` permission and cannot be used for GitHub Copilot or GitHub Models inference. altimate automatically skips these providers in machine environments. To use them, authenticate explicitly with `altimate auth` or set a personal access token with `models:read` scope as a Codespace secret.

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
| `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-sonnet-4-5`, `claude-opus-4-5`, `claude-haiku-4-5`, `claude-4-sonnet`, `claude-3-7-sonnet`, `claude-3-5-sonnet` | Yes |
| `openai-gpt-4.1`, `openai-gpt-5`, `openai-gpt-5.1`, `openai-gpt-5.2`, `openai-gpt-5-mini`, `openai-gpt-5-nano`, `openai-gpt-5-chat` | Yes |
| `llama4-maverick`, `llama4-scout`, `llama3.3-70b`, `snowflake-llama-3.3-70b`, `snowflake-llama-3.1-405b`, `llama3.1-70b`, `llama3.1-405b`, `llama3.1-8b` | No |
| `mistral-large`, `mistral-large2`, `mistral-7b`, `mixtral-8x7b` | No |
| `deepseek-r1`, `gemini-3.1-pro` | No |

!!! note
    Model availability depends on your Snowflake region. Enable cross-region inference with `ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION'` for full model access.

### Adding a model not in the list

Snowflake Cortex adds models faster than this list can be updated. If a model is available on your Cortex account but not yet listed above, you can register it locally without forking the CLI — add it under `provider["snowflake-cortex"].models` in your `altimate-code.json` (or `.altimate-code/altimate-code.json`):

```json
{
  "provider": {
    "snowflake-cortex": {
      "models": {
        "your-new-model-id": {
          "name": "Your New Model",
          "limit": { "context": 200000, "output": 32000 },
          "tool_call": true
        }
      }
    }
  }
}
```

The entry merges with the built-in list, so the model appears in the picker and can be selected as `snowflake-cortex/your-new-model-id`. Set `"tool_call": false` for models that don't support tools on Cortex (Llama, Mistral, DeepSeek, Gemini today) — otherwise requests with tools will fail.

The `tool_call` field uses snake_case (matching the rest of the `altimate-code.json` schema) and maps to the picker's `capabilities.toolcall`. The request transform reads the same value, so a user-added model marked `tool_call: true` keeps `tools` and `tool_choice` in outgoing requests — and one marked `tool_call: false` has them stripped, the same as the built-in non-tool entries.

## Databricks AI Gateway

Connect to Databricks serving endpoints (Foundation Model APIs) via your workspace PAT. Use Databricks-hosted Llama, Claude, GPT, Gemini, DBRX, or Mixtral for agent reasoning — billing flows through your Databricks account.

```json
{
  "provider": {
    "databricks": {}
  },
  "model": "databricks/databricks-claude-sonnet-4-6"
}
```

Authenticate with `altimate auth databricks` and enter credentials as `workspace-host::pat-token`:

```text
myworkspace.cloud.databricks.com::dapi1234567890abcdef
```

Or set environment variables:

```bash
export DATABRICKS_HOST=myworkspace.cloud.databricks.com
export DATABRICKS_TOKEN=dapi1234567890abcdef
```

Create a PAT in Databricks: **Settings → Developer → Access Tokens → Generate New Token**.

**Supported workspace domains:** `*.cloud.databricks.com` (AWS), `*.azuredatabricks.net` (Azure), `*.gcp.databricks.com` (GCP).

**Available models:**

| Provider | Models |
|----------|--------|
| Meta Llama | `databricks-meta-llama-3-1-405b-instruct`, `databricks-meta-llama-3-1-70b-instruct`, `databricks-meta-llama-3-1-8b-instruct` |
| Anthropic via Databricks | `databricks-claude-sonnet-4-6`, `databricks-claude-opus-4-6` |
| OpenAI via Databricks | `databricks-gpt-5-4`, `databricks-gpt-5-mini` |
| Google via Databricks | `databricks-gemini-3-1-pro` |
| Databricks native | `databricks-dbrx-instruct` |
| Mistral (tool calls unsupported) | `databricks-mixtral-8x7b-instruct` |

!!! note
    Databricks bills directly for these models — altimate-code reports `$0` cost for Databricks-routed requests since pricing depends on your Databricks contract.

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
| `options.region` | `string` | AWS region (Amazon Bedrock only, default: `us-east-1`) |
| `options.profile` | `string` | AWS named profile (Amazon Bedrock only) |
| `options.baseURL` | `string` | Custom endpoint URL for Bedrock gateway/proxy (Amazon Bedrock only) |
| `project` | `string` | GCP project ID (Google Vertex AI only) |
| `location` | `string` | GCP region (Google Vertex AI only, default: `us-central1`) |
