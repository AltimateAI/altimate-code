# Data Exploration

Tools for discovering table schemas and executing SQL queries in Databricks.

## Finding Tables by Keyword

**⚠️ START HERE if you don't know which catalog/schema contains your data.**

Use `information_schema` to search for tables by keyword — do NOT manually iterate through `catalogs list` → `schemas list` → `tables list`. Manual enumeration wastes 10+ steps.

```bash
# Find tables matching a keyword
databricks experimental aitools tools query \
  "SELECT table_catalog, table_schema, table_name FROM system.information_schema.tables WHERE table_name LIKE '%keyword%'" \
  --profile <PROFILE>

# Then discover schema for the tables you found
databricks experimental aitools tools discover-schema catalog.schema.table1 catalog.schema.table2 --profile <PROFILE>
```

## Overview

The `databricks experimental aitools tools` command group provides tools for data discovery and exploration:
- **discover-schema**: Batch discover table metadata, columns, types, sample data, and statistics
- **query**: Execute SQL queries against Databricks SQL warehouses

**When to use this**: Use these commands whenever you need to:
- Discover table schemas and metadata
- Execute SQL queries against warehouse data
- Explore data structure and content
- Validate data or check table statistics

## Prerequisites

1. **Authenticated Databricks CLI** - see [CLI Authentication Guide](databricks-cli-auth.md) for OAuth2 setup and profile configuration
2. **Access to Unity Catalog tables** with appropriate read permissions
3. **SQL Warehouse** (for query command - auto-detected unless `DATABRICKS_WAREHOUSE_ID` is set)

## Discover Schema

Batch discover table metadata including columns, types, sample data, and null counts.

### Command Syntax

```bash
databricks experimental aitools tools discover-schema TABLE... [flags]
```

Tables must be specified in **CATALOG.SCHEMA.TABLE** format.

### What It Returns

For each table, returns:
- Column names and types
- Sample data (5 rows)
- Null counts per column
- Total row count

### Examples

```bash
# Discover schema for a single table
databricks experimental aitools tools discover-schema samples.nyctaxi.trips --profile my-workspace

# Discover schema for multiple tables
databricks experimental aitools tools discover-schema \
  catalog.schema.table1 \
  catalog.schema.table2 \
  --profile my-workspace

# Get JSON output
databricks experimental aitools tools discover-schema \
  samples.nyctaxi.trips \
  --output json \
  --profile my-workspace
```

### Common Use Cases

1. **Understanding table structure before querying**
   ```bash
   databricks experimental aitools tools discover-schema catalog.schema.customer_data --profile my-workspace
   ```

2. **Comparing schemas across multiple tables**
   ```bash
   databricks experimental aitools tools discover-schema \
     catalog.schema.table_v1 \
     catalog.schema.table_v2 \
     --profile my-workspace
   ```

3. **Identifying columns with null values**
   - The null counts help identify data quality issues

## Query

Execute SQL statements against a Databricks SQL warehouse and return results.

### Command Syntax

```bash
databricks experimental aitools tools query "SQL" [flags]
```

### Warehouse Selection

The command **auto-detects** an available warehouse unless:
- `DATABRICKS_WAREHOUSE_ID` environment variable is set
- You specify a warehouse using other configuration methods

To check which warehouse will be used:
```bash
# Get the default warehouse that would be auto-detected
databricks experimental aitools tools get-default-warehouse --profile my-workspace
```

### Output

Returns:
- Query results as JSON
- Row count
- Execution metadata

### Examples

```bash
# Simple SELECT query
databricks experimental aitools tools query \
  "SELECT * FROM samples.nyctaxi.trips LIMIT 5" \
  --profile my-workspace

# Aggregation query
databricks experimental aitools tools query \
  "SELECT vendor_id, COUNT(*) as trip_count FROM samples.nyctaxi.trips GROUP BY vendor_id" \
  --profile my-workspace

# With JSON output
databricks experimental aitools tools query \
  "SELECT * FROM catalog.schema.table WHERE date > '2024-01-01'" \
  --output json \
  --profile my-workspace

# Using specific warehouse
DATABRICKS_WAREHOUSE_ID=abc123 databricks experimental aitools tools query \
  "SELECT * FROM samples.nyctaxi.trips LIMIT 10" \
  --profile my-workspace
```

### Common Use Cases

1. **Exploratory data analysis**
   ```bash
   # Check table size
   databricks experimental aitools tools query \
     "SELECT COUNT(*) FROM catalog.schema.table" \
     --profile my-workspace

   # View sample data
   databricks experimental aitools tools query \
     "SELECT * FROM catalog.schema.table LIMIT 10" \
     --profile my-workspace

   # Get column statistics
   databricks experimental aitools tools query \
     "SELECT MIN(column), MAX(column), AVG(column) FROM catalog.schema.table" \
     --profile my-workspace
   ```

