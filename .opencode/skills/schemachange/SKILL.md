---
name: schemachange
description:
  Deploying and managing Snowflake database objects using version control with schemachange. Use
  this skill when you need to manage database migrations for objects not handled by dbt, implement
  CI/CD pipelines for schema changes, or coordinate deployments across multiple environments.
tags: ["snowflake"]
---

# Schemachange

Deploy and manage Snowflake database changes using version control and CI/CD pipelines with
schemachange's migration-based approach.

## Quick Start

**Script Types:**

- **V\_\_ (Versioned)** - One-time structural changes (run exactly once)
- **R\_\_ (Repeatable)** - Objects that can be safely recreated (runs when new/modified)
- **A\_\_ (Always)** - Scripts that run every deployment (must be idempotent)

## Script Naming

### Versioned Scripts (V\_\_)

```sql
V1.0.0__initial_setup.sql
V1.1.0__create_base_tables.sql
V2.0.0__restructure_schema.sql
```

Use for: CREATE TABLE, ALTER TABLE, CREATE SCHEMA

### Repeatable Scripts (R\_\_)

```sql
R__Stage_01_create_views.sql
R__Stage_02_alter_procedures.sql
R__Stage_03_utility_functions.sql
```

Use for: CREATE OR ALTER VIEW, CREATE OR ALTER PROCEDURE, CREATE OR REPLACE STREAM

### Always Scripts (A\_\_)

```sql
A__refresh_permissions.sql
A__update_config_values.sql
```

Use for: Jobs that must run every deployment (idempotent only)

## Key Concepts

### Execution Order

1. Versioned scripts (V\_\_) in numeric order
2. Repeatable scripts (R\_\_) in alphabetic order (use naming to control)
3. Always scripts (A\_\_) in alphabetic order

### CREATE OR ALTER vs CREATE OR REPLACE

- **CREATE OR ALTER** - Preserves data, tags, policies, grants (preferred)
- **CREATE OR REPLACE** - Drops and recreates (loses metadata)

See `CREATE_OR_ALTER_REFERENCE.md` for supported objects.

## Configuration

```yaml
# schemachange-config.yml
root-folder: migrations
create-change-history-table: true
connection-name: default
change-history-table: MY_DB.SCHEMACHANGE.CHANGE_HISTORY
```

## Deployment

```bash
# Dry run
schemachange deploy --config-folder . --dry-run

# Deploy
schemachange deploy --config-folder .

# With variables
schemachange deploy --vars '{"env":"prod","schema":"data"}'
```

## Resources

- `schemachange-config.yml` - Complete configuration template
- `SCRIPT_PATTERNS.md` - Examples for V**, R**, A\_\_ scripts (coming soon)
- `CREATE_OR_ALTER_REFERENCE.md` - Supported object types (coming soon)
- `CI_CD_EXAMPLES.md` - GitHub Actions and Azure DevOps patterns (coming soon)
