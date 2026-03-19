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

## Step 2: Connect Your LLM

```bash
altimate        # Launch the TUI
/connect        # Interactive setup
```

Or set an environment variable and skip the prompt:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
altimate
```

---

## Step 3: Connect Your Warehouse

### Option A: Auto-detect from dbt profiles

If you have `~/.dbt/profiles.yml` configured:

```bash
/discover
```

Altimate reads your dbt profiles and creates warehouse connections automatically. You'll see output like:

```
Found dbt project: jaffle_shop (dbt-snowflake)
Found profile: snowflake_prod → Added connection 'snowflake_prod'
Indexing schema... 142 tables, 1,847 columns indexed
```

### Option B: Manual configuration

Add to `altimate-code.json` in your project root:

=== "Snowflake"

    ```json
    {
      "connections": {
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
    }
    ```

=== "BigQuery"

    ```json
    {
      "connections": {
        "bigquery": {
          "type": "bigquery",
          "project": "my-project-id",
          "keyfile": "~/.config/gcloud/application_default_credentials.json"
        }
      }
    }
    ```

=== "PostgreSQL"

    ```json
    {
      "connections": {
        "postgres": {
          "type": "postgres",
          "host": "localhost",
          "port": 5432,
          "database": "analytics",
          "user": "postgres",
          "password": "${POSTGRES_PASSWORD}"
        }
      }
    }
    ```

=== "DuckDB (local)"

    ```json
    {
      "connections": {
        "local": {
          "type": "duckdb",
          "database": "./data/analytics.duckdb"
        }
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
