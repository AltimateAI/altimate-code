# Models

altimate supports models from all configured providers. Use the `model` and `small_model` fields to set defaults.

## Configuration

```json
{
  "model": "anthropic/claude-sonnet-4-6",
  "small_model": "anthropic/claude-haiku-4-5-20251001"
}
```

The model format is `provider/model-name`.

## Browsing Models

In the TUI:

| Action | Method |
|--------|--------|
| List all models | `/models` command |
| Model picker | Leader + `m` |
| Filter by provider | Leader + `Shift+M` |

## Model Variants

Some providers offer model variants (e.g., different context lengths or capabilities):

```json
{
  "agent": {
    "analyst": {
      "model": "anthropic/claude-sonnet-4-6",
      "variant": "extended-thinking"
    }
  }
}
```

Cycle through variants in the TUI with the variant cycle keybind.

## Per-Agent Models

Set different models for different agents:

```json
{
  "model": "anthropic/claude-sonnet-4-6",
  "agent": {
    "analyst": {
      "model": "anthropic/claude-haiku-4-5-20251001"
    },
    "builder": {
      "model": "anthropic/claude-opus-4-6"
    }
  }
}
```

!!! tip
    Use a fast, inexpensive model for the `analyst` agent (which runs many read-only queries) and a more capable model for the `builder` agent (which produces code).

## Favorites

Mark models as favorites for quick cycling with the TUI keybind (leader + `Shift+F`).

## Model Format Reference

Models are referenced as `provider/model-name`:

| Provider | Example Model |
|----------|--------------|
| Anthropic | `anthropic/claude-sonnet-4-6` |
| OpenAI | `openai/gpt-4o` |
| AWS Bedrock | `bedrock/anthropic.claude-sonnet-4-6-v1` |
| Azure | `azure/gpt-4o` |
| Google | `google/gemini-2.5-pro` |
| Ollama | `ollama/llama3.1` |
| OpenRouter | `openrouter/anthropic/claude-sonnet-4-6` |
| Copilot | `copilot/gpt-4o` |
| Snowflake Cortex | `snowflake-cortex/claude-sonnet-4-6` |
| Custom | `my-provider/my-model` |

See [Providers](providers.md) for full provider configuration details.
