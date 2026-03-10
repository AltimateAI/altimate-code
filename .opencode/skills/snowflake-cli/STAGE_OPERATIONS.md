---
name: Snowflake CLI Stage Operations
description:
  Complete reference guide for managing files and executing scripts on Snowflake stages using the
  Snowflake CLI. Covers upload/download, execution, stage management, and advanced operations.
tags: ["snowflake"]
---

# Snowflake CLI Stage Operations

Complete guide to managing files and executing scripts on Snowflake stages.

---

## Stage Management

### File Operations

#### Upload Files

```bash
# Upload single file
snow stage copy ./script.sql @my_stage/ -c default

# Upload directory
snow stage copy ./local_files/ @my_stage/scripts/ -c default

# Upload with overwrite
snow stage copy ./file.csv @my_stage/ --overwrite -c default

# Upload to specific path
snow stage copy ./data.json @my_stage/data/2024/ -c default
```

#### Download Files

```bash
# Download single file
snow stage copy @my_stage/file.csv ./downloads/ -c default

# Download directory
snow stage copy @my_stage/data/ ./local_data/ -c default

# Download all files from stage
snow stage copy @my_stage/ ./ -c default
```

#### List Files

```bash
# List all files in stage
snow stage list-files @my_stage -c default

# List files in specific path
snow stage list-files @my_stage/scripts/ -c default

# List with pattern
snow stage list-files @my_stage/data/*.csv -c default
```

#### Remove Files

```bash
# Remove single file
snow stage remove @my_stage/old_file.csv -c default

# Remove multiple files with pattern
snow stage remove @my_stage/archive/*.sql -c default

# Remove directory
snow stage remove @my_stage/temp/ -c default
```

---

## Executing Scripts from Stage

### SQL Scripts

SQL files executed from stage use **Jinja `{{ }}` syntax** by default for variables.

```bash
# Execute single SQL file
snow stage execute @my_stage/script.sql -c default \
  -D database=MY_DB \
  -D schema=MY_SCHEMA

# Execute multiple files with glob pattern
snow stage execute @my_stage/migrations/*.sql -c default \
  -D database=MY_DB

# Execute with string variables (must be quoted)
snow stage execute @my_stage/script.sql -c default \
  -D name="'John'" \
  -D date="'2024-01-01'"
```

**Example SQL file with Jinja variables:**

```sql
-- script.sql
CREATE OR REPLACE TABLE {{ database }}.{{ schema }}.customers AS
SELECT * FROM {{ database }}.RAW.customers
WHERE created_date >= '{{ date }}';
```

### Python Scripts

Python files run as Snowpark procedures. Variables are set in `os.environ`.

```bash
# Execute Python script
snow stage execute @my_stage/process_data.py -c default \
  -D database=MY_DB \
  -D table=CUSTOMERS

# Python script with requirements.txt
# Upload both files to same stage directory
snow stage copy requirements.txt @my_stage/ -c default
snow stage copy script.py @my_stage/ -c default
snow stage execute @my_stage/script.py -c default
```

**Example Python script:**

```python
# process_data.py
import os
import snowflake.snowpark as snowpark

def main(session: snowpark.Session):
    database = os.environ.get('database', 'MY_DB')
    table = os.environ.get('table', 'MY_TABLE')

    df = session.table(f"{database}.PUBLIC.{table}")
    result = df.count()

    return f"Processed {result} rows from {database}.{table}"
```

---

## Variable Syntax Differences

| Command Type                  | Variable Syntax       | Example                                           |
| ----------------------------- | --------------------- | ------------------------------------------------- |
| `snow sql -q`                 | `<% var %>` (default) | `snow sql -q "SELECT <% var %>" -D var=value`     |
| `snow sql -i`                 | `<% var %>` (default) | `snow sql -i -D var=value <<< "SELECT <% var %>"` |
| `snow stage execute` (SQL)    | `{{ var }}` (Jinja)   | `snow stage execute @stage/file.sql -D var=value` |
| `snow stage execute` (Python) | `os.environ['var']`   | Access via `os.environ.get('var')`                |

**Key Point:** SQL files on stage use Jinja `{{ }}` syntax automatically. No need to specify
`--enable-templating JINJA`.

---

## Common Patterns

### Migration Scripts

```bash
# Upload migration scripts
snow stage copy migrations/ @migration_stage/v1.0/ -c default

# Execute in order with variables
snow stage execute @migration_stage/v1.0/01_create_tables.sql -c default \
  -D target_db=PROD_DB \
  -D target_schema=PUBLIC

snow stage execute @migration_stage/v1.0/02_create_views.sql -c default \
  -D target_db=PROD_DB \
  -D target_schema=PUBLIC
```

### Data Pipeline Execution

