# Agent Skills

Skills are reusable prompt templates that extend agent capabilities. Invoke them as slash commands in the TUI.

## Skill Format

Skills are markdown files named `SKILL.md`:

```markdown
---
name: cost-review
description: Review SQL queries for cost optimization
---

Analyze the SQL query for cost optimization opportunities:

1. Check for full table scans
2. Evaluate partition pruning
3. Suggest clustering keys
4. Estimate credit impact
5. Recommend cheaper alternatives

Focus on the query: $ARGUMENTS
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Skill name |
| `description` | Yes | Short description |

## Discovery Paths

Skills are loaded from these locations (in priority order):

1. **External directories** (if not disabled):
    - `~/.claude/skills/`
    - `~/.agents/skills/`
    - `.claude/skills/` (project, searched up tree)
    - `.agents/skills/` (project, searched up tree)

2. **altimate-code directories**:
    - `.altimate-code/skill/`
    - `.altimate-code/skills/`

3. **Custom paths** (from config):

    ```json
    {
      "skills": {
        "paths": ["./my-skills", "~/shared-skills"]
      }
    }
    ```

4. **Remote URLs** (from config):

    ```json
    {
      "skills": {
        "urls": ["https://example.com/skills-registry.json"]
      }
    }
    ```

## Built-in Skills

Altimate Code ships with 11 built-in skills for data engineering workflows.

### SQL & Analysis

| Skill | Description | Usage |
|-------|-------------|-------|
| `/cost-report` | Analyze Snowflake query costs, credit consumption by user/warehouse, and identify optimization opportunities | `/cost-report` |
| `/query-optimize` | Analyze and optimize SQL queries for better performance using `sql_optimize` and `sql_analyze` | `/query-optimize SELECT * FROM users ORDER BY name` |
| `/sql-translate` | Translate SQL between database dialects (Snowflake, BigQuery, PostgreSQL, Databricks, etc.) | `/sql-translate snowflake bigquery SELECT DATEADD(...)` |
| `/impact-analysis` | Analyze downstream impact of changes to a dbt model by combining column-level lineage with the dbt dependency graph | `/impact-analysis stg_orders` |
| `/lineage-diff` | Compare column-level lineage between two versions of a SQL query to show added, removed, and changed data flow edges | `/lineage-diff models/marts/dim_customers.sql` |

### dbt

| Skill | Description | Usage |
|-------|-------------|-------|
| `/generate-tests` | Generate dbt test definitions from table metadata — unique, not_null, relationships, accepted_values | `/generate-tests models/staging/stg_orders.sql` |
| `/model-scaffold` | Scaffold a new dbt model following staging/intermediate/mart patterns with proper naming and structure | `/model-scaffold staging orders from raw.public.orders` |
| `/dbt-docs` | Generate or improve dbt model documentation — column descriptions, model descriptions, and doc blocks | `/dbt-docs models/marts/fct_revenue.sql` |
| `/yaml-config` | Generate dbt YAML configuration — sources.yml, schema.yml, or properties.yml — from warehouse schema | `/yaml-config sources raw.stripe` |
| `/incremental-logic` | Add or fix incremental materialization logic — is_incremental(), unique keys, merge strategies | `/incremental-logic models/marts/fct_orders.sql` |
| `/medallion-patterns` | Apply medallion architecture (bronze/silver/gold) patterns to organize dbt models into clean data layers | `/medallion-patterns audit` |

## Disabling External Skills

```bash
export ALTIMATE_CLI_DISABLE_EXTERNAL_SKILLS=true
```

This disables skill discovery from `~/.claude/skills/` and `~/.agents/skills/` but keeps `.altimate-code/skill/` discovery active.

## Duplicate Handling

If multiple skills share the same name, project-level skills override global skills. A warning is logged when duplicates are found.
