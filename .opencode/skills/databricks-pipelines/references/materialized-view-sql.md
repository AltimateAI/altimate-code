Materialized Views in Lakeflow Spark Declarative Pipelines enable batch processing of data with full refresh or incremental computation.

**NOTE:** This guide focuses on materialized views. For details on streaming tables (incremental processing with streaming reads), use the API guide for `streamingTable` instead.

**SQL Syntax:**

**CREATE MATERIALIZED VIEW**
Creates a materialized view for batch data processing. For streaming tables, see the `CREATE STREAMING TABLE` guide.

```sql
CREATE OR REFRESH [PRIVATE] MATERIALIZED VIEW
  view_name
  [ column_list ]
  [ view_clauses ]
  AS query

column_list
   ( { column_name column_type column_properties } [, ...]
    [ column_constraint ] [, ...]
    [ , table_constraint ] [...] )

   column_properties
      { NOT NULL | COMMENT column_comment | column_constraint | MASK clause } [ ... ]

view_clauses
  { USING DELTA |
    PARTITIONED BY (col [, ...]) |
    CLUSTER BY clause |
    LOCATION path |
    COMMENT view_comment |
    TBLPROPERTIES clause |
    WITH { ROW FILTER clause } } [...]
```

**Parameters:**

- `PRIVATE`: Restricts table to pipeline scope; prevents metastore publication
- `view_name`: Unique identifier for the view (fully qualified name including catalog and schema must be unique unless marked PRIVATE)
- `column_list`: Optional schema definition with column names, types, and properties
  - `column_name`: Name of the column
  - `column_type`: Data type (STRING, BIGINT, DECIMAL, etc.)
  - `column_properties`: Column attributes:
    - `NOT NULL`: Column cannot contain null values
    - `COMMENT column_comment`: Description for the column
    - `column_constraint`: Data quality constraints, consult the `expectations` API guide for details.
    - `MASK clause`: Column masking syntax `MASK catalog.schema.mask_fn USING COLUMNS (other_column)` (Public Preview)
  - `table_constraint`: Informational table-level constraints (Unity Catalog only, **not enforced** by Databricks):
    - Look up exact documentation when using
    - Note: Constraints are informational metadata for documentation and query optimization hints; data validation must be performed independently
- `view_clauses`: Optional clauses for view configuration:
  - `USING DELTA`: Optional format specification (only DELTA supported, can be omitted)
  - `PARTITIONED BY (col [, ...])`: Columns for traditional partitioning, mutually exclusive with CLUSTER BY
  - `CLUSTER BY clause`: Columns for liquid clustering (optimized query performance)
  - `LOCATION path`: Storage path (Hive metastore only)
  - `COMMENT view_comment`: Description for the view
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
- `query`: A Spark SQL query that defines the dataset for the table

**Incremental Refresh for Materialized Views:**

Materialized views on **serverless pipelines** support automatic incremental refresh, which processes only changes in underlying data since the last refresh rather than recomputing everything. This significantly reduces compute costs.

**How it works:**

- Lakeflow Spark Declarative Pipelines uses a cost model to determine whether to perform incremental refresh or full recompute
- Incremental refresh processes delta changes and appends to the table
- If incremental refresh is not feasible or more expensive, the system falls back to full recompute automatically

**Requirements for incremental refresh:**

- Must run on **serverless pipelines** (not classic compute)
- Source tables must be Delta tables, materialized views, or streaming tables
- Row-tracking must be enabled on source tables for certain operations (see Notes column)

**Supported SQL operations for incremental refresh:**

