<div align="center">

<img src="docs/docs/assets/images/altimate-code-banner.png" alt="altimate-code" width="600" />

**The data engineering agent for dbt, SQL, and cloud warehouses.**

An AI-powered CLI with 99+ specialized tools — SQL analysis, schema inspection,
column-level lineage, FinOps, PII detection, and data visualization. Connects to your warehouse,
understands your data, and helps you ship faster.

[![npm](https://img.shields.io/npm/v/@altimateai/altimate-code)](https://www.npmjs.com/package/@altimateai/altimate-code)
[![PyPI](https://img.shields.io/pypi/v/altimate-engine)](https://pypi.org/project/altimate-engine/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/AltimateAI/altimate-code/actions/workflows/ci.yml/badge.svg)](https://github.com/AltimateAI/altimate-code/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-altimate--code.sh-blue)](https://altimate.ai)

</div>

---

## Why altimate?

General-purpose coding agents can write SQL, but they don't *understand* it. They can't trace lineage, detect anti-patterns, check PII exposure, or optimize warehouse costs — because they don't have the tools.

altimate is a fork of [OpenCode](https://github.com/anomalyco/opencode) rebuilt for data teams. It gives any LLM access to 99+ specialized data engineering tools, 12 purpose-built skills, and direct warehouse connectivity — so the AI works with your actual schemas, not guesses.

## General agents vs altimate

| Capability | General coding agents | altimate |
|---|---|---|
| SQL anti-pattern detection | None | 19 rules with confidence scoring |
| Column-level lineage | None | Automatic from SQL |
| Schema-aware autocomplete | None | Indexes your warehouse metadata |
| Cross-dialect translation | None | Snowflake, BigQuery, Databricks, Redshift |
| FinOps analysis | None | Credit analysis, expensive queries, warehouse sizing |
| PII detection | None | Automatic column scanning |
| dbt integration | Basic file editing | Manifest parsing, test generation, model scaffolding |
| Data visualization | None | Auto-generated charts from SQL results |
| Observability | None | Local-first tracing of AI sessions and tool calls |

## Quick demo

```bash
# Auto-detect your data stack (dbt projects, warehouse connections, installed tools)
> /discover

# Analyze a query for anti-patterns and optimization opportunities
> Analyze this query for issues: SELECT * FROM orders JOIN customers ON orders.id = customers.order_id

# Translate SQL across dialects
> /sql-translate this Snowflake query to BigQuery: SELECT DATEADD(day, 7, current_date())

# Generate dbt tests for a model
> /generate-tests for models/staging/stg_orders.sql

# Get a cost report for your Snowflake account
> /cost-report
```

## Key Features

### SQL Anti-Pattern Detection
19 rules with confidence scoring — catches SELECT *, cartesian joins, non-sargable predicates, correlated subqueries, and more. **100% accuracy** on 1,077 benchmark queries.

### Column-Level Lineage
Automatic lineage extraction from SQL. Trace any column back through joins, CTEs, and subqueries to its source. Works standalone or with dbt manifests for project-wide lineage. **100% edge match** on 500 benchmark queries.

### FinOps & Cost Analysis
Credit analysis, expensive query detection, warehouse right-sizing, unused resource cleanup, and RBAC auditing.

### Cross-Dialect Translation
Transpile SQL between Snowflake, BigQuery, Databricks, Redshift, PostgreSQL, MySQL, SQL Server, and DuckDB.

### PII Detection & Safety
Automatic column scanning for PII across 15 categories with 30+ regex patterns. Safety checks and policy enforcement before query execution.

### dbt Native
Manifest parsing, test generation, model scaffolding, incremental model detection, and lineage-aware refactoring. 12 purpose-built skills including medallion patterns, yaml config generation, and dbt docs.

### Data Visualization
Interactive charts and dashboards from SQL results. The data-viz skill generates publication-ready visualizations with automatic chart type selection based on your data.

### Local-First Tracing
Built-in observability for AI interactions — trace tool calls, token usage, and session activity locally. No external services required. View traces with `altimate trace`.

### AI Teammate Training
Teach your AI teammate project-specific patterns, naming conventions, and best practices. The training system learns from examples and applies rules automatically across sessions.

## Install

```bash
# npm (recommended)
npm install -g @altimateai/altimate-code

# Homebrew
brew install AltimateAI/tap/altimate-code
```

Then:

```bash
altimate              # Launch the interactive TUI
altimate /discover    # Auto-detect your data stack and go
```

> **Note:** `altimate-code` still works as a backward-compatible alias.

`/discover` auto-detects dbt projects, warehouse connections (from `~/.dbt/profiles.yml`, Docker, environment variables), and installed tools (dbt, sqlfluff, airflow, dagster, and more).

## Agent Modes

Each agent has scoped permissions and purpose-built tools for its role.

| Agent | Role | Access |
|---|---|---|
| **Builder** | Create dbt models, SQL pipelines, and data transformations | Full read/write |
| **Analyst** | Explore data, run SELECT queries, and generate insights | Read-only enforced |
| **Validator** | Data quality checks, schema validation, test coverage analysis | Read + validate |
| **Migrator** | Cross-warehouse SQL translation, schema migration, dialect conversion | Read/write for migrations |
| **Executive** | Business-audience summaries — translates findings into revenue, cost, and compliance impact | Read-only |

## Supported Warehouses

Snowflake · BigQuery · Databricks · PostgreSQL · Redshift · DuckDB · MySQL · SQL Server

First-class support with schema indexing, query execution, and metadata introspection. SSH tunneling available for secure connections.

## Works with Any LLM

Model-agnostic — bring your own provider or run locally.

Anthropic · OpenAI · Google Gemini · Google Vertex AI · Amazon Bedrock · Azure OpenAI · Mistral · Groq · DeepInfra · Cerebras · Cohere · Together AI · Perplexity · xAI · OpenRouter · Ollama · GitHub Copilot

## Architecture

```
altimate (TypeScript CLI)
        |
   JSON-RPC 2.0 (stdio)
        |
altimate-engine (Python)
   SQL analysis, lineage, dbt, warehouse connections
```

The CLI handles AI interactions, TUI, and tool orchestration. The Python engine handles SQL parsing, analysis, lineage computation, and warehouse interactions via a JSON-RPC bridge.

**Zero-dependency bootstrap**: On first run the CLI downloads [`uv`](https://github.com/astral-sh/uv), creates an isolated Python environment, and installs the engine with all warehouse drivers automatically. No system Python required.

### Monorepo structure

```
packages/
  altimate-code/       TypeScript CLI
  altimate-engine/     Python engine (SQL, lineage, warehouses)
  plugin/              Plugin system
  sdk/js/              JavaScript SDK
  util/                Shared utilities
```

## Documentation

Full docs at **[altimate.ai](https://altimate.ai)**.

- [Getting Started](https://altimate.ai/getting-started/)
- [SQL Tools](https://altimate.ai/data-engineering/tools/sql-tools/)
- [Agent Modes](https://altimate.ai/data-engineering/agent-modes/)
- [Configuration](https://altimate.ai/configure/model-providers/)

## Community & Contributing

- **Issues**: [GitHub Issues](https://github.com/AltimateAI/altimate-code/issues)
- **Discussions**: [GitHub Discussions](https://github.com/AltimateAI/altimate-code/discussions)
- **Security**: See [SECURITY.md](./SECURITY.md)

Contributions welcome! Please read the [Contributing Guide](./CONTRIBUTING.md) before opening a PR.

```bash
git clone https://github.com/AltimateAI/altimate-code.git
cd altimate-code
bun install
cd packages/altimate-engine && python -m venv .venv && source .venv/bin/activate && pip install -e ".[dev]"
```

## Acknowledgements

altimate is a fork of [OpenCode](https://github.com/anomalyco/opencode), the open-source AI coding agent. We build on top of their excellent foundation to add data-team-specific capabilities.

## License

MIT — see [LICENSE](./LICENSE).
