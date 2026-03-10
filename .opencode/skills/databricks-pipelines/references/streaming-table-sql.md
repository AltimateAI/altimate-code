Streaming Tables in SQL Declarative Pipelines enable incremental processing of continuously arriving data.

**NOTE:** This guide focuses on streaming tables in SQL. For details on materialized views (batch processing), use the API guide for `materializedView` instead.

**API Reference:**

**CREATE STREAMING TABLE**
Creates a streaming table that processes data incrementally using `STREAM()` for streaming reads. For materialized views using batch reads (without `STREAM()`), see the `materializedView` API guide.

```sql
CREATE OR REFRESH [PRIVATE] STREAMING TABLE
  table_name
  [ table_specification ]
  [ table_clauses ]
  [ AS query ]

table_specification
  ( { column_identifier column_type [column_properties] } [, ...]
    [ column_constraint ] [, ...]
    [ , table_constraint ] [...] )

   column_properties
      { NOT NULL | COMMENT column_comment | column_constraint | MASK clause } [ ... ]

table_clauses
  { USING DELTA
    PARTITIONED BY (col [, ...]) |
    CLUSTER BY clause |
    LOCATION path |
    COMMENT view_comment |
    TBLPROPERTIES clause |
    WITH { ROW FILTER clause } } [ ... ]
```

**Parameters:**

- `PRIVATE`: Restricts table to pipeline scope; prevents metastore publication
- `table_name`: Unique identifier for the table (fully qualified name including catalog and schema must be unique unless marked PRIVATE)
- `table_specification`: Optional schema definition with column names, types, and properties
  - `column_identifier`: Name of the column
  - `column_type`: Data type (STRING, BIGINT, DECIMAL, etc.)
  - `column_properties`: Column attributes:
    - `NOT NULL`: Column cannot contain null values
    - `COMMENT column_comment`: Description for the column
    - `column_constraint`: Data quality constraints, consult the `expectations` API guide for details.
    - `MASK clause`: Column masking syntax `MASK catalog.schema.mask_fn USING COLUMNS (other_column)` (Public Preview)
  - `table_constraint`: Informational table-level constraints (Unity Catalog only, **not enforced** by Databricks):
    - Look up exact documentation when using
    - Note: Constraints are informational metadata for documentation and query optimization hints; data validation must be performed independently
- `table_clauses`: Optional clauses for table configuration:
  - `USING DELTA`: Optional format specification (only DELTA supported, can be omitted)
  - `PARTITIONED BY (col [, ...])`: Columns for traditional partitioning, mutually exclusive with CLUSTER BY
  - `CLUSTER BY clause`: Columns for liquid clustering (optimized query performance, recommended over partitioning)
  - `LOCATION path`: Storage path (defaults to pipeline storage location)
  - `COMMENT view_comment`: Description for the table
  - `TBLPROPERTIES clause`: Custom table properties `(key = value [, ...])`
  - `WITH ROW FILTER clause`: Row-level security filtering
    - Syntax: `ROW FILTER func_name ON (column_name [, ...])` (Public Preview)
      - `func_name` must be a SQL UDF returning BOOLEAN (can be defined in Unity Catalog)
      - Rows are filtered out when function returns FALSE or NULL
      - Accepts table columns or constant literals (STRING, numeric, BOOLEAN, INTERVAL, NULL)
      - Filter applies when rows are fetched from the data source
      - Runs with pipeline owner's rights during refresh and invoker's rights during queries
    - Note: Using row filters on source tables forces full refresh of downstream materialized views
    - Note: It is NOT possible to call `CREATE FUNCTION` within a Spark Declarative Pipeline.
- `query`: A Spark SQL query that defines the streaming dataset. Must use `STREAM()` function for streaming semantics.

**STREAM() Function:**
Provides streaming read semantics for the source table. Required for streaming queries.

```sql
SELECT * FROM STREAM(source_catalog.schema.source_table);
```

