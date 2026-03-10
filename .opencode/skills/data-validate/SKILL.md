---
name: data-validate
description: Compare data between two tables across any warehouses using progressive validation — row counts, column profiles, segment checksums, and row-level drill-down.
---

# Data Validate

## Requirements
**Agent:** data-diff or migrator (requires sql_execute on both source and target)
**Tools used:** sql_execute, warehouse_list, warehouse_test, schema_inspect, read, glob

Cross-database data validation using a progressive, multi-level approach. Each level provides increasing confidence with increasing query cost — stop as soon as you have enough evidence.

## Validation Levels

### Level 1: Row Count (seconds, near-zero cost)
Compare total row counts between source and target. If counts match exactly, proceed to Level 2. If they differ, report the delta immediately — no deeper checks needed.

```sql
-- Run on source warehouse
SELECT COUNT(*) AS row_count FROM {source_table} [WHERE ...]

-- Run on target warehouse
SELECT COUNT(*) AS row_count FROM {target_table} [WHERE ...]
```

### Level 2: Column Profile (seconds, low cost)
For each column, compare aggregate statistics. This catches type coercion bugs, NULL handling differences, and truncation issues without scanning every row.

```sql
SELECT
  COUNT(*)                    AS total_rows,
  COUNT({col})                AS non_null_count,
  COUNT(DISTINCT {col})       AS distinct_count,
  MIN({col})                  AS min_val,
  MAX({col})                  AS max_val,
  -- Numeric columns only:
  AVG(CAST({col} AS DOUBLE))  AS avg_val,
  SUM(CAST({col} AS DOUBLE))  AS sum_val
FROM {table} [WHERE ...]
```

Run this for each column (or the key columns + any columns the user cares about). Compare results side by side:

```
Column Profile Comparison
=========================
Column          | Source          | Target          | Match
----------------|-----------------|-----------------|------
total_rows      | 1,234,567       | 1,234,567       | OK
user_id.distinct| 500,000         | 500,000         | OK
email.nulls     | 0               | 1,204           | MISMATCH
amount.sum      | 45,678,901.23   | 45,678,901.23   | OK
amount.avg      | 37.01           | 37.01           | OK
created_at.min  | 2020-01-01      | 2020-01-01      | OK
created_at.max  | 2024-12-31      | 2024-12-31      | OK
```

If all profiles match, tables are equivalent with high confidence. Report and stop.

### Level 3: Segment Checksums (moderate cost)
If profiles match but the user wants stronger guarantees, or if you need to locate WHERE the differences are, split the key space into segments and compare checksums.

Requires: a sortable key column (integer PK, timestamp, etc.)

```sql
-- Get key range
SELECT MIN({key_col}) AS min_key, MAX({key_col}) AS max_key FROM {table}

-- Segment checksum (dialect-specific hash aggregation)
-- Snowflake:
SELECT
  FLOOR(({key_col} - {min_key}) * {num_buckets} / ({max_key} - {min_key} + 1)) AS bucket,
  COUNT(*) AS cnt,
  BITXOR_AGG(HASH({columns})) AS checksum
FROM {table}
WHERE {key_col} >= {min_key} AND {key_col} <= {max_key}
GROUP BY bucket ORDER BY bucket

-- Postgres:
SELECT
  FLOOR(({key_col} - {min_key}) * {num_buckets} / ({max_key} - {min_key} + 1)) AS bucket,
  COUNT(*) AS cnt,
  BIT_XOR(('x' || SUBSTR(MD5(CONCAT({columns}::text)), 1, 12))::bit(48)::bigint) AS checksum
FROM {table}
WHERE {key_col} >= {min_key} AND {key_col} <= {max_key}
GROUP BY bucket ORDER BY bucket

-- BigQuery:
SELECT
  CAST(FLOOR(({key_col} - {min_key}) * {num_buckets} / ({max_key} - {min_key} + 1)) AS INT64) AS bucket,
  COUNT(*) AS cnt,
  BIT_XOR(FARM_FINGERPRINT(CONCAT({columns}))) AS checksum
FROM {table}
WHERE {key_col} >= {min_key} AND {key_col} <= {max_key}
GROUP BY bucket ORDER BY bucket

-- DuckDB:
SELECT
  FLOOR(({key_col} - {min_key}) * {num_buckets} / ({max_key} - {min_key} + 1)) AS bucket,
  COUNT(*) AS cnt,
  BIT_XOR(md5_number_lower64(CONCAT({columns}::text))) AS checksum
FROM {table}
WHERE {key_col} >= {min_key} AND {key_col} <= {max_key}
GROUP BY bucket ORDER BY bucket
```

