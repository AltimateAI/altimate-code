---
description: "Install altimate-code and run your first SQL analysis in 5 minutes. The data engineering AI harness for dbt, Snowflake, BigQuery, and Databricks."
---

# Quickstart — 5 Minutes to Your First Result

> **You need:** npm 8+ or Homebrew. An API key for any supported LLM provider — or use Codex (built-in, no key required).

---

## Step 1 — Install (30 seconds)

```bash
# npm (recommended)
npm install -g @altimateai/altimate-code

# Homebrew
brew install AltimateAI/tap/altimate-code
```

> **Zero Python setup required.** On first run, the CLI automatically downloads `uv`, creates an isolated Python environment, and installs the data engine. No `pip install`, no virtualenv management.

---

## Step 2 — Configure Your LLM (1 minute)

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

> **No API key?** Select **Codex** in the `/connect` menu — it's a built-in provider with no setup required.

---

## Step 3 — Connect Your Warehouse (1 minute)

```bash
altimate /discover
```

`/discover` scans for dbt projects, warehouse credentials (from `~/.dbt/profiles.yml`, environment variables, and Docker), and installed tools. It **reads but never writes** — safe to run against production.

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

## Step 4 — Run Your First Query (30 seconds)

In the TUI, paste this prompt:

```
Analyze this query for anti-patterns: SELECT * FROM orders o, customers c WHERE o.customer_id = c.id AND c.region = 'US'
```

**Expected output:** The SQL Intelligence Engine returns identified anti-patterns (implicit cross join, SELECT *) with rule names, confidence scores, and suggested rewrites.

---

## What's Next

- [Full Setup Guide](getting-started.md) — All warehouse configs, LLM providers, advanced setup
- [Agent Modes](data-engineering/agent-modes.md) — Choose the right agent for your task
- [CI & Headless Mode](data-engineering/guides/ci-headless.md) — Run altimate in automated pipelines
