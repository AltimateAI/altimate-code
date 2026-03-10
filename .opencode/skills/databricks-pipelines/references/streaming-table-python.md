Streaming Tables in Spark Declarative Pipelines enable incremental processing of continuously arriving data.

**NOTE:** This guide focuses on streaming tables. For details on materialized views (batch processing with `spark.read`), use the API guide for `materializedView` instead.

**API Reference:**

**@dp.table() / @dlt.table()**
Decorator to define a streaming table or materialized view. Returns streaming table when function returns `spark.readStream`. For materialized views using `spark.read`, see the `materializedView` API guide.

```python
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
def my_append_flow():
    return spark.readStream.table("source.data")
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

**dp.create_streaming_table() / dlt.create_streaming_table()**
Creates an empty streaming table as target for CDC flows or append flows. Does NOT return a value - call at top level without assignment.

```python
dp.create_streaming_table(
  name="<table-name>",
  comment="<comment>",
  spark_conf={"<key>": "<value>"},
  table_properties={"<key>": "<value>"},
  path="<storage-location-path>",
  partition_cols=["<partition-column>"],
  cluster_by_auto=True,
  cluster_by=["<clustering-column>"],
  schema="schema-definition",
  expect_all={"<key>": "<value>"},
  expect_all_or_drop={"<key>": "<value>"},
  expect_all_or_fail={"<key>": "<value>"},
  row_filter="row-filter-clause"
)
```

Parameters: Same as @dp.table() except `private`, plus:

- `expect_all` (dict): Data quality expectations (warn on failure, include in target)
- `expect_all_or_drop` (dict): Expectations that drop failing rows from target
- `expect_all_or_fail` (dict): Expectations that fail pipeline on violation

**@dp.append_flow() / @dlt.append_flow()**
Decorator to define a flow that appends data from a source to an existing target table. Multiple append flows can write to the same target table.

```python
@dp.append_flow(
  target="<target-table-name>",
  name="<flow-name>",  # optional, defaults to function name
  once=<boolean>,  # optional, defaults to False
  spark_conf={"<key>": "<value>", "<key>": "<value>"},  # optional
  comment="<comment>"  # optional
)
def my_append_flow():
    # For once=False (streaming): use spark.readStream
    return spark.readStream.table("source.data")
    # For once=True (batch): use spark.read
    return spark.read.table("source.data")
```

Parameters:

- `target` (str): The name of the target streaming table where data will be appended. Target must exist (created with `dp.create_streaming_table()`). **Required.**
- `name` (str): The name of the flow. If not specified, defaults to the function name. Use distinct names when multiple flows target the same table.
- `once` (bool): Controls whether the flow runs continuously or once:
  - **False (default)**: Flow continuously processes new data as it arrives in streaming mode. **Must return a streaming DataFrame using `spark.readStream`**, CAN use `cloudFiles` (Auto Loader).
  - **True**: Flow processes data only once during pipeline execution and then stops. **Must return a batch DataFrame using `spark.read`**. Do NOT use `cloudFiles` (Auto Loader) with `once=True` - use regular batch reads like `spark.read.format("<format>")` instead.
- `spark_conf` (dict): A dictionary of Spark configuration key-value pairs to apply specifically to this flow's query execution (e.g., `{"spark.sql.shuffle.partitions": "10"}`).
- `comment` (str): A description of the flow that appears in the pipeline metadata and documentation.

**Two Ways to Define Streaming Tables:**

1. **@dp.table decorator (MOST COMMON)**
   - Returns a streaming DataFrame using `spark.readStream`
   - Automatically inferred as a streaming table when returning a streaming DataFrame

   ```python
   @dp.table(name="events_stream")
   def events_stream():
       return spark.readStream.table("source_catalog.schema.events")
   ```

2. **dp.create_streaming_table()**
   - Creates an empty streaming table target
   - Required as target for Auto CDC flows and append flows
   - Does NOT return a value (do not assign to a variable)

   ```python
   dp.create_streaming_table(
       name="users",
       schema="user_id INT, name STRING, updated_at TIMESTAMP"
   )
   ```

**WHEN TO USE WHICH:**

Use **@dp.table with readStream** when:

- Reading and transforming streaming data
- Creating streaming tables from sources (Auto Loader, Delta tables, etc.)
- This is the standard pattern for most streaming use cases

Use **dp.create_streaming_table()** when:

- Creating a target table for `dp.create_auto_cdc_flow()`
- Creating a target table for `@dp.append_flow` from multiple sources
- Need to explicitly define table schema before data flows in

**Common Patterns:**

**Pattern 1: Simple streaming transformation**

```python
@dp.table()
def bronze():
    return spark.readStream.format("cloudFiles") \
        .option("cloudFiles.format", "json") \
        .load("/path/to/data")

@dp.table()
def silver():
    return spark.readStream.table("bronze").filter("id IS NOT NULL")
```

**Pattern 2: Multi-source aggregation**

```python
dp.create_streaming_table(name="all_events")

@dp.append_flow(target="all_events", name="mobile")
def mobile():
    return spark.readStream.table("mobile.events")

@dp.append_flow(target="all_events", name="web")
def web():
    return spark.readStream.table("web.events")
```

**Pattern 3: One-time backfill with append flow**

```python
dp.create_streaming_table(name="transactions")

# Continuous streaming flow for new data
@dp.append_flow(target="transactions", name="live_stream")
def live_transactions():
    return spark.readStream.table("source.transactions")

# One-time backfill flow for historical data (uses spark.read for batch)
@dp.append_flow(
    target="transactions",
    name="historical_backfill",
    once=True,
    comment="Backfill historical transactions from archive"
)
def backfill_transactions():
    return spark.read.table("archive.historical_transactions")
```

**Pattern 4: Row filters for data security**

```python
# Assumes filter_by_dept is a SQL UDF defined in Unity Catalog that returns BOOLEAN

# Apply row filter to streaming table
@dp.table(
    name="employees",
    schema="emp_id INT, emp_name STRING, dept STRING, salary DECIMAL(10,2)",
    row_filter="ROW FILTER my_catalog.my_schema.filter_by_dept ON (dept)"
)
def employees():
    return spark.readStream.table("source.employees")
```

**Pattern 5: Stream-static join (enrich streaming data with dimension table)**

```python
@dp.table()
def enriched_transactions():
    transactions = spark.readStream.table("transactions")
    customers = spark.read.table("customers")
    return transactions.join(customers, transactions.customer_id == customers.id)
```

The dimension table (`customers`) is read as a static snapshot at stream start, while the streaming source (`transactions`) is read incrementally.

**Pattern 6: Reading from upstream ST with updates/deletes (skipChangeCommits)**

```python
@dp.table()
def downstream():
    return spark.readStream.option("skipChangeCommits", "true").table("upstream_with_deletes")
```

Use `skipChangeCommits` when reading from a streaming table that has updates/deletes (e.g., GDPR compliance, Auto CDC targets). Without this flag, change commits cause errors.

**KEY RULES:**

- Streaming tables use `spark.readStream` (streaming reads)
- Materialized views use `spark.read` (batch reads) - see the `materializedView` API guide
- Never use `.writeStream`, `.start()`, or checkpoint options - Databricks manages these automatically
- For streaming flows (`once=False`): Use `spark.readStream` to return a streaming DataFrame
- For one-time flows (`once=True`): Use `spark.read` to return a batch DataFrame
- Generated columns, constraints, and masks require schema definition
- Row filters force full refresh of downstream materialized views
- Use `skipChangeCommits` when reading from STs that have updates/deletes
