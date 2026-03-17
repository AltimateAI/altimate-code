<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/docs/assets/images/altimate-code-banner.png" />
  <img src="docs/docs/assets/images/altimate-code-banner.png" alt="altimate-code" width="600" />
</picture>

**The open-source data engineering harness.**

99+ tools for building, validating, optimizing, and shipping data products.<br>
Use in your terminal, CI pipeline, orchestration DAGs, or as the tool layer for your data agents.

[![npm](https://img.shields.io/npm/v/@altimateai/altimate-code)](https://www.npmjs.com/package/@altimateai/altimate-code)
[![npm downloads](https://img.shields.io/npm/dm/@altimateai/altimate-code)](https://www.npmjs.com/package/@altimateai/altimate-code)
[![PyPI](https://img.shields.io/pypi/v/altimate-engine)](https://pypi.org/project/altimate-engine/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/AltimateAI/altimate-code/actions/workflows/ci.yml/badge.svg)](https://github.com/AltimateAI/altimate-code/actions/workflows/ci.yml)
[![Discord](https://img.shields.io/discord/YOUR_DISCORD_SERVER_ID?logo=discord&label=Discord&color=5865F2)](https://altimate.ai/discord)
[![Docs](https://img.shields.io/badge/docs-altimateai.github.io-blue)](https://altimateai.github.io/altimate-code)

</div>

---

## Install

```bash
# npm (recommended)
npm install -g @altimateai/altimate-code

# Homebrew
brew install AltimateAI/tap/altimate-code
```

Then — in order:

**Step 1: Configure your LLM provider** (required before anything works):
```bash
altimate        # Launch the TUI
/connect        # Interactive setup — choose your provider and enter your API key
```

> **No API key?** Select **Codex** in the `/connect` menu — it's built-in and requires no setup.

Or set an environment variable directly:
```bash
export ANTHROPIC_API_KEY= <Enter your Anthropic API Key>   # Anthropic Claude
export OPENAI_API_KEY= <Enter your OpenAI API Key>          # OpenAI
```

**Step 2: Auto-detect your data stack** (read-only, safe for production connections):
```bash
altimate /discover
```

> **Zero Python setup required.** On first run, the CLI automatically downloads [`uv`](https://github.com/astral-sh/uv), creates an isolated Python environment, and installs the data engine with all warehouse drivers. No `pip install`, no virtualenv management.

> **Note:** `altimate-code` still works as a backward-compatible alias.

`/discover` auto-detects dbt projects, warehouse connections (from `~/.dbt/profiles.yml`, Docker, environment variables), and installed tools (dbt, sqlfluff, airflow, dagster, and more).

## What's New

- **v0.4.1** (March 2026) — env-based skill selection, session caching, tracing improvements
- **v0.4.0** (Feb 2026) — data visualization skill, 99+ tools, training system
- **v0.3.x** — [See full changelog →](CHANGELOG.md)

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

> **Benchmark results:** 100% F1 score on SQL anti-pattern detection across 1,077 test queries (0 false positives, 0 false negatives). 100% edge-match on column-level lineage across 500 queries. [See methodology →](experiments/BENCHMARKS.md)

## Why altimate?

Data engineering has a precision problem. General AI assistants can *edit* SQL files. They cannot *understand* your data stack — not without first-class tools for analyzing it.

altimate gives any LLM a deterministic SQL Intelligence Engine: 19 analysis rules built from years of data engineering in the weeds, achieving 100% F1 accuracy across 1,077 benchmark queries. The engine doesn't guess — it parses, traces, and measures.

**What the harness provides:**
- **SQL Intelligence Engine** — deterministic SQL parsing and analysis (not LLM pattern matching). 19 rules, 100% F1, 0 false positives. Built for data engineers who've been burned by hallucinated SQL advice.
- **Column-Level Lineage** — automatic extraction from SQL across dialects. 100% edge-match on 500 benchmark queries.
- **Live Warehouse Intelligence** — indexed schemas, query history, and cost data from your actual warehouse. Not guesses.
- **dbt Native** — manifest parsing, test generation, model scaffolding, medallion patterns, impact analysis
- **FinOps** — credit consumption, expensive query detection, warehouse right-sizing, idle resource cleanup
- **PII Detection** — 15 categories, 30+ regex patterns, enforced pre-execution

**Works seamlessly with Claude Code and Codex.** altimate is the data engineering tool layer — use it standalone in your terminal, or mount it as the harness underneath whatever AI agent you already run. The two are complementary.

altimate is a fork of [OpenCode](https://github.com/anomalyco/opencode) rebuilt for data teams. Model-agnostic — bring your own LLM or run locally with Ollama.

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

## Agent Modes

Each agent has scoped permissions and purpose-built tools for its role.

| Agent | Role | Access |
|---|---|---|
| **Builder** | Create dbt models, SQL pipelines, and data transformations | Full read/write |
| **Analyst** | Explore data, run SELECT queries, and generate insights | Read-only enforced |
| **Validator** | Data quality checks, schema validation, test coverage analysis | Read + validate |
| **Migrator** | Cross-warehouse SQL translation, schema migration, dialect conversion | Read/write for migrations |
| **Researcher** | Deep-dive analysis, documentation research, and knowledge extraction | Read-only |
| **Trainer** | Teach project-specific patterns, naming conventions, and best practices | Read + write training data |
| **Executive** | Business-audience summaries — translates findings into revenue, cost, and compliance impact | Read-only |

> **New to altimate?** Start with **Analyst mode** — it's read-only and safe to run against production connections.

## Supported Warehouses

Snowflake · BigQuery · Databricks · PostgreSQL · Redshift · DuckDB · MySQL · SQL Server

First-class support with schema indexing, query execution, and metadata introspection. SSH tunneling available for secure connections.

## Works with Any LLM

Model-agnostic — bring your own provider or run locally.

Anthropic · OpenAI · Google Gemini · Google Vertex AI · Amazon Bedrock · Azure OpenAI · Mistral · Groq · DeepInfra · Cerebras · Cohere · Together AI · Perplexity · xAI · OpenRouter · Ollama · GitHub Copilot

> **No API key?** **Codex** is a built-in provider with no key required. Select it via `/connect` to start immediately.

## Skills

altimate ships with built-in skills for every common data engineering task — type `/` in the TUI to browse available skills and get autocomplete. No memorization required.

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
  opencode/            TypeScript CLI (upstream fork name preserved)
  altimate-engine/     Python engine (SQL, lineage, warehouses)
  plugin/              Plugin system
  sdk/                 SDKs (includes VS Code extension)
  util/                Shared utilities
```

## Community & Contributing

- **Discord**: [altimate.ai/discord](https://altimate.ai/discord) — Real-time chat for questions, showcases, and feature discussion
- **Issues**: [GitHub Issues](https://github.com/AltimateAI/altimate-code/issues) — Bug reports and feature requests
- **Discussions**: [GitHub Discussions](https://github.com/AltimateAI/altimate-code/discussions) — Long-form questions and proposals
- **Security**: See [SECURITY.md](./SECURITY.md) for responsible disclosure

Contributions welcome — docs, SQL rules, warehouse connectors, and TUI improvements are all needed. The contributing guide covers setup, the vouch system, and the issue-first PR policy.

**[Read CONTRIBUTING.md →](./CONTRIBUTING.md)**

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgements

altimate is a fork of [OpenCode](https://github.com/anomalyco/opencode), the open-source AI coding agent. We build on top of their excellent foundation to add data-team-specific capabilities.
