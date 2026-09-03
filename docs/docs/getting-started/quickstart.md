---
title: "Quickstart — Altimate Code in 10 Minutes"
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

Immediately after model setup, a **"Scan your environment?"** Yes/No dialog appears. Say **Yes** and altimate-code reads local config files (`.dbt/profiles.yml`, `dbt_project.yml`, `.git/config`) — no credentials are read or sent, and no schema, model contents, or queries leave your computer. An anonymous environment summary (e.g. "dbt project detected, no warehouse configured") may be included in the standard telemetry stream if telemetry is enabled; disable via `ALTIMATE_TELEMETRY_DISABLED=true` or the [telemetry docs](../reference/telemetry.md) if you want a strictly-offline scan. The scan then routes you into one of four branches:

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
        "password": "{env:SNOWFLAKE_PASSWORD}",
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
        "credentials_path": "~/.config/gcloud/application_default_credentials.json"
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
        "password": "{env:POSTGRES_PASSWORD}"
      }
    }
    ```

=== "DuckDB (local)"

    ```json
    {
      "local": {
        "type": "duckdb",
        "path": "./data/analytics.duckdb"
      }
    }
    ```

All warehouse types support SSH tunneling for bastion hosts. See the [Warehouses reference](../configure/warehouses.md) for full options including key-pair auth, IAM roles, and ADC.

Verify your connection:

```
> warehouse_test snowflake
✓ Connected successfully
```

---

## Step 4: Choose an Agent Mode

altimate ships with specialized agent modes, each with its own tool permissions:

| Mode        | Access     | Use when you want to...                                                        |
| ----------- | ---------- | ------------------------------------------------------------------------------ |
| **Builder** | Read/Write | Create and modify SQL, dbt models, pipelines. SQL writes prompt for approval.  |
| **Analyst** | Read-only  | Ask questions about your data, explore production data safely, run cost analysis. SQL writes denied entirely. |
| **Plan**    | Minimal    | Plan an approach before switching to builder to execute it                     |

Switch modes in the TUI:

```
/agent analyst
```

Or from the CLI:

```bash
altimate --agent analyst
```

The **Analyst** mode is production-safe — it blocks INSERT, UPDATE, DELETE, and DROP statements at the harness level. The **Builder** mode has full read/write access for creating and editing SQL and dbt files.

---

## Step 5: Select Skills

Skills are reusable prompt templates for common workflows. Type `/` in the TUI to browse all available skills:

| Skill               | Purpose                                           |
| ------------------- | ------------------------------------------------- |
| `/query-optimize`   | Optimize slow queries with anti-pattern detection |
| `/sql-review`       | SQL quality gate with grading                     |
| `/sql-translate`    | Cross-dialect SQL translation                     |
| `/cost-report`      | Snowflake/Databricks cost analysis                |
| `/pii-audit`        | Scan for PII exposure                             |
| `/dbt-develop`      | Scaffold new dbt models                           |
| `/dbt-test`         | Generate dbt tests                                |
| `/dbt-docs`         | Generate dbt documentation                        |
| `/dbt-analyze`      | Column-level lineage and impact analysis          |
| `/dbt-troubleshoot` | Debug dbt errors                                  |
| `/data-viz`         | Interactive dashboards and visualizations         |
| `/teach`            | Teach patterns from example files                 |
| `/train`            | Load standards from documents                     |

You don't need to memorize these — describe what you want in plain English and the agent routes to the right skill automatically.

### Custom skills

Add your own skills as Markdown files in `.altimate-code/skill/`:

```markdown
---
name: cost-review
description: "Review SQL queries for cost optimization"
---

Analyze the SQL query for cost optimization opportunities.
Focus on: $ARGUMENTS
```

Skills are loaded from these paths (highest priority first):

1. `.altimate-code/skill/` (project)
2. `~/.altimate-code/skills/` (global)
3. Custom paths via config:

```json
{
  "skills": {
    "paths": ["./my-skills", "~/shared-skills"]
  }
}
```

---

## Step 6: Configure Permissions

Governance is enforced at the harness level, not via prompts. Every tool has a permission level: `allow`, `ask`, or `deny`.

### Per-agent permissions

Set tool permissions for each agent mode in `altimate-code.json`:

```json
{
  "agent": {
    "analyst": {
      "permission": {
        "write": "deny",
        "edit": "deny",
        "bash": {
          "dbt docs generate": "allow",
          "*": "deny"
        }
      }
    },
    "builder": {
      "permission": {
        "write": "allow",
        "edit": "allow",
        "bash": {
          "dbt *": "allow",
          "rm -rf *": "deny"
        }
      }
    }
  }
}
```

### Project rules with AGENTS.md

Define project-wide conventions in an `AGENTS.md` file at your project root. These rules are automatically loaded into every agent's system prompt:

```markdown
# Project Rules

- All staging models must be prefixed with `stg_`
- Never run queries without a WHERE clause on production tables
- Use `ref()` instead of hardcoded table names in dbt models
- All new models require at least one unique test and one not_null test
```

### Default permissions by agent mode

| Agent   | File writes | SQL writes                 | Bash                              | Training |
| ------- | ----------- | -------------------------- | --------------------------------- | -------- |
| Builder | allow       | ask (prompts for approval) | ask                               | allow    |
| Analyst | deny        | deny (blocked entirely)    | deny (safe commands auto-allowed) | allow    |
| Plan    | deny        | deny                       | deny                              | deny     |

---

## Step 7: Build Your First Artifact

In the TUI, paste this prompt:

```
Build a NYC taxi analytics dashboard using BigQuery public data and dbt
for transformations. Include geographic demand analysis with
pickup/dropoff hotspots, top routes, airport traffic, and borough
comparisons. Add revenue analytics with fare breakdowns, fare
distribution, tip analysis, payment trends, and revenue-per-mile
by route.
```

---

## What's Next

- [Agent Modes](../data-engineering/agent-modes.md): Deep dive into each mode's capabilities
- [Warehouses Reference](../configure/warehouses.md): All warehouse types, auth methods, SSH tunneling
- [Config Reference](../configure/config.md): Full config file schema
- [CI & Automation](../usage/ci-headless.md): Run altimate in automated pipelines
