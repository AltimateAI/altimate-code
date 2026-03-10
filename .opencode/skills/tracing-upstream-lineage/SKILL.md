---
name: tracing-upstream-lineage
description: Trace upstream data lineage. Use when the user asks where data comes from, what feeds a table, upstream dependencies, data sources, or needs to understand data origins.
tags: ["airflow", "openlineage"]
---

# Upstream Lineage: Sources

Trace the origins of data - answer "Where does this data come from?"

## Lineage Investigation

### Step 1: Identify the Target Type

Determine what we're tracing:
- **Table**: Trace what populates this table
- **Column**: Trace where this specific column comes from
- **DAG**: Trace what data sources this DAG reads from

### Step 2: Find the Producing DAG

Tables are typically populated by Airflow DAGs. Find the connection:

1. **Search DAGs by name**: Use `af dags list` and look for DAG names matching the table name
   - `load_customers` -> `customers` table
   - `etl_daily_orders` -> `orders` table

2. **Explore DAG source code**: Use `af dags source <dag_id>` to read the DAG definition
   - Look for INSERT, MERGE, CREATE TABLE statements
   - Find the target table in the code

3. **Check DAG tasks**: Use `af tasks list <dag_id>` to see what operations the DAG performs

### On Astro

If you're running on Astro, the **Lineage tab** in the Astro UI provides visual lineage exploration across DAGs and datasets. Use it to quickly trace upstream dependencies without manually searching DAG source code.

### On OSS Airflow

Use DAG source code and task logs to trace lineage (no built-in cross-DAG UI).

### Step 3: Trace Data Sources

From the DAG code, identify source tables and systems:

**SQL Sources** (look for FROM clauses):
```python
# In DAG code:
SELECT * FROM source_schema.source_table  # <- This is an upstream source
```

**External Sources** (look for connection references):
- `S3Operator` -> S3 bucket source
- `PostgresOperator` -> Postgres database source
- `SalesforceOperator` -> Salesforce API source
- `HttpOperator` -> REST API source

**File Sources**:
- CSV/Parquet files in object storage
- SFTP drops
- Local file paths

### Step 4: Build the Lineage Chain

Recursively trace each source:

```
TARGET: analytics.orders_daily
    ^
    +-- DAG: etl_daily_orders
            ^
            +-- SOURCE: raw.orders (table)
            |       ^
            |       +-- DAG: ingest_orders
            |               ^
            |               +-- SOURCE: Salesforce API (external)
            |
            +-- SOURCE: dim.customers (table)
                    ^
                    +-- DAG: load_customers
                            ^
                            +-- SOURCE: PostgreSQL (external DB)
```

### Step 5: Check Source Health

For each upstream source:
- **Tables**: Check freshness with the **checking-freshness** skill
- **DAGs**: Check recent run status with `af dags stats`
- **External systems**: Note connection info from DAG code

## Lineage for Columns

When tracing a specific column:

1. Find the column in the target table schema
2. Search DAG source code for references to that column name
3. Trace through transformations:
   - Direct mappings: `source.col AS target_col`
   - Transformations: `COALESCE(a.col, b.col) AS target_col`
   - Aggregations: `SUM(detail.amount) AS total_amount`

## Output: Lineage Report

### Summary
One-line answer: "This table is populated by DAG X from sources Y and Z"

### Lineage Diagram
```
[Salesforce] --> [raw.opportunities] --> [stg.opportunities] --> [fct.sales]
                        |                        |
                   DAG: ingest_sfdc         DAG: transform_sales
```

### Source Details

| Source | Type | Connection | Freshness | Owner |
|--------|------|------------|-----------|-------|
| raw.orders | Table | Internal | 2h ago | data-team |
| Salesforce | API | salesforce_conn | Real-time | sales-ops |

### Transformation Chain
Describe how data flows and transforms:
1. Raw data lands in `raw.orders` via Salesforce API sync
2. DAG `transform_orders` cleans and dedupes into `stg.orders`
3. DAG `build_order_facts` joins with dimensions into `fct.orders`

### Data Quality Implications
- Single points of failure?
- Stale upstream sources?
- Complex transformation chains that could break?

### Related Skills
- Check source freshness: **checking-freshness** skill
- Debug source DAG: **debugging-dags** skill
- Trace downstream impacts: **tracing-downstream-lineage** skill
- Add manual lineage annotations: **annotating-task-lineage** skill
- Build custom lineage extractors: **creating-openlineage-extractors** skill
