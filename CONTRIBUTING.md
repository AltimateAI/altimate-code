# Contributing to altimate-code

Thank you for your interest in contributing to altimate-code! This guide will help you get set up and familiar with the project.

## Prerequisites

- [Bun](https://bun.sh/) 1.3+
- [Python](https://www.python.org/) 3.10+
- [Git](https://git-scm.com/)

## Development Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/AltimateAI/altimate-code.git
   cd altimate-code
   ```

2. **Install JavaScript dependencies**

   ```bash
   bun install
   ```

3. **Set up the Python engine**

   ```bash
   cd packages/altimate-engine
   python -m venv .venv
   source .venv/bin/activate
   pip install -e ".[dev]"
   ```

4. **Build the CLI**

   ```bash
   cd packages/altimate-code
   bun run script/build.ts --single
   ```

## Project Structure

| Directory | Description |
|---|---|
| `packages/altimate-code/` | Main TypeScript CLI (`@altimate/cli`). Entry point, TUI, AI providers, MCP server, and dbt integration. |
| `packages/altimate-engine/` | Python engine. SQL parsing, analysis, lineage computation, and warehouse connectivity. |
| `packages/plugin/` | CLI plugin system (`@altimate/cli-plugin`). Extend the CLI with custom tools. |
| `packages/sdk/js/` | JavaScript SDK (`@altimate/cli-sdk`). OpenAPI-generated client for the Altimate API. |
| `packages/util/` | Shared TypeScript utilities (error handling, logging). |

## Making Changes

### Pull Request Process

1. **Fork** the repository and create a feature branch from `main`.
2. **Make your changes** in the appropriate package(s).
3. **Run tests** to verify nothing is broken:
   ```bash
   # TypeScript tests
   bun test

   # Python tests
   cd packages/altimate-engine
   pytest
   ```
4. **Submit a pull request** against the `main` branch.
5. Ensure CI passes and address any review feedback.

### Code Style

**TypeScript:**
- Follow existing patterns in the codebase.
- Use ES module imports.
- Prefer explicit types over `any`.

**Python:**
- Use [ruff](https://docs.astral.sh/ruff/) for formatting and linting.
- Run `ruff check .` and `ruff format .` before committing.

### Commit Messages

We prefer [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add BigQuery warehouse connector
fix: resolve column lineage for CTEs with aliases
docs: update CLI usage examples
refactor: simplify JSON-RPC bridge error handling
```

Common prefixes: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.

## Reporting Issues

- Use [GitHub Issues](https://github.com/AltimateAI/altimate-code/issues) for bug reports and feature requests.
- For security vulnerabilities, see [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
