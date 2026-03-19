---
description: "Get value from Altimate Code in 10 minutes. For data engineers who know dbt, Snowflake, and SQL — skip the basics, see what Altimate adds to your workflow."
---

# Quickstart

---

## Step 1: Install

```bash
npm install -g altimate-code
```

Or via Homebrew: `brew install AltimateAI/tap/altimate-code`

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

> **No API key?** Select **Codex** in `/connect` — it's built-in with no setup.

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

<div class="grid cards" markdown>

- :material-cog:{ .lg .middle } **Complete Setup**

  ***

  Advanced warehouse configs, all LLM providers, SSH tunneling, multi-environment setup.

  [:octicons-arrow-right-24: Complete Setup](quickstart.md)

- :material-account-group:{ .lg .middle } **Agent Modes**

  ***

  Builder, Analyst, Validator, Migrator, Executive — choose the right permissions for your task.

  [:octicons-arrow-right-24: Agent Modes](../data-engineering/agent-modes.md)

- :material-robot:{ .lg .middle } **CI & Automation**

  ***

  Run SQL review gates in GitHub Actions, block PRs with failing grades, automate cost reports.

  [:octicons-arrow-right-24: CI & Automation](../data-engineering/guides/ci-headless.md)

- :material-school:{ .lg .middle } **Train Your Agent**

  ***

  Teach project-specific patterns, naming conventions, and SQL style rules.

  [:octicons-arrow-right-24: Training](../configure/skills.md)

</div>
