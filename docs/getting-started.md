---
layout: default
title: Getting Started
nav_order: 2
---

# Getting Started

## Installation

```bash
npm install -g @altimate/cli
```

## First run

```bash
altimate-code
```

The TUI launches with an interactive terminal. On first run, use the `/connect` command to configure:

1. **LLM provider** — Choose your AI backend (Anthropic, OpenAI, Codex, etc.)
2. **Warehouse connection** — Connect to your data warehouse

## Configuration

altimate-code uses a JSON config file. Create `altimate-code.json` in your project root or `~/.config/altimate-code/altimate-code.json` globally.

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

altimate-code works as a standalone agent, but you can also invoke it from within Claude Code sessions. Claude Code can call altimate-code's tools when working on data projects:

```bash
# In Claude Code, use the /data skill to route to altimate-code
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
