---
name: "databricks"
description: "Databricks CLI operations: auth, profiles, data exploration, and bundles. Contains up-to-date guidelines for Databricks-related CLI tasks."
compatibility: Requires databricks CLI (>= v0.292.0)
metadata:
  version: "0.1.0"
tags: ["databricks"]
---

# Databricks

Core skill for Databricks CLI, authentication, and data exploration.

## Product Skills

For specific products, use dedicated skills:
- **databricks-jobs** - Lakeflow Jobs development and deployment
- **databricks-pipelines** - Lakeflow Spark Declarative Pipelines (batch and streaming data pipelines)
- **databricks-apps** - Full-stack TypeScript app development and deployment
- **databricks-lakebase** - Lakebase Postgres Autoscaling project management

## Prerequisites

1. **CLI installed**: Run `databricks --version` to check.
   - **If the CLI is missing or outdated (< v0.292.0): STOP. Do not proceed or work around a missing CLI.**
   - **Read the [CLI Installation](databricks-cli-install.md) reference file and follow the instructions to guide the user through installation.**
   - Note: In sandboxed environments (Cursor IDE, containers), install commands write outside the workspace and may be blocked. Present the install command to the user and ask them to run it in their own terminal.

2. **Authenticated**: `databricks auth profiles`
   - If not: see [CLI Authentication](databricks-cli-auth.md)

## Profile Selection - CRITICAL

**NEVER auto-select a profile.**

1. List profiles: `databricks auth profiles`
2. Present ALL profiles to user with workspace URLs
3. Let user choose (even if only one exists)
4. Offer to create new profile if needed

## Claude Code - IMPORTANT

Each Bash command runs in a **separate shell session**.

```bash
# WORKS: --profile flag
databricks apps list --profile my-workspace

# WORKS: chained with &&
export DATABRICKS_CONFIG_PROFILE=my-workspace && databricks apps list

# DOES NOT WORK: separate commands
export DATABRICKS_CONFIG_PROFILE=my-workspace
databricks apps list  # profile not set!
```

## Data Exploration — Use AI Tools

**Use these instead of manually navigating catalogs/schemas/tables:**

```bash
# discover table structure (columns, types, sample data, stats)
databricks experimental aitools tools discover-schema catalog.schema.table --profile <PROFILE>

# run ad-hoc SQL queries
databricks experimental aitools tools query "SELECT * FROM table LIMIT 10" --profile <PROFILE>

# find the default warehouse
databricks experimental aitools tools get-default-warehouse --profile <PROFILE>
```

See [Data Exploration](data-exploration.md) for details.

## Quick Reference

**⚠️ CRITICAL: Some commands use positional arguments, not flags**

```bash
# current user
databricks current-user me --profile <PROFILE>

# list resources
databricks apps list --profile <PROFILE>
databricks jobs list --profile <PROFILE>
databricks clusters list --profile <PROFILE>
databricks warehouses list --profile <PROFILE>
databricks pipelines list --profile <PROFILE>
databricks serving-endpoints list --profile <PROFILE>

# ⚠️ Unity Catalog — POSITIONAL arguments (NOT flags!)
databricks catalogs list --profile <PROFILE>

# ✅ CORRECT: positional args
databricks schemas list <CATALOG> --profile <PROFILE>
databricks tables list <CATALOG> <SCHEMA> --profile <PROFILE>
databricks tables get <CATALOG>.<SCHEMA>.<TABLE> --profile <PROFILE>

# ❌ WRONG: these flags/commands DON'T EXIST
# databricks schemas list --catalog-name <CATALOG>    ← WILL FAIL
# databricks tables list --catalog <CATALOG>           ← WILL FAIL
# databricks sql-warehouses list                       ← doesn't exist, use `warehouses list`
# databricks execute-statement                         ← doesn't exist, use `experimental aitools tools query`
# databricks sql execute                               ← doesn't exist, use `experimental aitools tools query`

# When in doubt, check help:
# databricks schemas list --help

# get details
databricks apps get <NAME> --profile <PROFILE>
databricks jobs get --job-id <ID> --profile <PROFILE>
databricks clusters get --cluster-id <ID> --profile <PROFILE>

# bundles
databricks bundle init --profile <PROFILE>
databricks bundle validate --profile <PROFILE>
databricks bundle deploy -t <TARGET> --profile <PROFILE>
databricks bundle run <RESOURCE> -t <TARGET> --profile <PROFILE>
```

## Troubleshooting

| Error | Solution |
|-------|----------|
| `cannot configure default credentials` | Use `--profile` flag or authenticate first |
| `PERMISSION_DENIED` | Check workspace/UC permissions |
| `RESOURCE_DOES_NOT_EXIST` | Verify resource name/id and profile |

## Required Reading by Task

| Task | READ BEFORE proceeding |
|------|------------------------|
| First time setup | [CLI Installation](databricks-cli-install.md) |
| Auth issues / new workspace | [CLI Authentication](databricks-cli-auth.md) |
| Exploring tables/schemas | [Data Exploration](data-exploration.md) |
| Deploying jobs/pipelines | [Asset Bundles](asset-bundles.md) |

## Reference Guides

- [CLI Installation](databricks-cli-install.md)
- [CLI Authentication](databricks-cli-auth.md)
- [Data Exploration](data-exploration.md)
- [Asset Bundles](asset-bundles.md)
