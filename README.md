<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/docs/assets/images/altimate-code-banner.png" />
  <img src="docs/docs/assets/images/altimate-code-banner.png" alt="altimate-code" width="600" />
</picture>

**The open-source data engineering harness.**

The intelligence layer for data engineering AI — 100+ deterministic tools for SQL analysis,
column-level lineage, dbt, FinOps, and warehouse connectivity across every major cloud platform.

Run standalone in your terminal, embed underneath Claude Code or Codex, or integrate
into CI pipelines and orchestration DAGs. Precision data tooling for any LLM.

[![npm](https://img.shields.io/npm/v/altimate-code)](https://www.npmjs.com/package/altimate-code)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Slack](https://img.shields.io/badge/Slack-Join%20Community-4A154B?logo=slack)](https://altimate.studio/join-agentic-data-engineering-slack)
[![Docs](https://img.shields.io/badge/docs-docs.altimate.sh-blue)](https://docs.altimate.sh)
[![Install GitHub App](https://img.shields.io/badge/GitHub-Install%20App-24292f?logo=github)](https://github.com/apps/altimate-code-agent/installations/new)
[![Live dbt review](https://img.shields.io/badge/dbt-Live%20PR%20Demo-ff694b?logo=dbt)](https://github.com/AltimateAI/dbt-pr-review-demo/pulls)

</div>

---

## Install

```bash
npm install -g altimate-code
```

Or via curl on macOS/Linux (installs the `altimate` binary to `~/.altimate/bin`):

```bash
curl -fsSL https://www.altimate.sh/install | bash
```

On Windows, install the same self-contained binary (to `%USERPROFILE%\.altimate\bin`) from PowerShell — no Node required:

```powershell
powershell -c "irm https://www.altimate.sh/install.ps1 | iex"
```

The standalone install drops a single self-contained binary named `altimate`. The npm install exposes both `altimate` and `altimate-code` on PATH; the standalone install only exposes `altimate`. Alpine Linux (musl) and Windows on ARM64 are not currently supported by the standalone binary — use `apk add gcompat` on Alpine, or use WSL on Windows-on-ARM.

For GitHub, [install the Altimate Code App](https://github.com/apps/altimate-code-agent/installations/new)
to select repositories for interactive agent tasks. Automatic dbt pull-request
reviews use the deterministic GitHub Action documented below; see the
[public demo PRs](https://github.com/AltimateAI/dbt-pr-review-demo/pulls) before
installing it in your own repository.

Then — in order:

**Step 1: Configure your LLM provider** (required before anything works):
```bash
altimate        # Launch the TUI
/connect        # Interactive setup — choose your provider and enter your API key
```

Or set an environment variable directly:
```bash
export ANTHROPIC_API_KEY=your_key   # Anthropic Claude
export OPENAI_API_KEY=your_key      # OpenAI
```

**Step 2 (optional): Auto-detect your data stack** (read-only, safe for production connections):
```bash
altimate /discover
```

`/discover` auto-detects dbt projects, warehouse connections (from `profiles.yml` — checks `DBT_PROFILES_DIR`, project directory, then `<home>/.dbt/`; plus Docker and environment variables), and installed tools (dbt, sqlfluff, airflow, dagster, and more). Skip this and start building — you can always run it later.

> **Headless / scripted usage:** `altimate --yolo` auto-approves all permission prompts. Not recommended with live warehouse connections.

> **Zero additional setup.** One command install.

## Why a specialized harness?

General AI coding agents can edit SQL files. They cannot *understand* your data stack.
altimate gives any LLM a deterministic data engineering intelligence layer —
no hallucinated SQL advice, no guessing at schema, no missed PII.

| Capability | General coding agents | altimate |
|---|---|---|
| SQL anti-pattern detection | None | 19 rules, confidence-scored |
| Column-level lineage | None | Automatic from SQL, any dialect |
| Schema-aware autocomplete | None | Live-indexed warehouse metadata |
| Cross-dialect SQL translation | None | Snowflake ↔ BigQuery ↔ Databricks ↔ Redshift |
| Cross-dialect data validation | None | Row-by-row diff across 12 warehouses, 5 algorithms |
| FinOps & cost analysis | None | Credits, expensive queries, right-sizing |
| PII detection | None | 30+ regex patterns, 15 categories |
| dbt integration | Basic file editing | Manifest parsing, test gen, model scaffolding, lineage |
| Data visualization | None | Auto-generated charts from SQL results |
| Observability | None | Local-first tracing of AI sessions and tool calls |

> **Benchmarked precision:** 100% F1 on SQL anti-pattern detection (1,077 queries, 19 rules, 0 false positives).
> 100% edge-match on column-level lineage (500 queries, 13 categories).
> [See methodology →](experiments/BENCHMARKS.md)

**What the harness provides:**
- **SQL Intelligence Engine** — deterministic SQL parsing and analysis (not LLM pattern matching). 19 rules, 100% F1, 0 false positives. Built for data engineers who've been burned by hallucinated SQL advice.
- **Column-Level Lineage** — automatic extraction from SQL across dialects. 100% edge-match on 500 benchmark queries.
- **Live Warehouse Intelligence** — indexed schemas, query history, and cost data from your actual warehouse. Not guesses.
- **dbt Native** — manifest parsing, test generation, model scaffolding, medallion patterns, impact analysis
- **FinOps** — credit consumption, expensive query detection, warehouse right-sizing, idle resource cleanup
- **PII Detection** — 15 categories, 30+ regex patterns, enforced pre-execution

**Works seamlessly with Claude Code and Codex.** Use `/configure-claude` or `/configure-codex` to set up integration in one step. altimate is the data engineering tool layer — use it standalone in your terminal, or mount it as the harness underneath whatever AI agent you already run. The two are complementary.

altimate-code is a fork of [OpenCode](https://github.com/anomalyco/opencode) rebuilt for data teams. Model-agnostic — bring your own LLM or run locally with Ollama.

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

# Compare a Snowflake table to a BigQuery copy, row-by-row, without moving data
> /data-parity prod.orders (Snowflake) vs. analytics.orders (BigQuery), id key

# Generate dbt 1.8 unit tests for a model with CASE/WHEN and JOINs
> /dbt-unit-tests for models/marts/fct_revenue.sql
```

## Key Features

All features are deterministic — they parse, trace, and measure. Not LLM pattern matching.

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
Built-in observability for AI interactions — trace tool calls, token usage, and session activity locally. No external services required. View session recordings with `altimate trace`. Features include loop detection, post-session summary, and shareable HTML exports.

### AI Teammate Training
Teach your AI teammate project-specific patterns, naming conventions, and best practices. The training system learns from examples and applies rules automatically across sessions.

### Cross-Dialect Data Parity
Compare tables or query results row-by-row across 12 warehouses with the `/data-parity` skill or `data_diff` tool. Five algorithms — `auto`, `joindiff`, `hashdiff` (any-scale, no data egress), `profile` (column-stats only), and `cascade`. Date / numeric / categorical partitioning so 100M+ row tables diff in independent batches. Auto-discovers comparable columns and excludes audit/timestamp columns by name and catalog default.

### Automated dbt Unit Tests
Generate dbt 1.8+ unit tests from your terminal with `/dbt-unit-tests` or the `dbt_unit_test_gen` tool. Detects testable SQL constructs (CASE/WHEN, JOINs, NULLs, window functions, division, incremental models) and assembles complete YAML with type-correct mock data across 7 dialects.

### GitLab MR Review
Review merge requests directly from your terminal with `altimate gitlab review <MR_URL>`. Self-hosted GitLab instances and nested group paths supported. Comment deduplication updates an existing review instead of posting duplicates. Companion to the existing GitHub PR review flow.

## Agent Modes

Each mode has scoped permissions, tool access, and SQL write-access control.

| Mode | Role | Access |
|---|---|---|
| **Builder** | Create dbt models, SQL pipelines, and data transformations | Full read/write (write SQL prompts for approval; `DROP DATABASE`/`DROP SCHEMA`/`TRUNCATE` hard-blocked) |
| **Analyst** | Explore data, run SELECT queries, FinOps analysis, and generate insights | Read-only enforced (SELECT only, no file writes) |
| **Plan** | Outline an approach before acting | Minimal (read files only, no SQL or bash) |

> **New to altimate?** Start with **Analyst mode** — it's read-only and safe to run against production connections. Need specialized workflows (validation, migration, research)? Create [custom agent modes](https://docs.altimate.sh).

## Supported Warehouses

Snowflake · BigQuery · Databricks · PostgreSQL · Redshift · Trino · ClickHouse · DuckDB · MySQL · SQL Server (incl. Microsoft Fabric) · Oracle · SQLite · MongoDB

First-class support with schema indexing, query execution, and metadata introspection. SSH tunneling available for secure connections.

## Works with Any LLM

Model-agnostic — bring your own provider or run locally.

Altimate LLM Gateway · Anthropic · OpenAI · Google Gemini · Google Vertex AI · Amazon Bedrock · Azure OpenAI · Databricks AI Gateway · Snowflake Cortex · Mistral · Groq · DeepInfra · Cerebras · Cohere · Together AI · Perplexity · xAI · OpenRouter · LM Studio · Ollama · GitHub Copilot

## Skills

altimate ships with 19 built-in skills — type `/` in the TUI to browse and get autocomplete. No memorization required.

`/sql-review` · `/sql-translate` · `/data-parity` · `/pii-audit` · `/cost-report` · `/lineage-diff` · `/query-optimize` · `/data-viz` · `/dbt-develop` · `/dbt-test` · `/dbt-unit-tests` · `/dbt-docs` · `/dbt-analyze` · `/dbt-troubleshoot` · `/schema-migration` · `/teach` · `/train` · `/training-status` · `/altimate-setup`

## Community & Contributing

- **Slack**: [Join Slack](https://altimate.studio/join-agentic-data-engineering-slack) — Real-time chat for questions, showcases, and feature discussion
- **Issues**: [GitHub Issues](https://github.com/AltimateAI/altimate-code/issues) — Bug reports and feature requests
- **Discussions**: [GitHub Discussions](https://github.com/AltimateAI/altimate-code/discussions) — Long-form questions and proposals
- **Security**: See [SECURITY.md](./SECURITY.md) for responsible disclosure

Contributions welcome — docs, SQL rules, warehouse connectors, and TUI improvements are all needed. The contributing guide covers setup, the vouch system, and the issue-first PR policy.

**[Read CONTRIBUTING.md →](./CONTRIBUTING.md)**

## Changelog

- **v0.6.1** (April 2026) — BigQuery finops multi-region support and column-name fixes
- **v0.6.0** (April 2026) — `data_diff` cross-dialect data parity (12 warehouses, 5 algorithms), MSSQL/Microsoft Fabric support, Databricks AI Gateway provider (11 foundation models)
- **v0.5.21** (April 2026) — automated dbt unit test generation (`/dbt-unit-tests`, dbt 1.8+, 7 dialects), dialect-aware `sql_explain`
- **v0.5.20** (April 2026) — Altimate model auto-selection, connection-string password URL-encoding, trace pagination
- **v0.5.19** (April 2026) — `${VAR}` env-var interpolation in configs, atomic trace file writes
- **v0.5.18** (April 2026) — native GitLab MR review (`altimate gitlab review`), Altimate LLM Gateway provider, glob tool hardening, MCP config normalization
- **v0.5.17** (April 2026) — custom `DBT_PROFILES_DIR` resolution, ClickHouse driver hardening
- **v0.5.16** (March 2026) — ClickHouse warehouse driver, agent loop detection
- **v0.5.15** (March 2026) — plan-agent two-step approach + refinement, feature discovery, SQL classifier security hardening
- **v0.5.14** (March 2026) — MongoDB driver, skill follow-up suggestions, Verdaccio sanity suite, `upstream_fix:` marker convention
- **v0.5.12** (March 2026) — `altimate-dbt` auto-discover config (Windows-compatible), local E2E sanity test harness
- **v0.5.11** (March 2026) — `altimate-code check` CLI command, data-viz improvements, Codespaces support, session tracing, 52 CI test fix
- **v0.5.7** (March 2026) — impact analysis tool, training import, CI check command, `--max-turns` budget, LM Studio provider
- **v0.5.6** (March 2026) — skill CLI & TUI management, GitHub skill install, Snowflake Cortex provider
- **v0.5.5** (March 2026) — auto-discover MCP servers from VS Code, Cursor, Claude Code, Copilot configs
- **v0.5.3** (March 2026) — bundle skills/dbt-tools in npm binary, marker guard CI
- **v0.5.1** (March 2026) — simplified 3-mode agents (builder/analyst/plan), SQL write access control
- **v0.5.0** (March 2026) — smooth streaming mode, builtin skills, `/configure-claude` and `/configure-codex` commands
- **v0.4.x and earlier** — [See full changelog →](CHANGELOG.md)

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgements

altimate is a fork of [OpenCode](https://github.com/anomalyco/opencode), the open-source AI coding agent. We build on top of their excellent foundation to add data-team-specific capabilities.
