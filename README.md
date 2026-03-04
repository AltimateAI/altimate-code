<div align="center">

# altimate-code

**The AI coding agent for data teams.**

Batteries included for SQL, dbt, and data warehouses.

[![npm](https://img.shields.io/npm/v/@altimateai/altimate-code)](https://www.npmjs.com/package/@altimateai/altimate-code)
[![PyPI](https://img.shields.io/pypi/v/altimate-engine)](https://pypi.org/project/altimate-engine/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/AltimateAI/altimate-code/actions/workflows/ci.yml/badge.svg)](https://github.com/AltimateAI/altimate-code/actions/workflows/ci.yml)

</div>

---

An AI coding agent with 40+ specialized data tools, column-level lineage, dbt integration, and warehouse connectivity built in -- all available to any AI provider.

## Install

```bash
# npm
npm i -g @altimateai/altimate-code

# Homebrew
brew install AltimateAI/tap/altimate-code
```

Then run `altimate-code` to launch the interactive TUI, or `altimate-code run "your prompt"` for one-shot mode.

## Highlights

| Capability | Details |
|---|---|
| **SQL analysis** | 40+ tools -- lint, format, transpile, optimize, safety checks |
| **Column-level lineage** | Trace data flow through complex SQL and dbt models |
| **dbt integration** | Manifest parsing, profile management, `+` operator |
| **Warehouse connectivity** | Snowflake, BigQuery, Redshift, Databricks, Postgres, DuckDB, MySQL, SQL Server |
| **PII detection** | Classify sensitive columns, flag risky queries |
| **Query cost prediction** | Estimate execution costs before running |
| **FinOps** | Credit analysis, query history insights |
| **AI providers** | 15+ providers -- Anthropic, OpenAI, Gemini, Bedrock, and more |
| **TUI + headless** | Interactive terminal UI or `altimate-code serve` for CI/CD |
| **MCP + LSP** | Model Context Protocol and Language Server Protocol support |

## Features

### SQL Analysis (40+ tools)

The AI has access to specialized SQL tools that go far beyond what a general coding agent can do:

- **Lint & validate** -- Catch anti-patterns like implicit casts, NULL comparisons, unused CTEs
- **Format** -- Consistent SQL formatting across your team
- **Transpile** -- Convert between Snowflake, BigQuery, Postgres, T-SQL, MySQL, DuckDB
- **Optimize** -- Get index suggestions, query rewrites, complexity reduction
- **Safety checks** -- Detect breaking changes, SQL injection risks, schema violations
- **Test generation** -- Auto-generate SQL tests for your models
- **Equivalence checking** -- Verify two queries produce the same results

### Column-Level Lineage

Trace data flow at the column level through complex SQL transformations. Works standalone or with dbt manifests for project-wide lineage across models.

### dbt Integration

- Parse `manifest.json` and `profiles.yml` natively
- Column-level lineage across dbt models with `+` operator for upstream/downstream selection
- Execute dbt commands (compile, run, test) directly from the agent
- Profile management across environments

### Warehouse Connectivity

Connect directly to your data warehouse -- the AI can query schemas, run SQL, and analyze query history:

- Snowflake (with IAM auth)
- BigQuery (service account + ADC)
- Redshift (with IAM auth)
- Databricks
- PostgreSQL
- DuckDB
- MySQL
- SQL Server
- SSH tunneling for secure connections

### AI Providers

Use any model you want. altimate-code supports 15+ providers via the Vercel AI SDK:

Anthropic, OpenAI, Google Gemini, Google Vertex AI, Amazon Bedrock, Azure OpenAI, Mistral, Groq, DeepInfra, Cerebras, Cohere, Together AI, Perplexity, xAI, OpenRouter, GitHub Copilot, GitLab

### And more

- Interactive TUI with Solid.js + OpenTUI
- Headless server mode (`altimate-code serve`)
- MCP server support (stdio, HTTP, SSE transports)
- LSP integration (workspace symbols, diagnostics)
- Session management (continue, fork, export/import)
- Custom agents and plugins
- GitHub integration (PR analysis, automated workflows)
- Token usage stats and cost tracking

## Architecture

```
altimate-code (TypeScript CLI)
        |
   JSON-RPC 2.0 (stdio)
        |
altimate-engine (Python)
   SQL analysis, lineage, dbt, warehouse connections
```

The CLI handles AI interactions, TUI, and tool orchestration. The Python engine handles SQL parsing, analysis, lineage computation, and warehouse interactions via a JSON-RPC bridge.

**Zero-dependency bootstrap**: On first run the CLI downloads [`uv`](https://github.com/astral-sh/uv), creates an isolated Python environment, and installs the engine automatically. No system Python required.

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full setup guide.

```bash
git clone https://github.com/AltimateAI/altimate-code.git
cd altimate-code

# TypeScript
bun install
cd packages/altimate-code && bun test

# Python engine
cd packages/altimate-engine
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest
```

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

Full docs at [altimate-code.sh](https://altimate-code.sh).

## Contributing

Contributions welcome! Please read the [Contributing Guide](./CONTRIBUTING.md) before opening a PR.

## Acknowledgements

altimate-code is a fork of [opencode](https://github.com/anomalyco/opencode), the open-source AI coding agent. We build on top of their excellent foundation to add data-team-specific capabilities.

## License

MIT -- see [LICENSE](./LICENSE).
