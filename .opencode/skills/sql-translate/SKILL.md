---
name: sql-translate
description: Translate SQL queries between database dialects (Snowflake, BigQuery, PostgreSQL, MySQL, etc.)
---

# SQL Translate

## Requirements
**Agent:** builder or migrator (may write translated SQL to files)
**Tools used:** sql_translate, read, write, altimate_core_validate

Translate SQL queries from one database dialect to another using sqlglot's transpilation engine.

## Workflow

1. **Determine source and target dialects** — If the user did not specify both dialects, ask which source and target dialects to use. Common dialects: `snowflake`, `bigquery`, `postgres`, `mysql`, `tsql`, `hive`, `spark`, `databricks`, `redshift`, `duckdb`.

2. **Get the SQL to translate** — Either:
   - Read from a file path provided by the user (use `read`)
   - Accept inline SQL from the user's message
   - Read from clipboard or stdin if mentioned

3. **Call `sql_translate`** with:
   - `sql`: The SQL query text
   - `source_dialect`: The source dialect
   - `target_dialect`: The target dialect

4. **Review the result**:
   - If `success` is true, present the translated SQL
   - If there are `warnings`, explain each one and what may need manual adjustment
   - If `success` is false, explain the error and suggest fixes

5. **Format the output** showing:
   - Original SQL (labeled with source dialect)
   - Translated SQL (labeled with target dialect)
   - Any warnings about lossy translations or features that need manual review

6. **Offer next steps** if applicable:
   - Suggest running `altimate_core_validate` on the translated SQL to verify syntax
   - Offer to write the translated SQL to a file
   - Offer to translate additional queries

## Usage

The user invokes this skill with optional dialect and SQL arguments:
- `/sql-translate` — Interactive: ask for source dialect, target dialect, and SQL
- `/sql-translate snowflake postgres` — Translate from Snowflake to PostgreSQL (will ask for SQL)
- `/sql-translate snowflake postgres SELECT DATEADD(day, 7, CURRENT_TIMESTAMP())` — Full inline translation

## Supported Dialects

| Dialect | Key |
|---------|-----|
| Snowflake | `snowflake` |
| BigQuery | `bigquery` |
| PostgreSQL | `postgres` |
| MySQL | `mysql` |
| SQL Server | `tsql` |
| Hive | `hive` |
| Spark SQL | `spark` |
| Databricks | `databricks` |
| Redshift | `redshift` |
| DuckDB | `duckdb` |
| SQLite | `sqlite` |
| Oracle | `oracle` |
| Trino/Presto | `trino` / `presto` |

Use the tools: `sql_translate`, `read`, `write`, `altimate_core_validate`.
