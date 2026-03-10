Materialized Views in Spark Declarative Pipelines enable batch processing of data with full refresh or incremental computation.

**NOTE:** This guide focuses on materialized views. For details on streaming tables (incremental processing with `spark.readStream`), use the API guide for `streamingTable` instead.

**API Reference:**

**@dp.materialized_view() (Recommended)**
Decorator to define a materialized view. This is the recommended approach for creating materialized views.

```python
@dp.materialized_view(
  name="<name>",
  comment="<comment>",
  spark_conf={"<key>": "<value>"},
  table_properties={"<key>": "<value>"},
  path="<storage-location-path>",
  partition_cols=["<partition-column>"],
  cluster_by_auto=True,
  cluster_by=["<clustering-column>"],
  schema="schema-definition",
  row_filter="row-filter-clause",
  private=False
)
def my_materialized_view():
    return spark.read.table("source.data")
```

**@dp.table() / @dlt.table() (Alternative for Materialized Views)**
In the older `dlt` module, the `@dlt.table` decorator was used to create both streaming tables and materialized views. The `@dp.table()` decorator in the `pyspark.pipelines` module still works in this way, but Databricks recommends using the `@dp.materialized_view()` decorator to create materialized views. Note that `@dp.table()` remains the standard decorator for streaming tables.

```python
# Still works, but @dp.materialized_view() is preferred for materialized views
@dp.table(
  name="<name>",
  comment="<comment>",
  spark_conf={"<key>": "<value>"},
  table_properties={"<key>": "<value>"},
  path="<storage-location-path>",
  partition_cols=["<partition-column>"],
  cluster_by_auto=True,
  cluster_by=["<clustering-column>"],
  schema="schema-definition",
  row_filter="row-filter-clause",
  private=False
)
def my_materialized_view():
    return spark.read.table("source.data")
```

Parameters:

- `name` (str): Table name (defaults to function name)
- `comment` (str): Description for the table
- `spark_conf` (dict): Spark configurations for query execution
- `table_properties` (dict): Delta table properties
- `path` (str): Storage location for table data (defaults to managed location)
- `partition_cols` (list): Columns to partition the table by
- `cluster_by_auto` (bool): Enable automatic liquid clustering
- `cluster_by` (list): Columns to use as clustering keys for liquid clustering
- `schema` (str or StructType): Schema definition (SQL DDL string or StructType)
  - Supports generated columns: `"order_datetime STRING, order_day STRING GENERATED ALWAYS AS (dayofweek(order_datetime))"`
  - Supports constraints: Primary keys, foreign keys
  - Supports column masks: `"ssn STRING MASK catalog.schema.ssn_mask_fn USING COLUMNS (region)"`
- `row_filter` (str): (Public Preview) A row filter clause that filters rows when fetched from the table.
  - Must use syntax: `"ROW FILTER func_name ON (column_name [, ...])"` where `func_name` is a SQL UDF returning `BOOLEAN`. The UDF can be defined in Unity Catalog.
    - Rows are filtered out when the function returns `FALSE` or `NULL`.
    - You can pass table columns or constant literals (`STRING`, numeric, `BOOLEAN`, `INTERVAL`, `NULL`) as arguments.
    - The filter is applied as soon as rows are fetched from the data source.
    - The function runs with pipeline owner's rights during refresh and invoker's rights during queries (allowing user-context functions like `CURRENT_USER()` and `IS_MEMBER()` for data security).
  - Note: Using row filters on source tables forces full refresh of downstream materialized views.
  - Note: It is NOT possible to call `CREATE FUNCTION` within a Spark Declarative Pipeline.
- `private` (bool): Restricts table to pipeline scope; prevents metastore publication

**Materialized View vs Streaming Table:**

- **Materialized View**: Use `@dp.materialized_view()` decorator with function returning `spark.read...` (batch DataFrame)
- **Streaming Table**: Use `@dp.table()` decorator with function returning `spark.readStream...` (streaming DataFrame) - see the `streamingTable` API guide

Note: When using `@dp.table()` with a batch DataFrame return type, a materialized view is created. However, `@dp.materialized_view()` is preferred for this use case. The `@dp.table()` decorator remains the standard approach for streaming tables (with streaming DataFrame return type).

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

**Supported SQL operations for incremental refresh (use PySpark DataFrame API equivalents in Python):**

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

**Limitations:**

- Falls back to full recompute when incremental is more expensive or query uses unsupported expressions

**Best practices:**

- Enable deletion vectors, row tracking, and change data feed on source tables for optimal incremental refresh
- Design queries with supported operations to leverage incremental refresh
- For exactly-once processing semantics (Kafka, Auto Loader), use streaming tables instead

**Common Patterns:**

**Pattern 1: Simple batch transformation**

```python
@dp.materialized_view()
def bronze_batch():
    return spark.read.format("parquet").load("/path/to/data")

@dp.materialized_view()
def silver_batch():
    return spark.read.table("bronze_batch").filter("id IS NOT NULL")
```

**Pattern 2: Schema with generated columns**

```python
@dp.materialized_view(
    schema="""
        order_datetime STRING,
        order_day_of_week STRING GENERATED ALWAYS AS (dayofweek(order_datetime)),
        customer_id BIGINT,
        amount DECIMAL(10,2)
    """,
    cluster_by=["order_day_of_week", "customer_id"]
)
def orders_with_day():
    return spark.read.table("raw.orders")
```

**Pattern 3: Row filters for data security**

```python
# Assumes filter_by_dept is a SQL UDF defined in Unity Catalog that returns BOOLEAN

@dp.materialized_view(
    name="employees",
    schema="emp_id INT, emp_name STRING, dept STRING, salary DECIMAL(10,2)",
    row_filter="ROW FILTER my_catalog.my_schema.filter_by_dept ON (dept)"
)
def employees():
    return spark.read.table("source.employees")
```

**Pattern 4: Column masking for sensitive data**

```python
@dp.materialized_view(
    schema="""
        user_id BIGINT,
        ssn STRING MASK catalog.schema.ssn_mask_fn USING COLUMNS (region),
        region STRING
    """
)
def users_with_masked_ssn():
    return spark.read.table("raw.users")
```

**KEY RULES:**

- Use `@dp.materialized_view()` for materialized views (preferred over `@dp.table()`)
- Materialized views use `spark.read` (batch reads)
- Streaming tables use `spark.readStream` (streaming reads) - see the `streamingTable` API guide
- Never use `.write`, `.save()`, `.saveAsTable()`, or `.toTable()` - Databricks manages writes automatically
- Generated columns, constraints, and masks require schema definition
- Row filters force full refresh of downstream materialized views