```bash
#!/bin/bash

# Stage data processing scripts
STAGE="@etl_scripts"
DB="ANALYTICS_DB"
SCHEMA="ETL"

# Upload scripts
snow stage copy ./scripts/ ${STAGE}/ -c default --overwrite

# Execute pipeline
echo "Starting ETL pipeline..."

snow stage execute ${STAGE}/extract.sql -c default \
  -D database=${DB} \
  -D schema=${SCHEMA}

snow stage execute ${STAGE}/transform.py -c default \
  -D database=${DB} \
  -D schema=${SCHEMA}

snow stage execute ${STAGE}/load.sql -c default \
  -D database=${DB} \
  -D schema=${SCHEMA}

echo "ETL pipeline complete"
```

### Multi-Environment Deployment

```bash
#!/bin/bash

ENV="${1:-dev}"
STAGE="@deployment_scripts"

case $ENV in
  dev)
    DB="DEV_DB"
    SCHEMA="DEV_SCHEMA"
    ;;
  prod)
    DB="PROD_DB"
    SCHEMA="PROD_SCHEMA"
    ;;
esac

# Deploy to environment
snow stage execute ${STAGE}/deploy.sql -c default \
  -D target_database=${DB} \
  -D target_schema=${SCHEMA} \
  -D environment=${ENV}
```

---

## Best Practices

### ✅ DO

- **Organize files by purpose** - Use subdirectories on stages (e.g., `@stage/migrations/`,
  `@stage/procedures/`)
- **Use glob patterns** - Execute multiple files at once with `*.sql`
- **Version your scripts** - Include version in stage path (e.g., `@stage/v1.0/`)
- **Include requirements.txt** - For Python scripts needing external libraries
- **Quote string variables** - Use `-D name="'value'"` for strings
- **Use Jinja {{ }} syntax** - For SQL files on stage (automatic)
- **Test locally first** - Use `snow sql` to test queries before staging

### ❌ DON'T

- **Don't use `<% %>` syntax** - In staged SQL files (use `{{ }}` instead)
- **Don't hardcode values** - Use variables for environment-specific values
- **Don't skip error handling** - Check script output and return codes
- **Don't forget permissions** - Ensure role has USAGE on stage
- **Don't leave old files** - Clean up outdated scripts regularly

---

## Troubleshooting

### Permission Denied

**Error:** `SQL access control error: Insufficient privileges`

**Solution:**

```sql
-- Grant stage permissions
GRANT USAGE ON STAGE my_stage TO ROLE my_role;
GRANT READ ON STAGE my_stage TO ROLE my_role;
GRANT WRITE ON STAGE my_stage TO ROLE my_role;
```

### File Not Found

**Error:** `File not found: @my_stage/script.sql`

**Solution:**

```bash
# List files to verify path
snow stage list-files @my_stage -c default

# Check exact path
snow stage list-files @my_stage/scripts/ -c default
```

### Variable Not Substituted in Staged SQL

**Problem:** `{{ var }}` appears literally in output

**Solution:** Ensure using Jinja syntax (not `<% %>`)

```sql
-- ✅ CORRECT for staged SQL
SELECT * FROM {{ database }}.{{ schema }}.table;

-- ❌ WRONG for staged SQL
SELECT * FROM <% database %>.<% schema %>.table;
```

### Python Script Fails

**Error:** `ModuleNotFoundError: No module named 'package'`

**Solution:** Upload requirements.txt to same stage directory

```bash
# Create requirements.txt
echo "pandas==2.0.0" > requirements.txt

# Upload both files
snow stage copy requirements.txt @my_stage/ -c default
snow stage copy script.py @my_stage/ -c default

# Execute (will install dependencies from Snowflake Anaconda)
snow stage execute @my_stage/script.py -c default
```

---

## Integration with schemachange

Schemachange can reference scripts on stages:

```sql
-- In schemachange script: R__execute_staged_procedure.sql
-- Execute script from stage
EXECUTE IMMEDIATE FROM @deployment_stage/procedures/update_metrics.sql;
```

Combined workflow:

```bash
# 1. Upload scripts to stage
snow stage copy ./procedures/ @deployment_stage/procedures/ -c default

# 2. Use schemachange to execute them
schemachange deploy --config-folder . -c default
```

---

## Quick Reference

```bash
# Upload
snow stage copy ./local_file.sql @stage/ -c default

# Download
snow stage copy @stage/file.sql ./ -c default

# List
snow stage list-files @stage -c default

# Remove
snow stage remove @stage/file.sql -c default

# Execute SQL (uses Jinja {{ }} automatically)
snow stage execute @stage/script.sql -c default -D var=value

# Execute Python
snow stage execute @stage/script.py -c default -D var=value

# Execute multiple files
snow stage execute @stage/migrations/*.sql -c default -D db=MY_DB

# String variables need quotes
-D name="'John'" -D date="'2024-01-01'"
```

---

**Related Documentation:**

- **`snowflake-cli` skill** - Variable syntax and templating guide
- **`snowflake-connections` skill** - Connection configuration and authentication
