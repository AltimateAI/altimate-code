# Warehouse Discovery

Patterns for discovering and querying data in the warehouse.

> **Note:** Examples use Snowflake syntax. Key differences for other databases:
> - `ILIKE` → BigQuery: `LOWER(col) LIKE LOWER('%term%')`
> - `DATEADD(day, -30, x)` → PostgreSQL: `x - INTERVAL '30 days'`
> - `INFORMATION_SCHEMA` structure varies by database

## Value Discovery (Explore Before Filtering)

⚠️ **CRITICAL: When filtering on categorical columns (operators, features, types, statuses), ALWAYS explore what values exist BEFORE writing your main query.**

When the user asks about a specific item, it may be part of a family of related items. Run a discovery query first:

```sql
SELECT DISTINCT column_name, COUNT(*) as occurrences
FROM table
WHERE column_name ILIKE '%search_term%'
GROUP BY column_name
ORDER BY occurrences DESC
```

**This pattern applies to:**
- **Operators/Features**: Often have variants (Entry, Branch, Sensor, Pro, Lite)
- **Statuses**: May have related states (pending, pending_approval, pending_review)
- **Types**: Often have subtypes (user, user_admin, user_readonly)
- **Products**: May have tiers or editions

## Fast Table Validation

Start with the **simplest possible query**, then add complexity only after each step succeeds:

```
Step 1: Does the data exist?     → Simple LIMIT query, no JOINs
Step 2: How much data?           → COUNT(*) with same filters
Step 3: What are the key IDs?    → SELECT DISTINCT foreign_keys LIMIT 100
Step 4: Get related details      → JOIN on the specific IDs from step 3
```

**Never jump from step 1 to complex aggregations.** If step 1 returns 50 rows, use those IDs directly.

### Use Row Counts as a Signal

- **Millions+ rows** → likely execution/fact data (actual events, transactions, runs)
- **Thousands of rows** → likely metadata/config (what's configured, not what happened)

## Handling Large Tables (100M+ rows)

**CRITICAL: Tables with 1B+ rows require special handling**

1. Use simple queries only: `SELECT col1, col2 FROM table WHERE filter LIMIT 100`
2. NO JOINs, NO GROUP BY, NO aggregations on the first query
3. Only add complexity after the simple query succeeds

**If your query times out**, simplify it - don't give up. Remove JOINs, remove GROUP BY, add LIMIT.

### Pattern: Find examples first, aggregate later

```sql
-- Step 1: Find examples (fast - stops after finding matches)
SELECT col_a, col_b, foreign_key_id
FROM huge_table
WHERE col_a ILIKE '%term%'
  AND ts >= DATEADD(day, -30, CURRENT_DATE)
LIMIT 100

-- Step 2: Use foreign keys from step 1 to get details
SELECT o.name, o.details
FROM other_table o
WHERE o.id IN ('id1', 'id2', 'id3')  -- IDs from step 1
```

**CRITICAL: LIMIT only helps without GROUP BY**

```sql
-- STILL SLOW: LIMIT with GROUP BY - must scan ALL rows first
SELECT col, COUNT(*) FROM huge_table WHERE x ILIKE '%term%' GROUP BY col LIMIT 100

-- FAST: LIMIT without GROUP BY - stops after finding 100 rows
SELECT col, id FROM huge_table WHERE x ILIKE '%term%' LIMIT 100
```

## Table Exploration Process

### Step 1: Search for Relevant Tables

```sql
SELECT
    TABLE_CATALOG as database,
    TABLE_SCHEMA as schema,
    TABLE_NAME as table_name,
    ROW_COUNT,
    COMMENT as description
FROM <database>.INFORMATION_SCHEMA.TABLES
WHERE LOWER(TABLE_NAME) LIKE '%<concept>%'
   OR LOWER(COMMENT) LIKE '%<concept>%'
ORDER BY TABLE_SCHEMA, TABLE_NAME
LIMIT 30
```

### Step 2: Categorize by Data Layer

| Layer | Naming Patterns | Purpose |
|-------|-----------------|---------|
| **Raw/Staging** | `raw_`, `stg_`, `staging_` | Source data, minimal transformation |
| **Intermediate** | `int_`, `base_`, `prep_` | Cleaned, joined, business logic applied |
| **Marts/Facts** | `fct_`, `fact_`, `mart_` | Business metrics, analysis-ready |
| **Dimensions** | `dim_`, `dimension_` | Reference/lookup tables |
| **Aggregates** | `agg_`, `summary_`, `daily_` | Pre-computed rollups |

### Step 3: Get Schema Details

For the most relevant tables (typically 2-5), query column metadata:

```sql
SELECT COLUMN_NAME, DATA_TYPE, COMMENT
FROM <database>.INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = '<schema>' AND TABLE_NAME = '<table>'
ORDER BY ORDINAL_POSITION
```

### Step 4: Check Data Freshness

```sql
SELECT
    MAX(<timestamp_column>) as last_update,
    COUNT(*) as row_count
FROM <table>
```
