# altimate-code

AI-powered CLI for SQL analysis, dbt integration, and data engineering.

[![npm version](https://img.shields.io/npm/v/altimate-code-ai)](https://www.npmjs.com/package/altimate-code-ai)
[![PyPI version](https://img.shields.io/pypi/v/altimate-engine)](https://pypi.org/project/altimate-engine/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/AltimateAI/altimate-code/actions/workflows/ci.yml/badge.svg)](https://github.com/AltimateAI/altimate-code/actions/workflows/ci.yml)

## Features

- **SQL Analysis & Formatting** -- Parse, validate, and auto-format SQL across dialects
- **Column-Level Lineage** -- Trace data flow at the column level through complex SQL transformations
- **dbt Integration** -- Profile management, project-aware lineage, and `+` operator for upstream/downstream selection
- **Warehouse Connectivity** -- Connect to Snowflake, BigQuery, Databricks, Postgres, DuckDB, and MySQL
- **AI-Powered Code Review** -- Get intelligent suggestions on SQL quality, performance, and best practices
- **TUI Interface** -- Interactive terminal UI built with Solid.js
- **MCP Server** -- Model Context Protocol support for integration with AI assistants

## Quick Install

```bash
# npm
npm install -g @altimateai/altimate-code

# Homebrew
brew install altimate/tap/altimate-code
```

## Getting Started

```bash
# Launch the interactive TUI
altimate-code

# Analyze a SQL file
altimate-code analyze query.sql

# Trace column lineage
altimate-code lineage --sql "SELECT a.id, b.name FROM a JOIN b ON a.id = b.id"
```

## Architecture

```
CLI (TypeScript / Bun)
        |
   JSON-RPC Bridge (stdio)
        |
Python Engine (altimate-engine)
```

The CLI is written in TypeScript and runs on Bun. It communicates with the Python engine (`altimate-engine`) over a JSON-RPC 2.0 bridge using stdio. The Python engine handles SQL parsing, analysis, lineage computation, and warehouse interactions.

The Python engine **auto-bootstraps using `uv`** -- no system Python dependencies are required. On first run, the CLI downloads `uv`, creates an isolated virtual environment, and installs the engine automatically.

## Monorepo Structure

```
packages/
  altimate-code/       TypeScript CLI (@altimate/cli)
  altimate-engine/     Python engine (SQL analysis, lineage, warehouse)
  plugin/              CLI plugin system (@altimate/cli-plugin)
  sdk/js/              JavaScript SDK (@altimate/cli-sdk)
  util/                Shared TypeScript utilities
```

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for full development setup instructions.

```bash
# Install dependencies
bun install

# Build the CLI
cd packages/altimate-code && bun run script/build.ts --single

# Run tests
bun test
```

## Documentation

Full documentation is available at [altimate-code.sh](https://altimate-code.sh).

## Contributing

We welcome contributions! Please read our [Contributing Guide](./CONTRIBUTING.md) before submitting a pull request.

## License

This project is licensed under the MIT License -- see the [LICENSE](./LICENSE) file for details.
