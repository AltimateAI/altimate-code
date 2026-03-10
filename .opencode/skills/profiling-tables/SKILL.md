---
name: profiling-tables
description: Deep-dive data profiling for a specific table. Use when the user asks to profile a table, wants statistics about a dataset, asks about data quality, or needs to understand a table's structure and content. Requires a table name.
tags: ["airflow", "data-engineering"]
---

# Data Profile

Generate a comprehensive profile of a table that a new team member could use to understand the data.

## Step 1: Basic Metadata

Query column metadata:

```sql
SELECT COLUMN_NAME, DATA_TYPE, COMMENT
FROM <database>.INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = '<schema>' AND TABLE_NAME = '<table>'
ORDER BY ORDINAL_POSITION
```

If the table name isn't fully qualified, search INFORMATION_SCHEMA.TABLES to locate it first.

## Step 2: Size and Shape

Run via `run_sql`:

```sql
SELECT
    COUNT(*) as total_rows,
    COUNT(*) / 1000000.0 as millions_of_rows
FROM <table>
```

## Step 3: Column-Level Statistics

For each column, gather appropriate statistics based on data type:

### Numeric Columns
```sql
SELECT
    MIN(column_name) as min_val,
    MAX(column_name) as max_val,
    AVG(column_name) as avg_val,
    STDDEV(column_name) as std_dev,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY column_name) as median,
    SUM(CASE WHEN column_name IS NULL THEN 1 ELSE 0 END) as null_count,
    COUNT(DISTINCT column_name) as distinct_count
FROM <table>
```

### String Columns
```sql
SELECT
    MIN(LEN(column_name)) as min_length,
    MAX(LEN(column_name)) as max_length,
    AVG(LEN(column_name)) as avg_length,
    SUM(CASE WHEN column_name IS NULL OR column_name = '' THEN 1 ELSE 0 END) as empty_count,
    COUNT(DISTINCT column_name) as distinct_count
FROM <table>
```

### Date/Timestamp Columns
```sql
SELECT
    MIN(column_name) as earliest,
    MAX(column_name) as latest,
    DATEDIFF('day', MIN(column_name), MAX(column_name)) as date_range_days,
    SUM(CASE WHEN column_name IS NULL THEN 1 ELSE 0 END) as null_count
FROM <table>
```

## Step 4: Cardinality Analysis

For columns that look like categorical/dimension keys:

```sql
SELECT
    column_name,
    COUNT(*) as frequency,
    ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 2) as percentage
FROM <table>
GROUP BY column_name
ORDER BY frequency DESC
LIMIT 20
```

This reveals:
- High-cardinality columns (likely IDs or unique values)
- Low-cardinality columns (likely categories or status fields)
- Skewed distributions (one value dominates)

## Step 5: Sample Data

Get representative rows:

```sql
SELECT *
FROM <table>
LIMIT 10
```

If the table is large and you want variety, sample from different time periods or categories.

## Step 6: Data Quality Assessment

Summarize quality across dimensions:

### Completeness
- Which columns have NULLs? What percentage?
- Are NULLs expected or problematic?

### Uniqueness
- Does the apparent primary key have duplicates?
- Are there unexpected duplicate rows?

### Freshness
- When was data last updated? (MAX of timestamp columns)
- Is the update frequency as expected?

### Validity
- Are there values outside expected ranges?
- Are there invalid formats (dates, emails, etc.)?
- Are there orphaned foreign keys?

### Consistency
- Do related columns make sense together?
- Are there logical contradictions?

## Step 7: Output Summary

Provide a structured profile:

### Overview
2-3 sentences describing what this table contains, who uses it, and how fresh it is.

### Schema
| Column | Type | Nulls% | Distinct | Description |
|--------|------|--------|----------|-------------|
| ... | ... | ... | ... | ... |

### Key Statistics
- Row count: X
- Date range: Y to Z
- Last updated: timestamp

### Data Quality Score
- Completeness: X/10
- Uniqueness: X/10
- Freshness: X/10
- Overall: X/10

### Potential Issues
List any data quality concerns discovered.

### Recommended Queries
3-5 useful queries for common questions about this data.