**CREATE FLOW with INSERT INTO**
Creates a flow that appends data from a source to an existing target streaming table. Multiple flows can write to the same target table.

```sql
CREATE FLOW flow_name [COMMENT comment] AS
INSERT INTO [ONCE] target_table BY NAME query
```

**Parameters:**

- `flow_name`: Unique identifier for the flow. Use distinct names when multiple flows target the same table.
- `ONCE`: Controls whether the flow runs continuously or once:
  - **Omitted (default)**: Flow continuously processes new data as it arrives in streaming mode. **Query must use `STREAM()` for streaming reads**.
  - **ONCE**: Flow processes data only once during pipeline execution and then stops. **Query uses non-streaming reads (without `STREAM()`)** for batch processing. Re-executes during pipeline complete refreshes to recreate data.
- `target_table_name`: The name of the target streaming table where data will be appended. Target must exist (created with `CREATE STREAMING TABLE`). **Required.**
- `SELECT ... FROM STREAM(source_table)`: The query to read source data
  - For continuous flows (no ONCE): Use `STREAM()` to return streaming data
  - For one-time flows (with ONCE): Omit `STREAM()` to return batch data

**Two Ways to Define Streaming Tables:**

1. **CREATE STREAMING TABLE with AS SELECT (MOST COMMON)**
   - Defines schema and query in one statement
   - Schema can be inferred from query or explicitly defined
   - **This automatically creates a continuous streaming pipeline - no separate flow needed**

   ```sql
   CREATE STREAMING TABLE events_stream
   AS SELECT * FROM STREAM(source_catalog.schema.events);
   ```

2. **CREATE STREAMING TABLE without AS SELECT**
   - Creates an empty streaming table target
   - Required for multi-source append patterns
   - Schema definition is optional
   - **Requires separate `CREATE FLOW` statements to populate the table**

   ```sql
   CREATE STREAMING TABLE users (
     user_id INT,
     name STRING,
     updated_at TIMESTAMP
   );
   ```

**CRITICAL: WHEN TO USE WHICH:**

Use **CREATE STREAMING TABLE with AS SELECT** when:

- Reading and transforming streaming data from a single source
- Creating streaming tables from Delta tables, Auto Loader sources, etc.
- This is the standard pattern for most streaming use cases
- **DO NOT add a separate `CREATE FLOW` - the AS SELECT clause already handles continuous processing**

Use **CREATE STREAMING TABLE without AS SELECT + CREATE FLOW** when:

- Creating a target table for multiple `INSERT INTO` flows from different sources
- Need to explicitly define table schema before data flows in
- Using `AUTO CDC INTO` for CDC. See 'autoCdc' API guide for details.
- **In this case, you MUST create separate flows - the table definition alone does not process data**

**NEVER:**

- Create both `CREATE STREAMING TABLE ... AS SELECT` AND `CREATE FLOW` for the same source - this is redundant and incorrect
- The AS SELECT clause already provides continuous streaming; adding a flow duplicates the work

**Common Patterns:**

**Pattern 1: Simple streaming transformation**

```sql
-- Bronze layer: ingest raw data with Auto Loader
CREATE STREAMING TABLE bronze
AS SELECT * FROM STREAM(read_files(
  '/path/to/data',
  format => 'json'
));

-- Silver layer: filter and clean data
CREATE STREAMING TABLE silver
AS SELECT *
FROM STREAM(bronze)
WHERE id IS NOT NULL;
```

**Pattern 2: Multi-source aggregation with flows**

```sql
-- Create target table for multiple sources. Schema is optional.
CREATE STREAMING TABLE all_events (
  event_id STRING,
  event_type STRING,
  event_timestamp TIMESTAMP,
  source STRING
);

-- Flow from mobile source
CREATE FLOW mobile_flow
AS INSERT INTO all_events BY NAME
SELECT event_id, event_type, event_timestamp, 'mobile' as source
FROM STREAM(mobile.events);

-- Flow from web source
CREATE FLOW web_flow
AS INSERT INTO all_events BY NAME
SELECT event_id, event_type, event_timestamp, 'web' as source
FROM STREAM(web.events);
```

