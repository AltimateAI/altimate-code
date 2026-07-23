---
title: "Quickstart"
description: "Install Altimate Code, connect an LLM and your warehouse, and build your first data pipeline. For data engineers who know dbt, Snowflake, and SQL."
---
# Quickstart

Welcome to Altimate Code!

This guide takes you from install to a working data engineering agent. By the end, you'll have Altimate Code connected to an LLM and building a complete dbt pipeline from a single prompt.

## Before you begin

Make sure you have:

- A terminal open. The npm install needs Node.js 18+; the [standalone installer](#step-1-install) needs no Node.js at all
- A way to talk to an LLM: your own provider key, or a free Altimate API key ([Step 2](#step-2-select-your-llm-provider) covers both, including the free 10M-token route)
- Optionally, a dbt project for Altimate Code to work on. You don't need one: the [pipeline example in Step 5](#step-5-build-your-first-data-pipeline) builds everything from scratch.

## Step 1: Install

```bash title="Terminal"
npm install -g altimate-code
```

The install runs a postinstall script that links the platform-specific binary onto your PATH, sets up the bundled dbt tooling, and copies the built-in skills into `~/.altimate/builtin`.

??? note "Does your org restrict npm install scripts?"
    If your org blocks npm lifecycle scripts (for example with `--ignore-scripts` or a script-approval gate like `@lavamoat/allow-scripts`), that postinstall step won't run, and the CLI may not function correctly. To let it run those postinstall scripts, run this and reinstall:

    ```bash title="Terminal"
    npm config set allow-scripts=altimate-code --location=user
    ```

    Otherwise, you can use the standalone installers below, which don't depend on npm so they aren't affected by any postinstall-script blocker:

    ```bash title="Terminal (macOS/Linux)"
    curl -fsSL https://www.altimate.sh/install | bash
    ```

    ```powershell title="Terminal (Windows PowerShell)"
    powershell -c "irm https://www.altimate.sh/install.ps1 | iex"
    ```

    These drop a single self-contained `altimate` binary and need no Node.js. Not currently supported on Alpine Linux (musl) or Windows on ARM64; use `apk add gcompat` on Alpine, or WSL on Windows ARM.

## Step 2: Select your LLM provider

Start an interactive session with the `altimate` command, then run `/connect`:

```bash title="Terminal"
altimate        # Launch the TUI
```

```text title="In the TUI"
/connect        # Interactive setup
```

!!! tip "We recommend connecting with your Altimate API key"
    Select **Altimate AI** in the `/connect` provider list. You use one credential, your Altimate API key, instead of a separate Anthropic, OpenAI, or other provider key. This connects through the [Altimate LLM Gateway](https://help.altimate.ai/datamates/user-guide/components/llm-gateway/): new accounts get 10M tokens free, and the Gateway dynamically routes each request to whichever model fits the task across Sonnet, Opus, GPT, and more, with no manual model switching. Find your instance name and API key under Settings → API Keys in your Altimate dashboard, formatted as `instance-name::api-key`.

You can also choose any provider you already have a key for, such as Anthropic Claude, OpenAI, or Google Gemini. To use it right away, set the environment variable in your shell with the command below. To make it permanent, add the same line to your shell profile (`~/.zshrc` or `~/.bashrc`).

```bash title="Terminal"
export ANTHROPIC_API_KEY=sk-ant-...
altimate
```

Prefer a config file? Add the provider to `altimate-code.json` in your project root:

```json title="altimate-code.json"
{
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "{env:ANTHROPIC_API_KEY}"
      }
    }
  },
  "model": "anthropic/claude-sonnet-4-6"
}
```

For every other provider (Amazon Bedrock, Azure OpenAI, Google Gemini, Ollama, LM Studio, OpenRouter, and more) and for switching providers later, see the [Providers reference](../configure/providers.md).

## Step 3: Connect your warehouse

No dbt project or warehouse of your own yet? Skip ahead to [Step 5](#step-5-build-your-first-data-pipeline), it's a self-contained example that needs neither. Or clone a sample dbt project such as [jaffle_shop_duckdb](https://github.com/dbt-labs/jaffle_shop_duckdb) and run `/discover` inside it: it ships a `profiles.yml` on DuckDB, so there are no cloud credentials to set up.

### Option A: Auto-detect from dbt profiles

If you have a `profiles.yml`, either in your home directory's `.dbt/` folder, in your project repo, or pointed to by `DBT_PROFILES_DIR`:

```text title="In the TUI"
/discover
```

Altimate Code searches for `profiles.yml` in this order: `DBT_PROFILES_DIR` env var → project root (next to `dbt_project.yml`) → `<home>/.dbt/profiles.yml`. It reads your dbt profiles and creates warehouse connections automatically. You'll see output like:

```
Found dbt project: jaffle_shop (dbt-snowflake)
Found profile: snowflake_prod → Added connection 'snowflake_prod'
Indexing schema... 142 tables, 1,847 columns indexed
```

### Option B: Manual configuration

Config lives at two levels: `.altimate-code/` in a project root (shared with your team, checked into the repo) and `~/.altimate-code/` in your home directory (your own defaults, applied everywhere). Project config wins when both exist.

Add to `.altimate-code/connections.json` in your project root:

=== ":simple-snowflake: Snowflake"

    ```json
    {
      "snowflake": {
        "type": "snowflake",
        "account": "xy12345.us-east-1",
        "user": "dbt_user",
        "password": "{env:SNOWFLAKE_PASSWORD}",
        "warehouse": "TRANSFORM_WH",
        "database": "ANALYTICS",
        "schema": "PUBLIC",
        "role": "TRANSFORMER"
      }
    }
    ```

=== ":simple-googlebigquery: BigQuery"

    ```json
    {
      "bigquery": {
        "type": "bigquery",
        "project": "my-project-id",
        "credentials_path": "/path/to/service-account.json"
      }
    }
    ```

    Already authenticated via `gcloud`? Omit `credentials_path` to use Application Default Credentials instead.

=== ":simple-databricks: Databricks"

    ```json
    {
      "databricks": {
        "type": "databricks",
        "server_hostname": "dbc-abc123.cloud.databricks.com",
        "http_path": "/sql/1.0/warehouses/abcdef",
        "access_token": "{env:DATABRICKS_TOKEN}",
        "catalog": "main",
        "schema": "default"
      }
    }
    ```

=== ":simple-postgresql: PostgreSQL"

    ```json
    {
      "postgres": {
        "type": "postgres",
        "host": "localhost",
        "port": 5432,
        "database": "analytics",
        "user": "postgres",
        "password": "{env:POSTGRES_PASSWORD}"
      }
    }
    ```

=== ":simple-duckdb: DuckDB (local)"

    ```json
    {
      "local": {
        "type": "duckdb",
        "path": "./data/analytics.duckdb"
      }
    }
    ```

=== "Redshift"

    ```json
    {
      "redshift": {
        "type": "redshift",
        "host": "my-cluster.abc123.us-east-1.redshift.amazonaws.com",
        "port": 5439,
        "database": "analytics",
        "user": "admin",
        "password": "{env:REDSHIFT_PASSWORD}"
      }
    }
    ```

All warehouse types support SSH tunneling for bastion hosts. See [Warehouse Connections](../configure/warehouses.md) for more warehouse types and advanced options such as key-pair auth, IAM roles, and ADC.

Verify the connection, then index the schema for autocomplete and analysis:

```text title="In the TUI"
warehouse_test snowflake
```

```text title="In the TUI"
schema_index snowflake
```

## Step 4: Select an agent mode

Altimate Code runs in one of four modes, with permissions enforced at the harness level rather than left to the prompt:

| Mode | Access | Use it for |
|---|---|---|
| Builder | Read/write | Scaffolding and editing dbt models and SQL. Writes prompt for approval. |
| Analyst | Read-only | Safe exploration of production data. SQL writes denied entirely. |
| Reviewer | Read-only | Grading a SQL/dbt change and returning an approve, comment, or request-changes verdict. |
| Plan | Minimal | Sketching an approach before switching to Builder to execute it. |

Run `/agents` in the TUI to open the agent picker, or start in a specific mode from your terminal:

```bash title="Terminal"
altimate --agent builder
```

See [Agent Modes](../data-engineering/agent-modes.md) for the full permission model, and [Permissions](../configure/permissions.md) to tune tool access per agent.

### Project rules with AGENTS.md

Define team conventions in an `AGENTS.md` file at your project root. Every agent loads these rules into its system prompt automatically:

```markdown title="AGENTS.md"
# Project Rules

- All staging models must be prefixed with `stg_`
- Never run queries without a WHERE clause on production tables
- Use `ref()` instead of hardcoded table names in dbt models
- All new models require at least one unique test and one not_null test
```

See [Rules](../configure/rules.md) for details.

## Step 5: Build your first data pipeline

Try this end-to-end example. It creates files and runs dbt, so start in Builder mode (`altimate --agent builder`, or switch with `/agents` once you're in), then paste this prompt into the TUI:

```text title="In the TUI"
Take the New York City taxi cab public dataset, bring up a DuckDB instance,
and build a dashboard showing areas of maximum coverage and lowest coverage.
Set up a complete dbt project with staging, intermediate, and mart layers,
and create an Airflow DAG to orchestrate the pipeline.
```

**What Altimate Code does:**

1. **Downloads the NYC TLC trip data** into a local DuckDB instance
2. **Scaffolds a full dbt project** with proper directory structure:
    ```
    nyc_taxi/
      models/
        staging/
          stg_yellow_trips.sql
          stg_taxi_zones.sql
        intermediate/
          int_trips_by_zone.sql
          int_zone_coverage_stats.sql
        marts/
          fct_zone_coverage.sql
          dim_zones.sql
      seeds/
        taxi_zone_lookup.csv
      dbt_project.yml
      profiles.yml              # points to DuckDB
    ```
3. **Generates mart models** that aggregate pickup/dropoff counts per zone, rank zones by trip volume, and classify them as high-coverage or low-coverage
4. **Creates an Airflow DAG** (`dags/nyc_taxi_pipeline.py`) with tasks for data ingestion, `dbt run`, `dbt test`, and dashboard generation
5. **Builds an interactive dashboard** visualizing zone coverage across NYC: top zones, bottom zones, and geographic distribution

This prompt exercises warehouse connections, dbt scaffolding, SQL generation, orchestration wiring, and visualization: the full Altimate Code toolkit.

## Step 6: Explore skills

Run `/skills` in the TUI to list all available skills. Here's a quick reference for common tasks:

!!! tip
    You don't need to memorize these. Just describe what you want in plain English, and the agent routes to the right skill automatically.

| I want to...              | Skill               | Example                                                  |
| ------------------------- | ------------------- | -------------------------------------------------------- |
| Optimize a slow query     | `/query-optimize`   | `/query-optimize SELECT * FROM big_table`                |
| Review SQL before merging | `/sql-review`       | `/sql-review models/staging/stg_orders.sql`              |
| Check Snowflake costs     | `/cost-report`      | `/cost-report` (last 30 days)                            |
| Scan for PII exposure     | `/pii-audit`        | `/pii-audit` (full schema) or `/pii-audit models/marts/` |
| Debug a dbt error         | `/dbt-troubleshoot` | Paste the error message                                  |
| Add tests to a model      | `/dbt-test`         | `/dbt-test models/staging/stg_orders.sql`                |
| Document a model          | `/dbt-docs`         | `/dbt-docs models/marts/fct_revenue.sql`                 |
| Analyze downstream impact | `/dbt-analyze`      | `/dbt-analyze stg_orders` (before refactoring)           |
| Create a new dbt model    | `/dbt-develop`      | `Create a staging model for the raw_orders source`       |
| Translate SQL dialects    | `/sql-translate`    | `/sql-translate snowflake bigquery SELECT DATEADD(...)`  |
| Check migration safety    | `/schema-migration` | `/schema-migration migrations/V003__alter_orders.sql`    |
| Teach a pattern           | `/teach`            | `/teach @models/staging/stg_orders.sql`                  |

You can also write your own skills as Markdown files in `.altimate-code/skill/`. See [Skills](../configure/skills.md) for the format and load paths.

## Essential commands

Terminal commands run `altimate` from your shell. TUI commands run inside an interactive session.

**In your terminal**

| Command | What it does |
|---|---|
| `altimate` | Start the TUI in the current directory |
| `altimate run "task"` | Run `altimate` with a one-off message |
| `altimate --agent analyst` | Start in a specific agent mode |
| `altimate --continue` | Continue your last session |
| `altimate check models/` | Run deterministic SQL checks (lint, safety), no LLM required |
| `altimate stats` | Show token usage and cost statistics |

**Inside the TUI**

| Command | What it does |
|---|---|
| `/connect` | Choose and authenticate an LLM provider |
| `/discover` | Auto-detect dbt projects and warehouse connections |
| `/skills` | List all available skills |
| `/agents` | Open the agent picker to switch modes |

## What's Next

- **[Configure](../configure/index.md):** Warehouses, LLM providers, permissions, skills, and the full config file schema
- **[Examples](../examples/index.md):** End-to-end walkthroughs for common data engineering tasks
- **[Interfaces](../usage/tui.md):** TUI, CLI, CI, IDE, and GitHub/GitLab integrations
