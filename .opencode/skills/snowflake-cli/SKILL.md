---
name: snowflake-cli
description:
  Executing SQL, managing Snowflake objects, deploying applications, and orchestrating data
  pipelines using the Snowflake CLI (snow) command. Use this skill when you need to run SQL scripts,
  deploy Streamlit apps, execute Snowpark procedures, manage stages, automate Snowflake operations
  from CI/CD pipelines, or work with variables and templating.
tags: ["snowflake"]
---

# Snowflake CLI (snow)

Execute SQL, manage Snowflake objects, and deploy applications using the Snowflake CLI command-line
tool.

## When to Use This Skill

Activate this skill when users ask about:

- Running SQL queries and scripts from command line
- Deploying Streamlit applications to Snowflake
- Managing Snowflake stages (upload/download/execute files)
- Using variables and templating in SQL scripts
- Executing Snowpark procedures and Python scripts
- Managing database objects (warehouses, tables, etc.)
- Automating Snowflake operations in CI/CD pipelines
- Multi-environment deployments with variables
- Troubleshooting CLI connection or execution issues

## Quick Start

**Three Main Use Cases:**

1. **SQL Execution** - Run queries and scripts with variable substitution
2. **Deployments** - Deploy Streamlit apps and Snowpark objects
3. **Stage Operations** - Manage files and execute scripts from stages

### Connection Behavior

**Important:** The Snowflake CLI uses the **`default`** connection profile from
`~/.snowflake/connections.toml` unless you specify a different connection with the `-c` or
`--connection` flag.

```bash
# Uses 'default' connection (implicit)
snow sql -q "SELECT CURRENT_USER()"

# Uses 'default' connection (explicit)
snow sql -q "SELECT CURRENT_USER()" -c default

# Uses specific named connection
snow sql -q "SELECT CURRENT_USER()" -c prod
```

**For connection configuration**, see the **`snowflake-connections` skill**.

## SQL Execution

```bash
# Inline query
snow sql -q "SELECT * FROM my_table" -c default

# Execute file
snow sql -f script.sql -c default

# With variables (Jinja {{ }} or <% %> syntax)
snow sql -q "SELECT * FROM {{db}}.{{schema}}.table" \
  -D db=PROD_DB -D schema=SALES -c default
```

## Variables & Templating

**Critical Concept:** Snowflake CLI supports three different variable syntaxes depending on context.

### Three Syntax Types

**1. Bash Variables** - Shell expansion (for environment control):

```bash
DB="PROD_DB"
SCHEMA="SALES"
snow sql -q "SELECT * FROM ${DB}.${SCHEMA}.orders" -c default
```

**Use for:** Connection names, file paths, environment selection, shell control flow

**2. Standard Syntax `<% %>`** - Default for `snow sql` commands:

```bash
# Single-line query with -q flag
snow sql -q "SELECT * FROM <% db %>.<% schema %>.orders" \
  -D db=PROD_DB -D schema=SALES -c default

# Multi-line query with -i flag (reads from stdin)
# The -i flag tells snow sql to read SQL from standard input
# <<EOF creates a here-document that feeds multi-line SQL to stdin
snow sql -i -D db=PROD_DB -D schema=SALES -c default <<EOF
SELECT
  order_id,
  customer_id,
  order_total
FROM <% db %>.<% schema %>.orders
WHERE order_date >= CURRENT_DATE - 7;
EOF
```

**Understanding heredoc (`<<EOF`):**

- `<<EOF` - Start of here-document (ends with matching `EOF`)
- SQL between the markers is fed to `snow sql -i` as standard input
- Variables are substituted using `<% %>` syntax
- Useful for readable multi-line SQL without escaping quotes
- The closing `EOF` must be on its own line with no indentation

**Combining bash variables with heredoc for multi-statement scripts:**

```bash
# Set bash variables for environment and database objects
ENV="prod"
CONNECTION="${ENV}_connection"
DB="PROD_DB"
SCHEMA="SALES"
TABLE="orders"

# Heredoc enables multiple SQL statements and complex scripts
# without worrying about quote escaping or line continuations
# Bash expands ${variables} before sending to Snowflake
snow sql -i -c ${CONNECTION} <<EOF
-- Create or replace view
CREATE OR REPLACE VIEW ${DB}.${SCHEMA}.recent_${TABLE} AS
SELECT
  order_id,
  customer_id,
  order_total,
  order_date,
  '${ENV}' as environment
FROM ${DB}.${SCHEMA}.${TABLE}
WHERE order_date >= CURRENT_DATE - 7;

-- Grant permissions
GRANT SELECT ON VIEW ${DB}.${SCHEMA}.recent_${TABLE} TO ROLE ANALYST;

-- Verify row count
SELECT
  COUNT(*) as row_count,
  MIN(order_date) as earliest_date,
  MAX(order_date) as latest_date
FROM ${DB}.${SCHEMA}.recent_${TABLE};
EOF
```