Compare bucket-by-bucket. Matching checksums = identical data in that segment. Mismatched buckets narrow down where differences live.

### Level 4: Row-Level Diff (targeted, on mismatched segments only)
For any mismatched segments from Level 3, download the actual rows and diff them locally. Only fetch rows in the mismatched key range.

```sql
SELECT {key_col}, {columns}
FROM {table}
WHERE {key_col} >= {segment_min} AND {key_col} < {segment_max}
ORDER BY {key_col}
```

Compare row by row. Report additions, deletions, and value changes.

## Workflow

1. **Identify source and target** — Ask the user or infer from context:
   - Which warehouse connections? (use `warehouse_list` to show available)
   - Which tables to compare?
   - Any WHERE clause filters? (date range, partition, etc.)
   - Which columns matter? (all, or specific subset)

2. **Verify connectivity** — Run `warehouse_test` on both connections.

3. **Inspect schemas** — Use `schema_inspect` on both tables. Compare column names, types, and nullability. Flag any schema differences before proceeding (e.g., VARCHAR(100) vs VARCHAR(256), INT vs BIGINT).

4. **Run Level 1** — Row counts. If mismatched, report and ask if user wants to drill deeper.

5. **Run Level 2** — Column profiles. Compare side by side. If all match, report high-confidence equivalence. If mismatches found, highlight which columns differ and by how much.

6. **Run Level 3** (if needed) — Segment checksums. Use 32 buckets by default. Report which segments match and which differ.

7. **Run Level 4** (if needed) — Fetch rows from mismatched segments. Show the actual diff rows (additions/deletions/changes).

8. **Report** — Always produce a structured summary:

```
Data Validation Report
======================
Source: snowflake://analytics.public.orders
Target: bigquery://project.dataset.orders
Filter: created_at >= '2024-01-01'
Status: PASS | FAIL | PARTIAL

Level 1 — Row Count:    PASS (1,234,567 rows both sides)
Level 2 — Profile:      PASS (all 12 columns match)
Level 3 — Checksum:     PASS (32/32 segments match)
Level 4 — Row Diff:     SKIPPED (not needed)

Confidence: HIGH
```

## Dialect-Specific Notes

**Hash functions by dialect:**
| Dialect     | Row Hash              | Aggregation     |
|-------------|-----------------------|-----------------|
| Snowflake   | `HASH(cols)`          | `BITXOR_AGG`    |
| Postgres    | `MD5(CONCAT(cols))`   | `BIT_XOR`       |
| BigQuery    | `FARM_FINGERPRINT`    | `BIT_XOR`       |
| DuckDB      | `md5_number_lower64`  | `BIT_XOR`       |
| Databricks  | `xxhash64(cols)`      | `BIT_XOR`       |
| MySQL       | `MD5(CONCAT(cols))`   | `BIT_XOR`       |
| ClickHouse  | `cityHash64(cols)`    | `groupBitXor`   |

**Cross-database checksum comparison**: When source and target use different dialects, checksums won't match even for identical data (different hash functions). In this case, skip Level 3 and go directly from Level 2 to Level 4 if needed, OR download sorted rows from both sides and compare locally.

## Usage

- `/data-validate` — Start interactive validation (will ask for source/target)
- `/data-validate orders` — Validate the `orders` table across connected warehouses
- `/data-validate snowflake.orders bigquery.orders` — Explicit source and target
- `/data-validate --level 2` — Stop at profile level (skip checksums)
- `/data-validate --columns id,amount,created_at` — Only validate specific columns

Use the tools: `sql_execute`, `warehouse_list`, `warehouse_test`, `schema_inspect`, `read`, `glob`.