**Pattern 3: Row filters for data security**

```sql
-- Assumes filter_by_dept is a SQL UDF defined in Unity Catalog that returns BOOLEAN

CREATE STREAMING TABLE employees (
  emp_id INT,
  emp_name STRING,
  dept STRING,
  salary DECIMAL(10,2)
)
WITH ROW FILTER my_catalog.my_schema.filter_by_dept ON (dept)
AS SELECT * FROM STREAM(source.employees);
```

**Pattern 4: Partitioning and clustering**

```sql
-- Using partitioning (traditional approach)
CREATE STREAMING TABLE orders_partitioned
PARTITIONED BY (order_date)
AS SELECT * FROM STREAM(source.orders);

-- Using liquid clustering (recommended)
CREATE STREAMING TABLE orders_clustered
CLUSTER BY (order_date, customer_id)
AS SELECT * FROM STREAM(source.orders);
```

**Pattern 5: Sensitive data masking**

```sql
CREATE STREAMING TABLE customers (
  customer_id INT,
  name STRING,
  email STRING,
  ssn STRING MASK catalog.schema.ssn_mask USING COLUMNS (customer_id)
)
AS SELECT * FROM STREAM(source.customers);
```

**Pattern 6: Private streaming table (pipeline-internal staging)**

```sql
CREATE OR REFRESH PRIVATE STREAMING TABLE staging_events
AS SELECT *
FROM STREAM(raw_events)
WHERE event_type IS NOT NULL;
```

Use `PRIVATE` for internal staging datasets that should not be published to the catalog. Private tables are only accessible within the pipeline.

**Pattern 7: One-time backfill with flow**

```sql
CREATE STREAMING TABLE transactions (
  transaction_id STRING,
  customer_id STRING,
  amount DECIMAL(10,2),
  transaction_date TIMESTAMP
);

-- Continuous streaming flow for new data
CREATE FLOW live_stream
AS INSERT INTO transactions
SELECT * FROM STREAM(source.transactions);

-- One-time backfill flow for historical data (uses batch read without STREAM)
CREATE FLOW historical_backfill
AS INSERT INTO ONCE transactions
SELECT * FROM archive.historical_transactions;
```

**Pattern 8: Stream-static join (enrich streaming data with dimension table)**

```sql
CREATE OR REFRESH STREAMING TABLE enriched_transactions
AS SELECT t.*, c.name, c.email
FROM STREAM(transactions) t
JOIN customers c ON t.customer_id = c.id;
```

The dimension table (`customers`) is read as a static snapshot at stream start, while the streaming source (`transactions`) is read incrementally. This is the standard pattern for enriching streaming data with lookup/dimension tables.

**Pattern 9: Reading from upstream ST with updates/deletes (skipChangeCommits)**

```sql
CREATE OR REFRESH STREAMING TABLE downstream
AS SELECT * FROM STREAM read_stream("upstream_with_deletes", skipChangeCommits => true)
```

Use `skipChangeCommits` when reading from a streaming table that has updates/deletes (e.g., GDPR compliance, Auto CDC targets). Without this flag, change commits cause errors.

**KEY RULES:**

- Streaming tables require `STREAM()` keyword for streaming reads
- Never use batch reads (`SELECT * FROM table` without `STREAM()`) in streaming table definitions
- `ALTER TABLE` commands are not supported - use `CREATE OR REFRESH` or `ALTER STREAMING TABLE` instead
- Generated columns, identity columns, and default columns are not currently supported
- Row filters force full refresh of downstream materialized views
- Only table owners can refresh streaming tables
- Table renaming and ownership changes prohibited
- `CLUSTER BY` is recommended over `PARTITIONED BY` for most use cases
- For batch processing, use materialized views instead (see the `materializedView` API guide)
- Use `skipChangeCommits` when reading from STs that have updates/deletes