2. **Data validation**
   ```bash
   # Check for null values
   databricks experimental aitools tools query \
     "SELECT COUNT(*) FROM catalog.schema.table WHERE column IS NULL" \
     --profile my-workspace

   # Verify data freshness
   databricks experimental aitools tools query \
     "SELECT MAX(timestamp_column) FROM catalog.schema.table" \
     --profile my-workspace
   ```

3. **Quick analytics**
   ```bash
   # Group by analysis
   databricks experimental aitools tools query \
     "SELECT category, COUNT(*), AVG(value) FROM catalog.schema.table GROUP BY category" \
     --profile my-workspace
   ```

## Workflow: Complete Data Exploration

Here's a typical workflow combining both commands:

```bash
# 1. Discover the schema first
databricks experimental aitools tools discover-schema \
  samples.nyctaxi.trips \
  --profile my-workspace

# 2. Based on discovered columns, run targeted queries
databricks experimental aitools tools query \
  "SELECT vendor_id, payment_type, COUNT(*) as trips, AVG(fare_amount) as avg_fare
   FROM samples.nyctaxi.trips
   GROUP BY vendor_id, payment_type
   ORDER BY trips DESC
   LIMIT 10" \
  --profile my-workspace

# 3. Investigate specific patterns found in the data
databricks experimental aitools tools query \
  "SELECT * FROM samples.nyctaxi.trips
   WHERE fare_amount > 100
   LIMIT 20" \
  --profile my-workspace
```

## Claude Code-Specific Tips

Remember that each Bash command in Claude Code runs in a separate shell:

```bash
# ✅ RECOMMENDED: Use --profile flag
databricks experimental aitools tools discover-schema samples.nyctaxi.trips --profile my-workspace

# ✅ ALTERNATIVE: Chain with &&
export DATABRICKS_CONFIG_PROFILE=my-workspace && \
  databricks experimental aitools tools query "SELECT * FROM samples.nyctaxi.trips LIMIT 5"

# ❌ DOES NOT WORK: Separate export
export DATABRICKS_CONFIG_PROFILE=my-workspace
databricks experimental aitools tools query "SELECT * FROM samples.nyctaxi.trips LIMIT 5"
```

## Flags

Both commands support:

| Flag | Description | Default |
|------|-------------|---------|
| `--profile` | Profile name from ~/.databrickscfg | Default profile |
| `--output` | Output format: `text` or `json` | `text` |
| `--debug` | Enable debug logging | `false` |
| `--target` | Bundle target to use (if applicable) | - |

## Troubleshooting

### Table Not Found

**Symptom**: `Error: TABLE_OR_VIEW_NOT_FOUND`

**Solution**:
1. Verify table name format: `CATALOG.SCHEMA.TABLE`
2. Check if you have read permissions on the table
3. List available tables:
   ```bash
   databricks tables list <catalog> <schema> --profile my-workspace
   ```

### Warehouse Not Available

**Symptom**: `Error: No available SQL warehouse found`

**Solution**:
1. Check for default warehouse:
   ```bash
   databricks experimental aitools tools get-default-warehouse --profile my-workspace
   ```
2. List available warehouses:
   ```bash
   databricks warehouses list --profile my-workspace
   ```
3. Set specific warehouse:
   ```bash
   DATABRICKS_WAREHOUSE_ID=<warehouse-id> databricks experimental aitools tools query "SELECT 1" --profile my-workspace
   ```
4. Start a stopped warehouse:
   ```bash
   databricks warehouses start --id <warehouse-id> --profile my-workspace
   ```

### Permission Denied

**Symptom**: `Error: PERMISSION_DENIED`

**Solution**:
1. Check Unity Catalog grants on the table:
   ```bash
   databricks grants get --full-name catalog.schema.table --principal <user-email> --profile my-workspace
   ```
2. Request SELECT permission from your workspace administrator
3. Verify you have warehouse access (USAGE permission)

### SQL Syntax Error

**Symptom**: `Error: PARSE_SYNTAX_ERROR`

**Solution**:
1. Check SQL syntax - use standard SQL
2. Verify column names match schema (use discover-schema first)
3. Ensure proper quoting for string literals
4. Test query incrementally (start simple, add complexity)

## Best Practices

1. **Always discover schema first** - Use `discover-schema` before writing complex queries to understand:
   - Available columns and their types
   - Data distributions and null patterns
   - Sample data for context

2. **Use LIMIT for exploration** - When exploring large tables, always use LIMIT to avoid long-running queries:
   ```bash
   databricks experimental aitools tools query "SELECT * FROM large_table LIMIT 100" --profile my-workspace
   ```

3. **JSON output for parsing** - Use `--output json` when you need to process results programmatically:
   ```bash
   databricks experimental aitools tools query "SELECT * FROM table" --output json --profile my-workspace | jq '.results'
   ```

4. **Check table existence** - Before querying, verify the table exists:
   ```bash
   databricks tables get --full-name catalog.schema.table --profile my-workspace
   ```

5. **Profile usage** - Always specify `--profile` in Claude Code to avoid authentication issues

## Related Commands

- **[Asset Bundles](asset-bundles.md)** - Deploy SQL, pipeline, and app resources as code
