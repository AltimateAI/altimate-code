# altimate-code

**The data engineering agent for dbt, SQL, and cloud warehouses.**

altimate-code is an AI-powered CLI agent with 55+ specialized tools for SQL analysis, schema inspection, column-level lineage, FinOps, and RBAC. It connects to your warehouse, understands your data, and helps you write better SQL, cut costs, and ship faster.

---

## What makes it different

Unlike general-purpose coding agents, altimate-code is built for data teams:

| Capability | General coding agents | altimate-code |
|---|---|---|
| SQL anti-pattern detection | None | 19 rules with confidence scoring |
| Column-level lineage | None | Automatic from SQL |
| Cost prediction | None | 4-tier system trained on your query history |
| Schema-aware autocomplete | None | Indexes your warehouse metadata |
| Cross-dialect translation | None | Snowflake, BigQuery, Databricks, Redshift |
| FinOps analysis | None | Credit analysis, expensive queries, warehouse sizing |
| PII detection | None | Automatic column scanning |
| dbt integration | Basic file editing | Manifest parsing, test generation, model scaffolding |

## Quick start

```bash
# Install
npm install -g @altimateai/altimate-code

# Launch the TUI
altimate-code

# Or run with a specific model
altimate-code --model claude-sonnet-4-6
```

On first launch, run `/connect` to set up your LLM provider and warehouse connections.

## Choose your agent mode

| Mode | Purpose | Permissions |
|---|---|---|
| **Builder** | Create dbt models, SQL pipelines, data transformations | Full read/write |
| **Analyst** | Explore data, run SELECT queries, generate insights | Read-only (enforced) |
| **Validator** | Data quality checks, schema validation, test coverage | Read + validate |
| **Migrator** | Cross-warehouse SQL translation and migration | Read/write for migration |

```bash
# Start in analyst mode (read-only, safe for production)
altimate-code --agent analyst
```

## Works with any LLM

altimate-code is model-agnostic. Use it with:

- **Anthropic** (Claude Opus, Sonnet, Haiku)
- **OpenAI / Codex** (GPT-4o, GPT-5, Codex subscription)
- **Google** (Gemini Pro, Flash)
- **AWS Bedrock** / **Azure OpenAI**
- **Ollama** (local models)
- **OpenRouter** (150+ models)
- Any OpenAI-compatible API

## Supported warehouses

- Snowflake (password + key-pair auth)
- BigQuery (service account + ADC)
- Databricks (PAT + Unity Catalog)
- PostgreSQL
- Redshift
- DuckDB (local development)
- MySQL
- SQL Server

## Documentation

| Section | Description |
|---------|------------|
| [Getting Started](getting-started.md) | Installation, first run, warehouse configuration |
| [Usage](usage/tui.md) | TUI, CLI, web UI, IDE, and CI/CD integration |
| [Configure](configure/config.md) | Configuration, providers, tools, agents, themes, keybinds |
| [Data Engineering](data-engineering/agent-modes.md) | Agent modes, SQL/schema/FinOps/lineage/dbt tools, guides |
| [Develop](develop/sdk.md) | SDK, server API, plugins, ecosystem |
| [Troubleshooting](troubleshooting.md) | Logs, common issues, debug mode |

---

!!! note
    altimate-code is your cost advocate. Every tool is designed to minimize unnecessary warehouse spend. Cost prediction runs before every query, anti-patterns that burn credits are flagged automatically, and cheaper alternatives are always suggested.
