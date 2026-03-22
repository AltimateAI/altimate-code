---
description: "Install altimate-code and run your first SQL analysis. The open-source data engineering harness with 100+ tools for building, validating, optimizing, and shipping data products."
---

# Quickstart

> **You need:** npm 8+. An API key for any supported LLM provider.

---

## Step 1: Install

```bash
npm install -g altimate-code
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
  "local": {
    "type": "duckdb",
    "database": "~/.altimate/local.duckdb"
  }
}
```

---

## Step 4: Verify It Works

In the TUI, type a simple prompt to confirm everything is connected:

```
What SQL anti-patterns does this query have: SELECT * FROM orders o JOIN customers c ON o.id = c.order_id WHERE UPPER(c.name) = 'ACME'
```

If you connected a warehouse with `/discover`, try:

```
Show me the tables in my warehouse
```

If you have a dbt project, try:

```
Scan my dbt project and summarize the models
```

---

## Step 5: Explore Data Engineering Features

Once basics are working, explore these commands:

| Command | What it does |
|---------|-------------|
| `/sql-review` | Review SQL for correctness, performance, and best practices |
| `/cost-report` | Analyze warehouse spending and find optimization opportunities |
| `/dbt-docs` | Generate or improve dbt model documentation |
| `/generate-tests` | Auto-generate dbt tests for your models |
| `/migrate-sql` | Translate SQL between warehouse dialects |
| `/ci-check` | Run pre-merge SQL quality validation on changed files |
| `/train @docs/style-guide.md` | Import team standards from documentation |

**Pro tip:** Use `impact_analysis` before making breaking changes to understand which downstream dbt models will be affected.

---

## What's Next

- [Full Setup](getting-started.md): All warehouse configs, LLM providers, advanced setup
- [Agent Modes](data-engineering/agent-modes.md): Choose the right agent for your task
- [CI & Automation](data-engineering/guides/ci-headless.md): Run altimate in automated pipelines
- Train your AI teammate: Use `/teach` and `/train` to build team-specific knowledge that persists across sessions