**Why use heredoc:**

- ✅ Multiple SQL statements in one execution
- ✅ No quote escaping needed for complex SQL
- ✅ Readable multi-line scripts with comments
- ✅ Bash expands `${VAR}` before sending to Snowflake
- ✅ Natural formatting for longer migration or deployment scripts

**When to use bash vs Snowflake CLI variables:**

- **Bash `${VAR}`** - Simple, expanded before execution (use for most cases)
- **Snowflake CLI `<% var %>`** - Use with `-D` flags when you need Snowflake CLI to handle
  substitution (safer for user input)

**Use for:** Inline SQL and heredoc with `snow sql -q` or `snow sql -i`

**3. Jinja Syntax `{{ }}`** - Automatic for staged SQL files:

```bash
# SQL files on stage use Jinja automatically (no flag needed)
snow stage execute @my_stage/script.sql -c default \
  -D db=PROD_DB \
  -D schema=SALES
```

**Use for:** SQL files executed from stages with `snow stage execute`

### Template Syntax Control

Control which syntaxes are enabled with `--enable-templating`:

```bash
# STANDARD (default): <% var %> only
snow sql -q "SELECT <% var %>" -D var=value

# JINJA: {{ var }} only
snow sql --enable-templating JINJA -q "SELECT {{ var }}" -D var=value

# LEGACY: &var or &{var} (SnowSQL compatibility)
snow sql --enable-templating LEGACY -q "SELECT &var" -D var=value

# ALL: Enable all syntaxes
snow sql --enable-templating ALL -q "SELECT <% var %> {{ var }}" -D var=value

# NONE: Disable templating (useful for queries containing template-like text)
snow sql --enable-templating NONE -q "SELECT '<% not_a_var %>'"
```

**Default:** `STANDARD` and `LEGACY` are enabled by default

### Important Notes

- **Stage execution automatically uses Jinja** - SQL files uploaded to stages should use `{{ var }}`
  syntax
- **String values need quotes** - Use `-D name="'John'"` for string literals
- **Enable Jinja explicitly** - Add `--enable-templating JINJA` to use `{{ }}` with `snow sql`
  commands
- **Combining variable types** - Use bash for environment, `<% %>` for SQL:

  ```bash
  ENV="prod"
  CONNECTION="${ENV}_connection"
  snow sql -c ${CONNECTION} -i -D db=PROD_DB <<EOF
  SELECT * FROM <% db %>.orders;
  EOF
  ```

### Comparison Table

| Feature             | Bash Variables   | Standard `<% %>`         | Jinja `{{ }}`             |
| ------------------- | ---------------- | ------------------------ | ------------------------- |
| **Resolved by**     | Shell            | Snowflake CLI            | Snowflake CLI             |
| **When resolved**   | Before CLI runs  | Before sent to Snowflake | Before sent to Snowflake  |
| **Define with**     | `VAR=value`      | `-D var=value`           | `-D var=value`            |
| **Use in command**  | `${VAR}`         | `<% var %>`              | `{{ var }}`               |
| **Default enabled** | Always           | Yes                      | No (except stage execute) |
| **Best for**        | Shell operations | SQL templating           | SQL files on stage        |

## Deployments

### Streamlit Apps

```sql
snow streamlit deploy --replace -c default
snow streamlit list -c default
snow streamlit get-url my_app -c default
```

### Snowpark (UDFs/Procedures)

```sql
snow snowpark build -c default
snow snowpark deploy --replace -c default
```

### Project Creation

See `PROJECT_CREATION.md` for:

- How to create app projects
- Streamlit project structures
- Snowpark object projects

## Stage Operations

**Quick Commands:**

```sql
# Upload/download files
snow stage copy ./script.sql @my_stage/ -c default
snow stage copy @my_stage/file.csv ./downloads/ -c default

# List files
snow stage list-files @my_stage -c default

# Execute SQL (uses Jinja {{ }} syntax automatically)
snow stage execute @my_stage/script.sql -c default -D db=PROD_DB

# Execute Python (access variables via os.environ)
snow stage execute @my_stage/script.py -c default -D var=value
```

**For comprehensive stage management**, see `STAGE_OPERATIONS.md` for:

- Complete file operations (upload, download, list, remove)
- Variable syntax for SQL vs Python scripts
- Multi-file execution patterns
- Integration with schemachange
- Troubleshooting guide

## Object Management

```sql
# List objects
snow object list warehouse -c default
snow object list table -c default

# Describe object
snow object describe table my_table -c default

# Create object
snow object create warehouse my_wh --size SMALL -c default
```

