# Quickstart

## Installation

```bash
npm install -g @altimateai/altimate-code
```

After install, you'll see a welcome banner with quick-start commands. On upgrades, the banner also shows what changed since your previous version.

## First run

```bash
altimate
```

> **Note:** `altimate-code` still works as a backward-compatible alias.

The TUI launches with an interactive terminal. On first run, use the `/discover` command to auto-detect your data stack:

```
/discover
```

`/discover` scans your environment and sets up everything automatically:

1. **Detects your dbt project** — finds `dbt_project.yml`, parses the manifest, and reads profiles
2. **Discovers warehouse connections** — from `~/.dbt/profiles.yml`, running Docker containers, and environment variables (e.g. `SNOWFLAKE_ACCOUNT`, `PGHOST`, `DATABASE_URL`)
3. **Checks installed tools** — dbt, sqlfluff, airflow, dagster, prefect, soda, sqlmesh, great_expectations, sqlfmt
4. **Offers to configure connections** — walks you through adding and testing each discovered warehouse
5. **Indexes schemas** — populates the schema cache for autocomplete and context-aware analysis

You can also configure connections manually — see [Warehouse connections](#warehouse-connections) below.

To set up your LLM provider, use the `/connect` command.

## Configuration

Altimate Code uses a JSON config file. Create `altimate-code.json` in your project root or `~/.config/altimate-code/altimate-code.json` globally.

### Warehouse connections

```json
{
  "warehouses": {
    "prod-snowflake": {
      "type": "snowflake",
      "account": "xy12345.us-east-1",
      "user": "analytics_user",
      "password": "${SNOWFLAKE_PASSWORD}",
      "warehouse": "COMPUTE_WH",
      "database": "ANALYTICS",
      "role": "ANALYST_ROLE"
    },
    "dev-duckdb": {
      "type": "duckdb",
      "database": "./dev.duckdb"
    }
  }
}
```

Altimate Code supports Snowflake, BigQuery, Databricks, PostgreSQL, Redshift, DuckDB, MySQL, and SQL Server. For connection examples for each warehouse (including key-pair auth, ADC, and service accounts), see the [Warehouses](../configure/warehouses.md) page.

### LLM providers

The easiest way to configure your LLM is with the `/connect` command inside the TUI:

```
/connect
```

This walks you through selecting a provider and authenticating. You can also configure providers manually in your config file:

```json
{
  "provider": {
    "anthropic": {
      "apiKey": "{env:ANTHROPIC_API_KEY}"
    }
  },
  "model": "anthropic/claude-sonnet-4-6"
}
```

!!! tip
    Use `{env:...}` substitution for API keys so you never commit secrets to version control.

Altimate Code supports 35+ providers including Anthropic, OpenAI, AWS Bedrock, Azure OpenAI, Google Vertex AI, Ollama, and more. For the full list and configuration examples, see [Providers](../configure/providers.md) and [Models](../configure/models.md).

## Project-level config

Place `.altimate-code/altimate-code.json` in your dbt project root for project-specific settings:

```
my-dbt-project/
  .altimate-code/
    altimate-code.json    # warehouse connections, model preferences
    agents/               # custom agent prompts
    commands/             # custom slash commands
    plugins/              # custom plugins
  models/
  dbt_project.yml
```

## Environment variables

| Variable | Purpose |
|---|---|
| `SNOWFLAKE_PASSWORD` | Snowflake password (referenced in config as `${SNOWFLAKE_PASSWORD}`) |
| `DATABRICKS_TOKEN` | Databricks PAT |
| `ALTIMATE_CLI_CONFIG` | Custom config file path |

## Verify your setup

```
> warehouse_list
┌─────────────────┬───────────┬───────────┐
│ Name            │ Type      │ Database  │
├─────────────────┼───────────┼───────────┤
│ prod-snowflake  │ snowflake │ ANALYTICS │
│ dev-duckdb      │ duckdb    │ dev.duckdb│
└─────────────────┴───────────┴───────────┘

> warehouse_test prod-snowflake
✓ Connected successfully
```

## Next steps

- [Examples](../examples/index.md) — See real workflows in action
- [TUI Guide](../interfaces/tui.md) — Learn the terminal interface, keybinds, and slash commands
- [Tools](../configure/tools/index.md) — Browse the 70+ specialized data engineering tools
- [Configuration](../configure/config.md) — Full config file reference
- [Providers](../configure/providers.md) — Set up Anthropic, OpenAI, Bedrock, Ollama, and more
- [Agent Modes](../configure/agent-modes.md) — Understand the 5 governed modes
