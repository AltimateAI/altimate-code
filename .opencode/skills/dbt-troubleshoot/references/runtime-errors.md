# Runtime / Database Errors

Runtime errors happen when compiled SQL fails to execute against the database.

## Diagnosis

```bash
# First compile to rule out Jinja issues
altimate-dbt compile --model <name>

# Then try to build
altimate-dbt build --model <name>

# Probe the data directly
altimate-dbt execute --query "<diagnostic_sql>" --limit 10
```

## Common Runtime Errors

### `Database Error: column "x" does not exist`

**Cause**: Model references a column that doesn't exist in the source/upstream model.

**Fix**:
```bash
altimate-dbt columns --model <upstream_model>    # check what columns actually exist
```
Update the column name in the SQL.

### `Database Error: relation "schema.table" does not exist`

**Cause**: The upstream model hasn't been built yet, or the schema doesn't exist.

**Fix**:
```bash
altimate-dbt build --model <upstream_model>      # build the dependency first
```

### `Database Error: division by zero`

**Cause**: Dividing by a column that contains zeros.

**Fix**: Add a `NULLIF(denominator, 0)` or `CASE WHEN denominator = 0 THEN NULL ELSE ...` guard.

### `Database Error: ambiguous column reference`

**Cause**: Column name exists in multiple tables in a JOIN.

**Fix**: Qualify with table alias: `orders.customer_id` instead of `customer_id`.

### `Database Error: type mismatch`

**Cause**: Comparing or operating on incompatible types (string vs integer, date vs timestamp).

**Fix**: Add explicit `CAST()` to align types.

### `Timeout` or `Memory Exceeded`

**Cause**: Query is too expensive — full table scan, massive JOIN, or no partition pruning.

**Fix**:
1. Check if model should be incremental
2. Add `WHERE` filters to limit data
3. Check JOIN keys — are they indexed/clustered?

## General Approach

1. Read the compiled SQL: `altimate-dbt compile --model <name>`
2. Try running a simplified version of the query directly
3. Check upstream columns: `altimate-dbt columns --model <upstream>`
4. Add diagnostic queries to understand the data shape