## Connection Configuration

**All Snowflake CLI commands use the `-c` flag to specify connection profiles:**

```sql
snow sql -c default -q "SELECT * FROM table"
snow sql -c prod -q "SELECT * FROM table"
```

**For complete connection setup**, see the **`snowflake-connections` skill** for:

- Creating `~/.snowflake/connections.toml`
- All authentication methods (SSO, key pair, OAuth, username/password)
- Multiple environment configurations (dev, staging, prod)
- Environment variable overrides
- Security best practices and troubleshooting

## Common Patterns

### Multi-Environment Deployment

```sql
#!/bin/bash
ENV="${1:-dev}"

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

snow sql -c default -i -D db=$DB -D schema=$SCHEMA <<EOF
CREATE OR REPLACE TABLE <% db %>.<% schema %>.my_table AS
SELECT * FROM <% db %>.<% schema %>.source_table;
EOF
```

**For stage-specific patterns**, see `STAGE_OPERATIONS.md` for:

- Migration scripts from stage
- Data pipeline execution
- Multi-environment deployments with stages
- CI/CD integration examples

---

## Troubleshooting

### Variable Not Substituted

**Problem:** Variable appears literally in SQL (e.g., `SELECT * FROM <% db %>.orders`)

**Solutions:**

1. Check syntax matches command type:
   - `snow sql -q` → Use `<% var %>`
   - `snow stage execute` → Use `{{ var }}`
   - Bash expansion → Use `${var}`
2. Verify `-D` flag is before SQL
3. Ensure proper quoting for string values: `-D name="'John'"`

### Syntax Conflicts

**Problem:** Query contains template-like text

**Example:** `snow sql -q "SELECT '<% not_a_variable %>'"`

**Solution:** Disable templating

```sql
snow sql --enable-templating NONE -q "SELECT '<% not_a_variable %>'"
```

### Stage Execute Variables

**Problem:** Variables not working with `snow stage execute`

**Solution:** Use Jinja `{{ }}` syntax (default for stage execute)

```sql
# ✅ CORRECT
snow stage execute @stage/script.sql -D var=value

# In script.sql: SELECT * FROM {{ var }}.table
```

### Permission Errors

**Problem:** `SQL access control error: Insufficient privileges`

**Solution:** Grant appropriate permissions:

```sql
GRANT USAGE ON STAGE my_stage TO ROLE my_role;
GRANT READ, WRITE ON STAGE my_stage TO ROLE my_role;
```

### Connection Failed

**Problem:** Can't connect to Snowflake

**Quick Test:**

```sql
snow connection test -c default
```

**For comprehensive connection troubleshooting**, see the **`snowflake-connections` skill**

---

## Quick Reference

```sql
# Bash variables (shell expansion)
DB="PROD"
snow sql -c default -q "USE ${DB}_DATABASE"

# Standard syntax (default)
snow sql -c default -q "USE <% db %>" -D db=PROD

# Jinja syntax (explicit)
snow sql --enable-templating JINJA -c default -q "USE {{ db }}" -D db=PROD

# Stage execute (Jinja automatic)
snow stage execute @stage/script.sql -D db=PROD

# Disable templating
snow sql --enable-templating NONE -q "SELECT '<% literal %>'"

# String values need quotes
snow sql -D name="'John'" -D date="'2024-01-01'"

# Test connection
snow connection test -c default

# Multi-environment pattern
ENV="${1:-dev}"
case $ENV in
  dev) DB="DEV_DB" ;;
  prod) DB="PROD_DB" ;;
esac
snow sql -c default -i -D db=$DB <<EOF
SELECT * FROM <% db %>.orders;
EOF
```

---

## Best Practices

✅ **DO:**

- Use bash variables for environment selection
- Use `<% %>` for inline SQL queries
- Use `{{ }}` for staged SQL files (automatic)
- Organize staged scripts in subdirectories
- Quote string variable values: `-D name="'value'"`
- Test locally before deploying to production
- Use multiple connections for different environments

❌ **DON'T:**

- Mix variable syntaxes incorrectly
- Hardcode environment-specific values
- Use `{{ }}` with `snow sql` without `--enable-templating JINJA`
- Forget to grant stage permissions
- Skip error handling in automation scripts

---

## References

- **`STAGE_OPERATIONS.md`** - Comprehensive stage management and script execution
- `snowflake-connections` skill - Connection setup and authentication
- **[Snowflake CLI Documentation](https://docs.snowflake.com/en/developer-guide/snowflake-cli/index)** -
  Official documentation

---

**Goal:** Transform AI agents into expert Snowflake CLI operators who efficiently execute SQL,
manage stages, deploy applications, and automate operations with proper variable handling and
connection configuration.
