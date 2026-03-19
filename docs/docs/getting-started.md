# Getting Started

> **New to altimate?** [Start with the 5-minute quickstart](quickstart.md) to go from install to your first analysis in minutes.

## Why altimate?

altimate is the open-source data engineering harness with 100+ deterministic tools for building, validating, optimizing, and shipping data products. Unlike general-purpose coding agents, every tool is purpose-built for data engineering:

| Capability | General coding agents | altimate |
|---|---|---|
| SQL anti-pattern detection | None | 19 rules with confidence scoring |
| Column-level lineage | None | Automatic from SQL |
| Schema-aware autocomplete | None | Indexes your warehouse metadata |
| Cross-dialect translation | None | Snowflake, BigQuery, Databricks, Redshift |
| FinOps analysis | None | Credit analysis, expensive queries, warehouse sizing |
| PII detection | None | Automatic column scanning |
| dbt integration | Basic file editing | Manifest parsing, test generation, model scaffolding |

## Step 1: Install

```bash
npm install -g altimate-code
```

After install, you'll see a welcome banner with quick-start commands. On upgrades, the banner also shows what changed since your previous version.

## Step 2: Connect Your LLM (`/connect`)

Before anything else, connect an LLM provider. Launch altimate and run:

```bash
altimate
```

> **Note:** `altimate-code` still works as a backward-compatible alias.

Then in the TUI:

```
/connect
```

This walks you through selecting and authenticating with an LLM provider (Anthropic, OpenAI, Bedrock, Codex, Ollama, etc.). You need a working LLM connection before the agent can do anything useful.

## Step 3: Configure Your Warehouse _(Optional)_

Set up warehouse connections so altimate can query your data platform. You have two options:

### Option A: Auto-discover with `/discover`

```
/discover
```

`/discover` scans your environment and sets up everything automatically:

1. **Detects your dbt project** by finding `dbt_project.yml`, parsing the manifest, and reading profiles
2. **Discovers warehouse connections** from `~/.dbt/profiles.yml`, running Docker containers, and environment variables (e.g. `SNOWFLAKE_ACCOUNT`, `PGHOST`, `DATABASE_URL`)
3. **Checks installed tools** including dbt, sqlfluff, airflow, dagster, prefect, soda, sqlmesh, great_expectations, sqlfmt
4. **Offers to configure connections** and walks you through adding and testing each discovered warehouse
5. **Indexes schemas** to populate the schema cache for autocomplete and context-aware analysis

Once complete, altimate indexes your schemas and detects your tooling, enabling schema-aware autocomplete and context-rich analysis.

### Option B: Manual configuration

Add a warehouse connection to your `altimate-code.json`. Here's a quick example:

```json
{
  "warehouses": {
    "snowflake": {
      "type": "snowflake",
      "account": "xy12345.us-east-1",
      "user": "your_user",
      "password": "${SNOWFLAKE_PASSWORD}",
      "warehouse": "COMPUTE_WH",
      "database": "ANALYTICS"
    }
  }
}
```

For all warehouse types (Snowflake, BigQuery, Databricks, PostgreSQL, Redshift, DuckDB, MySQL, SQL Server) and advanced options (key-pair auth, ADC, SSH tunneling), see the [Warehouses reference](configure/warehouses.md).

## Step 4: Choose an Agent Mode

altimate offers specialized agent modes for different workflows:

| What do you want to do? | Use this agent mode |
|---|---|
| Analyzing data without risk of changes | **Analyst** for read-only queries, cost analysis, data profiling. SQL writes are blocked entirely. |
| Building or generating dbt models | **Builder** for model scaffolding, SQL generation, ref() wiring. SQL writes prompt for approval. |
| Planning before acting | **Plan** for outlining an approach before switching to builder to execute it |

Switch modes in the TUI:

```
/mode analyst
```

## Step 5: Start Working

You are ready to go. Type a natural-language prompt in the TUI and the agent will use the appropriate tools to answer. See [Example prompts](#example-prompts) at the bottom of this page for ideas.

---

## Configuration

altimate uses a JSON config file. Create `altimate-code.json` in your project root or `~/.config/altimate-code/altimate-code.json` globally.

### Warehouse connections

For all warehouse types and configuration options, see the [Warehouses reference](configure/warehouses.md).

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

altimate works as a standalone agent, but you can also invoke it from within Claude Code sessions. Run `/configure-claude` inside altimate to set up the integration:

```
/configure-claude
```

This creates a `/altimate` command in Claude Code. You can then use it in any Claude Code session:

```bash
# In Claude Code
/altimate analyze the cost of our top 10 most expensive queries
```

See [Using with Claude Code](data-engineering/guides/using-with-claude-code.md) for detailed workflows.

## Using with Codex

altimate integrates with Codex in two ways:

**As a Codex CLI skill** — run `/configure-codex` inside altimate to install an `altimate` skill in Codex CLI. Restart Codex, and it can delegate data engineering tasks to altimate automatically.

**As an LLM provider** — if you have a ChatGPT Plus/Pro subscription, you can use Codex as your LLM backend at no additional API cost:

1. Run `/connect` in the TUI
2. Select **Codex** as your provider
3. Authenticate via browser OAuth
4. Your subscription covers all usage, so no API keys are needed

See [Using with Codex](data-engineering/guides/using-with-codex.md) for details.

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

## Example Prompts

Copy and paste these into the TUI to get started with common use cases:

### Cost analysis

```
Analyze our Snowflake credit consumption over the last 30 days. Show the top 10 most expensive queries, which warehouses they ran on, and suggest optimizations.
```

### dbt model generation

```
Create a dbt staging model for the raw_orders table in our Snowflake warehouse. Include column descriptions, a unique test on order_id, and a not_null test on customer_id.
```

### SQL anti-pattern review

```
Scan all SQL files in the models/ directory for anti-patterns. Flag any SELECT *, missing WHERE clauses on DELETE statements, implicit cartesian joins, and non-sargable predicates.
```

### Cross-warehouse migration

```
Translate the following Snowflake SQL to BigQuery-compatible SQL, noting any function differences, data type changes, and features that don't have a direct equivalent:
SELECT DATEADD(day, -7, CURRENT_TIMESTAMP()), TRY_TO_NUMBER(amount), ARRAY_AGG(DISTINCT category) WITHIN GROUP (ORDER BY category) FROM sales QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY sale_date DESC) = 1;
```

### Data quality validation

```
Generate data quality tests for all models in the marts/ directory. For each model, suggest unique tests, not-null tests, accepted-values tests, and relationship tests based on the column names and types.
```

## Next steps

- [Terminal UI](usage/tui.md): Learn the terminal interface, keybinds, and slash commands
- [CLI](usage/cli.md): Subcommands, flags, and environment variables
- [Config Files](configure/config.md): Full config file reference
- [Providers](configure/providers.md): Set up Anthropic, OpenAI, Bedrock, Ollama, and more
- [Agent Modes](data-engineering/agent-modes.md): Builder, Analyst, Plan
- [Training](data-engineering/training/index.md): Correct the agent once, it remembers forever, your team inherits it
- [Tools](data-engineering/tools/sql-tools.md): 100+ specialized tools for SQL, dbt, and warehouses
