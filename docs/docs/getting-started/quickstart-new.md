---
description: "Get value from Altimate Code in 10 minutes. For data engineers who know dbt, Snowflake, and SQL — skip the basics, see what Altimate adds to your workflow."
---

# Quickstart

---

## Step 1: Install

```bash
npm install -g altimate-code
```

---

## Step 2: Sign in

```bash
altimate        # Launch the TUI
```

On a fresh install, a welcome panel appears with a curated 6-provider picker:

- **Altimate LLM Gateway** *(recommended)* — 10M tokens free, no API keys. Routes to the best model per task across Sonnet, Opus, GPT-5, and more. Sign-in opens a browser tab; complete Google or email signup and you're back in the TUI. If your terminal can't open a browser (SSH / tmux / WSL), the CLI prints the URL — paste it into a browser on your desktop.
- **Anthropic** / **OpenAI** / **Google** — paste an API key or OAuth in.
- **Big Pickle** — free tier, chats work but many data tasks fail; useful for kicking tires.
- **Search all providers…** — full picker if you need Bedrock, Databricks AI Gateway, Cloudflare AI Gateway, Snowflake Cortex, DigitalOcean Inference, etc.

Or set an environment variable and skip the picker:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
altimate
```

!!! tip "Don't want to manage API keys?"
    The [Altimate LLM Gateway](https://help.altimate.ai/datamates/user-guide/components/llm-gateway/) is the top row of the picker — 10M free tokens, and altimate-code auto-selects the right model per task. First-run sign-in uses a loopback OAuth on `127.0.0.1:7317-7325` (falls back if the preferred port is taken).

---

## Step 2.5: First-run scan (optional)

Immediately after model setup, a **"Scan your environment?"** Yes/No dialog appears. Say **Yes** and altimate-code reads local config files (`.dbt/profiles.yml`, `dbt_project.yml`, `.git/config`) — no credentials are read or sent, and no schema, model contents, or queries leave your computer. An anonymous environment summary (e.g. "dbt project detected, no warehouse configured") may be included in the standard telemetry stream if telemetry is enabled; disable via `OPENCODE_DISABLE_TELEMETRY=1` or the [telemetry docs](../usage/telemetry.md) if you want a strictly-offline scan. The scan then routes you into one of four branches:

- **Found a warehouse** → offers to add + verify each connection, then index its schema.
- **Found dbt project, no warehouse** → asks which warehouse it runs against and walks you through `warehouse_add`.
- **In a git repo, no dbt** → suggests you `cd` into the right project and re-run.
- **Nothing yet** → offers to try Altimate on a sample dbt project (bundled jaffle-shop DuckDB, no warehouse needed) or another exploratory job.

Every branch ends on a numbered "**What would you like to do?**" menu in the chat — pick a job by typing the number, or free-text if none fit. **The menu is chat text, not an arrow-key picker; type your answer and press Enter.**

Say **No** to the scan gate and you land on the same activation menu without the scan detail — good for users who already know what they want to run.

---

## Step 3: Connect Your Warehouse

### Option A: Auto-detect from dbt profiles

If you have a `profiles.yml` — either in your home directory's `.dbt/` folder, in your project repo, or pointed to by `DBT_PROFILES_DIR`:

```bash
/discover
```

Altimate searches for `profiles.yml` in this order: `DBT_PROFILES_DIR` env var → project root (next to `dbt_project.yml`) → `<home>/.dbt/profiles.yml`. It reads your dbt profiles and creates warehouse connections automatically. You'll see output like:

```
Found dbt project: jaffle_shop (dbt-snowflake)
Found profile: snowflake_prod → Added connection 'snowflake_prod'
Indexing schema... 142 tables, 1,847 columns indexed
```

### Option B: Manual configuration

Add to `.altimate-code/connections.json` in your project root:

=== "Snowflake"

    ```json
    {
      "snowflake": {
        "type": "snowflake",
        "account": "xy12345.us-east-1",
        "user": "dbt_user",
        "password": "${SNOWFLAKE_PASSWORD}",
        "warehouse": "TRANSFORM_WH",
        "database": "ANALYTICS",
        "schema": "PUBLIC",
        "role": "TRANSFORMER"
      }
    }
    ```

=== "BigQuery"

    ```json
    {
      "bigquery": {
        "type": "bigquery",
        "project": "my-project-id",
        "keyfile": "~/.config/gcloud/application_default_credentials.json"
      }
    }
    ```

=== "PostgreSQL"

    ```json
    {
      "postgres": {
        "type": "postgres",
        "host": "localhost",
        "port": 5432,
        "database": "analytics",
        "user": "postgres",
        "password": "${POSTGRES_PASSWORD}"
      }
    }
    ```

=== "DuckDB (local)"

    ```json
    {
      "local": {
        "type": "duckdb",
        "database": "./data/analytics.duckdb"
      }
    }
    ```

Then index the schema for autocomplete and analysis:

```bash
/schema-index snowflake
```

---

## Step 4: Your First Workflow — NYC Taxi Cab Analytics

Try this end-to-end example. Paste this prompt into the TUI:

```
Take the New York City taxi cab public dataset, bring up a DuckDB instance,
and build a dashboard showing areas of maximum coverage and lowest coverage.
Set up a complete dbt project with staging, intermediate, and mart layers,
and create an Airflow DAG to orchestrate the pipeline.
```

**What altimate does:**

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
5. **Builds an interactive dashboard** visualizing zone coverage across NYC — top zones, bottom zones, and geographic distribution

This single prompt exercises warehouse connections, dbt scaffolding, SQL generation, orchestration wiring, and visualization — the full altimate toolkit.

---

## Skill Discovery: What Can I Do?

Type `/` in the TUI to see all available skills. Here's a quick reference for common tasks:

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

**Pro tip:** You don't need to memorize these. Just describe what you want in plain English — the agent routes to the right skill automatically.

---

## What's Next

- **[Setup](quickstart.md)** — Warehouses, LLM providers, agent modes, skills, and permissions
- **[Examples](../examples/index.md)** — End-to-end walkthroughs for common data engineering tasks
- **[Interfaces](../usage/tui.md)** — TUI, CLI, CI, IDE, and GitHub/GitLab integrations
