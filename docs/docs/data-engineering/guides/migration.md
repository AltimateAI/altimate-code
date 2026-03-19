# Migration Guide

Use altimate to translate SQL across warehouse dialects while preserving lineage and correctness.

## Start a migration

```bash
altimate --agent builder
```

## Translation workflow

### 1. Identify source dialect and target

```
You: Migrate our Snowflake models to BigQuery

Builder: I'll translate each model and verify lineage is preserved.
         Let me start by listing your models.

> dbt_manifest ./target/manifest.json
  47 models found
```

### 2. Translate with verification

For each model, the agent:

1. **Reads** the source SQL
2. **Translates** to target dialect
3. **Checks lineage** on both versions to ensure they match
4. **Validates** the translated SQL against target schema

```
> sql_translate --source snowflake --target bigquery [model SQL]

Snowflake → BigQuery translations applied:
  DATEADD(day, -7, x)  →  DATE_SUB(x, INTERVAL 7 DAY)
  IFF(cond, a, b)      →  IF(cond, a, b)
  TRY_TO_NUMBER(x)     →  SAFE_CAST(x AS NUMERIC)
  FLATTEN(array_col)   →  UNNEST(array_col)
  table_name            →  `table_name` (backtick quoting)
  QUALIFY clause        →  QUALIFY clause (supported in BQ)

> lineage_check [source SQL]
> lineage_check [translated SQL]
  ✓ Lineage preserved — 4 source columns → 4 target columns
```

### 3. Handle dialect-specific features

Some features don't have direct equivalents:

| Snowflake | BigQuery | Notes |
|---|---|---|
| `VARIANT` type | `JSON` or `STRUCT` | Manual mapping may be needed |
| `LATERAL FLATTEN` | `UNNEST` | Different syntax, same result |
| `$1, $2` (positional) | Named columns | Requires column naming |
| `MERGE` | `MERGE` | Syntax differences in WHEN clauses |
| `COPY INTO` | `LOAD DATA` | Different bulk load approach |
| `STREAMS` | Change Data Capture | Architectural difference |
| `TASKS` | Scheduled queries | Different scheduling model |

### 4. Validate at scale

```
You: Run all translations and report issues

Builder:
  ✓ 38/47 models translated cleanly
  ⚠ 6 models need manual review (VARIANT columns)
  ✗ 3 models use Snowflake-specific features (STREAMS, TASKS)

Manual review needed:
  models/staging/stg_events.sql — VARIANT column parsing
  models/staging/stg_api_logs.sql — PARSE_JSON usage
  ...
```

## Common translation patterns

### Snowflake → BigQuery

```sql
-- Snowflake
SELECT
    DATEADD(month, -3, CURRENT_TIMESTAMP()) AS three_months_ago,
    IFF(amount > 100, 'high', 'low') AS tier,
    LISTAGG(tag, ', ') WITHIN GROUP (ORDER BY tag) AS tags,
    TRY_TO_DECIMAL(raw_price, 10, 2) AS price,
    OBJECT_CONSTRUCT('key', value) AS json_obj
FROM my_schema.my_table
QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY ts DESC) = 1;

-- BigQuery (translated)
SELECT
    DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 3 MONTH) AS three_months_ago,
    IF(amount > 100, 'high', 'low') AS tier,
    STRING_AGG(tag, ', ' ORDER BY tag) AS tags,
    SAFE_CAST(raw_price AS DECIMAL) AS price,
    STRUCT(value AS key) AS json_obj
FROM `my_schema.my_table`
QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY ts DESC) = 1;
```

### Snowflake → Databricks

```sql
-- Snowflake
SELECT
    DATEADD(day, -7, CURRENT_TIMESTAMP()),
    DATEDIFF(hour, start_ts, end_ts),
    TRY_CAST(x AS INTEGER),
    ARRAY_AGG(DISTINCT val) WITHIN GROUP (ORDER BY val)
FROM table
WHERE RLIKE(email, '^[a-z]+@.*$');

-- Databricks (translated)
SELECT
    DATEADD(DAY, -7, CURRENT_TIMESTAMP()),
    DATEDIFF(HOUR, start_ts, end_ts),
    TRY_CAST(x AS INT),
    ARRAY_AGG(DISTINCT val)
FROM table
WHERE RLIKE(email, '^[a-z]+@.*$');
```

## Best practices

1. **Translate in batches.** Start with staging models, then intermediate, then marts.
2. **Verify lineage.** Always check that column lineage is preserved after translation.
3. **Test with LIMIT.** Run translated queries with `LIMIT 10` on the target warehouse first.
4. **Check data types.** Type mappings may lose precision (e.g., `NUMBER(38,0)` to `INT64`).
5. **Handle NULL semantics.** Some warehouses handle NULLs differently in comparisons.
