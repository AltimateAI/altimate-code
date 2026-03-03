---
name: sql-translate
description: >
  Translate SQL queries between database dialects.
  Use when the user asks to convert, translate, migrate, or port SQL from one warehouse
  to another, or mentions moving from Snowflake/BigQuery/Postgres/Oracle/Teradata/SQL Server
  to a different platform.
domain: sql-analysis
tools:
  - sql_translate
  - sql_validate
  - warehouse_list
  - dbt_profiles
  - read
  - write
  - glob
docs:
  - title: "Snowflake SQL Reference"
    url: "https://docs.snowflake.com/en/sql-reference"
    context: "Snowflake-specific SQL syntax for migration source/target validation"
  - title: "BigQuery Standard SQL Reference"
    url: "https://cloud.google.com/bigquery/docs/reference/standard-sql/query-syntax"
    context: "BigQuery-specific syntax differences for migration target validation"
---

# SQL Translate

## Requirements
**Agent:** builder or migrator (may write translated SQL to files)
**Tools used:** sql_translate, sql_validate, warehouse_list, dbt_profiles, read, write, glob

Translate SQL queries from one database dialect to another using the `sql_translate` tool, with awareness of common pitfalls across dialect boundaries.

## Workflow
1. **Detect source and target dialects** -- Use configured connections or dbt profile to auto-fill. If both are unknown, ask the user.
2. **Determine source and target dialects** -- If not fully specified:
   - Use context clues from the SQL syntax to infer the source dialect (e.g., `DATEADD` suggests Snowflake/SQL Server, `DATE_ADD` suggests BigQuery/MySQL, `||` for concat suggests Postgres/Snowflake)
   - Ask the user to confirm or specify any dialect that cannot be confidently inferred
3. **Get the SQL to translate** -- Either:
   - Read from a file path provided by the user (use `read`)
   - Accept inline SQL from the user's message
   - Search for SQL files with `glob` if the user references a model or directory
4. **Call `sql_translate`** with:
   - `sql`: The SQL query text
   - `source_dialect`: The source dialect
   - `target_dialect`: The target dialect
5. **Review the result**:
   - If `success` is true, present the translated SQL
   - If there are `warnings`, explain each one clearly -- these indicate constructs that may need manual review
   - If `success` is false, explain the error and suggest fixes (e.g., syntax the user may need to adjust before translation)
6. **Flag high-risk translation areas** that sqlglot may handle syntactically but require semantic verification:
   - **Date/time functions**: `DATEADD`/`DATE_ADD`/`INTERVAL`, timezone handling, epoch conversions
   - **Data types**: `VARCHAR` vs `STRING`, `TIMESTAMP_NTZ` vs `TIMESTAMP`, `NUMBER` vs `INT64`
   - **NULL handling**: `NVL`/`IFNULL`/`COALESCE` behave identically, but `IS NOT DISTINCT FROM` support varies
   - **Semi-structured data**: `VARIANT`/`PARSE_JSON` (Snowflake) vs `JSON` type and functions (BigQuery/Postgres)
   - **DDL differences**: Temp tables, `CREATE OR REPLACE`, materialized views, clustering/partitioning syntax
   - **Stored procedures / scripting**: JavaScript UDFs (Snowflake) vs SQL UDFs (BigQuery) vs PL/pgSQL (Postgres) -- these rarely translate automatically
7. **Format the output** clearly:
   - Show original SQL labeled with source dialect
   - Show translated SQL labeled with target dialect
   - List any warnings or areas requiring manual review
   - Note which constructs were translated automatically vs which need human attention
8. **Offer next steps**:
   - Suggest running `sql_validate` on the translated SQL to verify syntax in the target dialect
   - Offer to write the translated SQL to a file
   - Offer to translate additional queries or batch-translate a directory

## Supported Dialects

| Dialect | Key | Common Migration Paths |
|---------|-----|----------------------|
| Snowflake | `snowflake` | From: Oracle, SQL Server, Teradata, Redshift |
| BigQuery | `bigquery` | From: Teradata, Snowflake, Oracle, Hive |
| PostgreSQL | `postgres` | From: Oracle, MySQL, SQL Server |
| MySQL | `mysql` | From: Oracle, SQL Server |
| SQL Server | `tsql` | To: Snowflake, BigQuery, Postgres |
| Hive | `hive` | To: Spark, Databricks, BigQuery |
| Spark SQL | `spark` | From: Hive; To: Databricks |
| Databricks | `databricks` | From: Spark, Hive, Snowflake |
| Redshift | `redshift` | To: Snowflake, BigQuery |
| DuckDB | `duckdb` | For: local development, testing |
| SQLite | `sqlite` | For: prototyping, embedded |
| Oracle | `oracle` | To: Snowflake, BigQuery, Postgres |
| Trino/Presto | `trino` / `presto` | From: Hive; To: various |
| Teradata | `teradata` | To: Snowflake, BigQuery, Databricks |

## Usage

- `/sql-translate snowflake bigquery SELECT DATEADD(day, 7, CURRENT_TIMESTAMP())` -- Inline translation
- `/sql-translate oracle postgres` -- Specify dialects, then provide SQL interactively
- `/sql-translate models/staging/stg_orders.sql bigquery` -- Translate a file to BigQuery (auto-detect source)
- `/sql-translate` -- Interactive: detect or ask for dialects and SQL
