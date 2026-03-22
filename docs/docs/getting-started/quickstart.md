---
description: "Install altimate-code, connect your warehouse and LLM, configure agent modes, skills, and permissions."
---

# Setup

> **You need:** npm 8+. An API key for any supported LLM provider.

---

## Step 1: Install

```bash
npm install -g altimate-code
```

> **Zero additional setup.** One command install.

---

## Step 2: Configure Your LLM

```bash
altimate        # Launch the TUI
/connect        # Choose your provider and enter your API key
```

Or set an environment variable:

```bash
export ANTHROPIC_API_KEY=your-key-here   # Anthropic Claude (recommended)
export OPENAI_API_KEY=your-key-here      # OpenAI
```

Minimal config file option (`altimate-code.json` in your project root):

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

### Changing your LLM provider

Switch providers at any time by updating the `provider` and `model` fields in `altimate-code.json`:

=== "Anthropic"

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

=== "OpenAI"

    ```json
    {
      "provider": {
        "openai": {
          "apiKey": "{env:OPENAI_API_KEY}"
        }
      },
      "model": "openai/gpt-4o"
    }
    ```

=== "AWS Bedrock"

    ```json
    {
      "provider": {
        "bedrock": {
          "region": "us-east-1",
          "accessKeyId": "{env:AWS_ACCESS_KEY_ID}",
          "secretAccessKey": "{env:AWS_SECRET_ACCESS_KEY}"
        }
      },
      "model": "bedrock/anthropic.claude-sonnet-4-6-v1"
    }
    ```

=== "Azure OpenAI"

    ```json
    {
      "provider": {
        "azure": {
          "apiKey": "{env:AZURE_OPENAI_API_KEY}",
          "baseURL": "https://your-resource.openai.azure.com/openai/deployments/your-deployment"
        }
      },
      "model": "azure/gpt-4o"
    }
    ```

=== "Google Gemini"

    ```json
    {
      "provider": {
        "google": {
          "apiKey": "{env:GOOGLE_API_KEY}"
        }
      },
      "model": "google/gemini-2.5-pro"
    }
    ```

=== "Ollama (Local)"

    ```json
    {
      "provider": {
        "ollama": {
          "baseURL": "http://localhost:11434"
        }
      },
      "model": "ollama/llama3.1"
    }
    ```

=== "LM Studio (Local)"

    ```json
    {
      "provider": {
        "lmstudio": {
          "name": "LM Studio",
          "npm": "@ai-sdk/openai-compatible",
          "options": {
            "apiKey": "lm-studio",
            "baseURL": "http://localhost:1234/v1"
          },
          "models": {
            "qwen2.5-7b-instruct": {
              "name": "Qwen 2.5 7B Instruct",
              "tool_call": true,
              "limit": { "context": 131072, "output": 8192 }
            }
          }
        }
      },
      "model": "lmstudio/qwen2.5-7b-instruct"
    }
    ```

=== "OpenRouter"

    ```json
    {
      "provider": {
        "openrouter": {
          "apiKey": "{env:OPENROUTER_API_KEY}"
        }
      },
      "model": "openrouter/anthropic/claude-sonnet-4-6"
    }
    ```

You can also set a smaller model for lightweight tasks like summarization:

```json
{
  "model": "anthropic/claude-sonnet-4-6",
  "small_model": "anthropic/claude-haiku-4-5-20251001"
}
```

---

## Step 3: Connect Your Warehouse

### Auto-discover with `/discover`

> Skip this step if you want to work locally. You can always run `/discover` later.

```bash
altimate /discover
```

Auto-detects your dbt projects, warehouse credentials from `~/.dbt/profiles.yml`, running Docker containers, and environment variables (`SNOWFLAKE_ACCOUNT`, `PGHOST`, `DATABASE_URL`, etc.).

### Manual configuration

Add a warehouse connection to `.altimate-code/connections.json`:

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

=== "Databricks"

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

=== "DuckDB"

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

All warehouse types support SSH tunneling for bastion hosts. See the [Warehouses reference](../configure/warehouses.md) for full options including key-pair auth, IAM roles, and ADC.

Verify your connection:

```
> warehouse_test snowflake
✓ Connected successfully
```

---

## Step 4: Choose an Agent Mode

altimate ships with specialized agent modes, each with its own tool permissions:

| Mode | Access | Use when you want to... |
|---|---|---|
| **Builder** | Read/Write | Create and modify SQL, dbt models, pipelines. SQL writes prompt for approval. |
| **Analyst** | Read-only | Explore production data safely, run cost analysis. SQL writes denied entirely. |
| **Plan** | Minimal | Plan an approach before switching to builder to execute it |

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

| Skill | Purpose |
|---|---|
| `/query-optimize` | Optimize slow queries with anti-pattern detection |
| `/sql-review` | SQL quality gate with grading |
| `/sql-translate` | Cross-dialect SQL translation |
| `/cost-report` | Snowflake/Databricks cost analysis |
| `/pii-audit` | Scan for PII exposure |
| `/dbt-develop` | Scaffold new dbt models |
| `/dbt-test` | Generate dbt tests |
| `/dbt-docs` | Generate dbt documentation |
| `/dbt-analyze` | Column-level lineage and impact analysis |
| `/dbt-troubleshoot` | Debug dbt errors |
| `/data-viz` | Interactive dashboards and visualizations |
| `/teach` | Teach patterns from example files |
| `/train` | Load standards from documents |

You don't need to memorize these — describe what you want in plain English and the agent routes to the right skill automatically.

### Custom skills

Add your own skills as Markdown files in `.altimate-code/skill/`:

```markdown
---
name: cost-review
description: Review SQL queries for cost optimization
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

| Agent | File writes | SQL writes | Bash | Training |
|---|---|---|---|---|
| Builder | allow | ask (prompts for approval) | ask | allow |
| Analyst | deny | deny (blocked entirely) | deny (safe commands auto-allowed) | allow |
| Plan | deny | deny | deny | deny |

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
- [CI & Automation](../data-engineering/guides/ci-headless.md): Run altimate in automated pipelines
