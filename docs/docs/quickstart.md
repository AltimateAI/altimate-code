---
description: "Install altimate-code and run your first SQL analysis. The open-source data engineering harness with 100+ tools for building, validating, optimizing, and shipping data products."
---

# Quickstart

> **You need:** npm 8+ or Homebrew. An API key for any supported LLM provider, or use Codex (built-in, no key required).

---

## Step 1: Install

```bash
# npm (recommended)
npm install -g altimate-code

# Homebrew
brew install AltimateAI/tap/altimate-code
```

> **Zero additional setup.** One command install.

---

## Step 2: Configure Your LLM

```bash
altimate        # Launch the TUI
/connect        # Choose your provider and enter your API key
```

Or set an environment variable:

```bash
export ANTHROPIC_API_KEY=your-key-here   # Anthropic Claude (recommended)
export OPENAI_API_KEY=your-key-here      # OpenAI
```

Minimal config file option (`altimate-code.json` in your project root):

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "your-key-here"
    }
  }
}
```

> **No API key?** Select **Codex** in the `/connect` menu. It's a built-in provider with no setup required.

---

## Step 3: Connect Your Warehouse _(Optional)_

> Skip this step if you want to work locally or don't need warehouse/orchestration connections. You can always run `/discover` later.

```bash
altimate /discover
```

Auto-detects your dbt projects, warehouse credentials, and installed tools. See [Full Setup](getting-started.md#step-3-configure-your-warehouse-optional) for details on what `/discover` finds and manual configuration options.

**No cloud warehouse?** Use DuckDB with a local file:

```json
{
  "connections": {
    "local": {
      "type": "duckdb",
      "database": "~/.altimate/local.duckdb"
    }
  }
}
```

---

## Step 4: Build Your First Artifact

In the TUI, try these prompts or describe your own use case:

```

Look at my snowflake account and do a comprehensive Analysis our Snowflake credit consumption over the last 30 days. After doing this generate a dashboard for my consumption.

```

```

Build me a real time, interactive dashboard for my macbook system metrics and health. Use python, iceberg, dbt for various time slices.

```

---

## What's Next

- [Full Setup](getting-started.md): All warehouse configs, LLM providers, advanced setup
- [Agent Modes](data-engineering/agent-modes.md): Choose the right agent for your task
- [CI & Automation](data-engineering/guides/ci-headless.md): Run altimate in automated pipelines