| SQL Operation               | Support | Notes                                                                                                   |
| --------------------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| SELECT expressions          | Yes     | Deterministic built-in functions and immutable UDFs. Requires row tracking                              |
| GROUP BY                    | Yes     | —                                                                                                       |
| WITH                        | Yes     | Common table expressions                                                                                |
| UNION ALL                   | Yes     | Requires row tracking                                                                                   |
| FROM                        | Yes     | Supported base tables include Delta tables, materialized views, and streaming tables                    |
| WHERE, HAVING               | Yes     | Requires row tracking                                                                                   |
| INNER JOIN                  | Yes     | Requires row tracking                                                                                   |
| LEFT OUTER JOIN             | Yes     | Requires row tracking                                                                                   |
| FULL OUTER JOIN             | Yes     | Requires row tracking                                                                                   |
| RIGHT OUTER JOIN            | Yes     | Requires row tracking                                                                                   |
| OVER (Window functions)     | Yes     | Must specify PARTITION BY columns                                                                       |
| QUALIFY                     | Yes     | —                                                                                                       |
| EXPECTATIONS                | Partial | Generally supported; exceptions for views with expectations and DROP expectations with NOT NULL columns |
| Non-deterministic functions | Limited | Time functions like `current_date()` supported in WHERE clauses only                                    |
| Non-Delta sources           | No      | Volumes, external locations, foreign catalogs unsupported                                               |

**Best practices:**

- Enable deletion vectors, row tracking, and change data feed on source tables for optimal incremental refresh
- Design queries with supported operations to leverage incremental refresh
- For exactly-once processing semantics (Kafka, Auto Loader), use streaming tables instead

**Common Patterns:**

**Pattern 1: Simple batch transformation**

```sql
CREATE MATERIALIZED VIEW bronze_batch
AS SELECT * FROM delta.`/path/to/data`;

CREATE MATERIALIZED VIEW silver_batch
AS SELECT * FROM bronze_batch WHERE id IS NOT NULL;
```

**Pattern 2: Schema with generated columns**

```sql
CREATE MATERIALIZED VIEW orders_with_day (
  order_datetime STRING,
  order_day_of_week STRING GENERATED ALWAYS AS (dayofweek(order_datetime)),
  customer_id BIGINT,
  amount DECIMAL(10,2)
)
CLUSTER BY (order_day_of_week, customer_id)
AS SELECT order_datetime, customer_id, amount FROM raw.orders;
```

**Pattern 3: Row filters for data security**

```sql
-- Assumes filter_by_dept is a SQL UDF defined in Unity Catalog that returns BOOLEAN

CREATE MATERIALIZED VIEW employees (
  emp_id INT,
  emp_name STRING,
  dept STRING,
  salary DECIMAL(10,2)
)
WITH ROW FILTER my_catalog.my_schema.filter_by_dept ON (dept)
AS SELECT * FROM source.employees;
```

**Pattern 4: Column masking for sensitive data**

```sql
CREATE MATERIALIZED VIEW users_with_masked_ssn (
  user_id BIGINT,
  ssn STRING MASK catalog.schema.ssn_mask_fn USING COLUMNS (region),
  region STRING
)
AS SELECT user_id, ssn, region FROM raw.users;
```

**Pattern 5: Aggregations with liquid clustering**

```sql
CREATE MATERIALIZED VIEW daily_sales_summary
CLUSTER BY (sale_date, region)
AS
SELECT
  DATE(order_timestamp) AS sale_date,
  region,
  COUNT(*) AS order_count,
  SUM(amount) AS total_revenue
FROM raw.orders
GROUP BY DATE(order_timestamp), region;
```

**KEY RULES:**

- Materialized views perform batch processing of data
- Streaming tables perform incremental streaming processing - see the `streamingTable` guide
- Identity columns, and default columns are not supported
- Row filters force full refresh of downstream materialized views
- Sum aggregates over nullable columns return zero instead of NULL when only nulls remain (when last non-NULL value is removed)
- Non-column expressions require explicit aliases (column references do not need aliases)
- PRIMARY KEY requires explicit NOT NULL specification to be valid
- OPTIMIZE and VACUUM commands unavailable, Lakeflow Declarative Pipelines handles maintenance automatically
- `CLUSTER BY` is recommended over `PARTITIONED BY` for most use cases
- Table renaming and ownership changes prohibited
