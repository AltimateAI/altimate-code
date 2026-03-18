# Getting Started

## Why altimate?

Unlike general-purpose coding agents, altimate is built for data teams:

| Capability | General coding agents | altimate |
|---|---|---|
| SQL anti-pattern detection | None | 19 rules with confidence scoring |
| Column-level lineage | None | Automatic from SQL |
| Schema-aware autocomplete | None | Indexes your warehouse metadata |
| Cross-dialect translation | None | Snowflake, BigQuery, Databricks, Redshift |
| FinOps analysis | None | Credit analysis, expensive queries, warehouse sizing |
| PII detection | None | Automatic column scanning |
| dbt integration | Basic file editing | Manifest parsing, test generation, model scaffolding |

## Installation

```bash
npm install -g altimate-code
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

altimate uses a JSON config file. Create `altimate-code.json` in your project root or `~/.config/altimate-code/altimate-code.json` globally.

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

### Snowflake (key-pair auth)

```json
{
  "warehouses": {
    "snowflake-prod": {
      "type": "snowflake",
      "account": "xy12345.us-east-1",
      "user": "svc_altimate",
      "private_key_path": "~/.ssh/snowflake_rsa_key.p8",
      "warehouse": "COMPUTE_WH",
      "database": "ANALYTICS",
      "role": "SYSADMIN"
    }
  }
}
```

### BigQuery

```json
{
  "warehouses": {
    "bigquery-prod": {
      "type": "bigquery",
      "project": "my-gcp-project",
      "dataset": "analytics",
      "service_account": "/path/to/service-account.json"
    }
  }
}
```

Or use Application Default Credentials (ADC) — just omit `service_account` and run `gcloud auth application-default login`.

### Databricks

```json
{
  "warehouses": {
    "databricks-prod": {
      "type": "databricks",
      "host": "dbc-abc123.cloud.databricks.com",
      "token": "${DATABRICKS_TOKEN}",
      "warehouse_id": "abcdef1234567890",
      "catalog": "main",
      "schema": "default"
    }
  }
}
```

### PostgreSQL / Redshift

```json
{
  "warehouses": {
    "postgres-dev": {
      "type": "postgres",
      "host": "localhost",
      "port": 5432,
      "database": "analytics",
      "user": "analyst",
      "password": "${PG_PASSWORD}"
    }
  }
}
```

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

## Using with Claude Code

altimate works as a standalone agent, but you can also invoke it from within Claude Code sessions. Claude Code can call altimate's tools when working on data projects:

```bash
# In Claude Code, use the /data skill to route to altimate
/data "analyze the cost of our top 10 most expensive queries"
```

## Using with Codex

If you have a ChatGPT Plus/Pro subscription, you can use Codex as your LLM backend at no additional API cost:

1. Run `/connect` in the TUI
2. Select **Codex** as your provider
3. Authenticate via browser OAuth
4. Your subscription covers all usage — no API keys needed

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

- [TUI Guide](usage/tui.md) — Learn the terminal interface, keybinds, and slash commands
- [CLI Reference](usage/cli.md) — Subcommands, flags, and environment variables
- [Configuration](configure/config.md) — Full config file reference
- [Providers](configure/providers.md) — Set up Anthropic, OpenAI, Bedrock, Ollama, and more
- [Agent Modes](data-engineering/agent-modes.md) — Builder, Analyst, Validator, Migrator, Researcher, Trainer
- [Training: Corrections That Stick](data-engineering/training/index.md) — Correct the agent once, it remembers forever, your team inherits it
- [Data Engineering Tools](data-engineering/tools/index.md) — 55+ specialized tools for SQL, dbt, and warehouses
