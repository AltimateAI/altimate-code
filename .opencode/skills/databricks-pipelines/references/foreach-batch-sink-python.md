ForEachBatch sinks in Spark Declarative Pipelines process a stream as micro-batches with custom Python logic. **Public Preview** — this API may change.

**When to use:** Use ForEachBatch when built-in sink formats (`delta`, `kafka`) are insufficient:

- Custom merge/upsert logic into a Delta table
- Writing to multiple destinations per batch
- Writing to unsupported streaming sinks (e.g., JDBC targets)
- Custom per-batch transformations

**API Reference:**

**@dp.foreach_batch_sink()**
Decorator that defines a ForEachBatch sink. The decorated function is called for each micro-batch.

```python
@dp.foreach_batch_sink(name="<name>")
def my_sink(df, batch_id):
    # df: Spark DataFrame with micro-batch data
    # batch_id: integer ID for the micro-batch (0 = start of stream or full refresh)
    # Access SparkSession via df.sparkSession
    pass
```

Parameters:

- `name` (str): Optional. Unique name for the sink within the pipeline. Defaults to function name.

The decorated function receives:

- `df` (DataFrame): Spark DataFrame containing data for the current micro-batch
- `batch_id` (int): Integer ID of the micro-batch. Spark increments this for each trigger interval. `0` means start of stream or beginning of a full refresh — the handler should properly handle a full refresh for downstream data sources.

The handler does not need to return a value.

**Writing to a ForEachBatch Sink:**

Use `@dp.append_flow()` with the `target` parameter matching the sink name:

```python
@dp.append_flow(target="my_sink")
def my_flow():
    return spark.readStream.table("source_table")
```

**Common Patterns:**

**Pattern 1: Merge/upsert into a Delta table**

The target table must already exist before the MERGE runs. Create it externally or handle creation in the handler.

```python
@dp.foreach_batch_sink(name="upsert_sink")
def upsert_sink(df, batch_id):
    df.createOrReplaceTempView("batch_data")
    df.sparkSession.sql("""
        MERGE INTO target_catalog.schema.target_table AS target
        USING batch_data AS source
        ON target.id = source.id
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
    """)
    return

@dp.append_flow(target="upsert_sink")
def upsert_flow():
    return spark.readStream.table("source_events")
```

**Pattern 2: Write to multiple destinations with idempotent writes**

Use `txnVersion`/`txnAppId` for idempotent Delta writes — if a batch partially fails and retries, already-completed writes are safely skipped.

```python
app_id = "my-app-name"  # must be unique per application writing to the same table

@dp.foreach_batch_sink(name="multi_target_sink")
def multi_target_sink(df, batch_id):
    df.write.format("delta").mode("append") \
        .option("txnVersion", batch_id).option("txnAppId", app_id) \
        .saveAsTable("my_catalog.my_schema.table_a")
    df.write.format("json").mode("append") \
        .option("txnVersion", batch_id).option("txnAppId", app_id) \
        .save("/tmp/json_target")
    return

@dp.append_flow(target="multi_target_sink")
def multi_target_flow():
    return spark.readStream.table("processed_events")
```

When writing to multiple destinations, use `df.persist()` or `df.cache()` inside the handler to read the source data only once instead of once per destination.

**Pattern 3: Enrich and write to an external Delta table**

```python
from pyspark.sql.functions import current_timestamp

@dp.foreach_batch_sink(name="enriched_sink")
def enriched_sink(df, batch_id):
    enriched = df.withColumn("processed_timestamp", current_timestamp())
    enriched.write.format("delta").mode("append") \
        .saveAsTable("my_catalog.my_schema.enriched_events")
    return

@dp.append_flow(target="enriched_sink")
def enriched_flow():
    return spark.readStream.table("source_events")
```

**KEY RULES:**

- ForEachBatch sinks are **Python only** and in **Public Preview**
- Designed for streaming queries (`append_flow`) only — not for batch-only pipelines or Auto CDC semantics
- The pipeline does NOT track data written from a ForEachBatch sink — you manage downstream data and retention
- On full refresh, checkpoints reset and `batch_id` restarts from 0. Data in your target is NOT automatically cleaned up — you must manually drop or truncate target tables/locations if a clean slate is needed
- Multiple `@dp.append_flow()` decorators can target the same sink — each flow maintains its own checkpoint
- To access SparkSession inside the handler, use `df.sparkSession` (not `spark`)
- ForEachBatch supports all Unity Catalog features — you can write to UC managed or external tables and volumes
- When writing to multiple destinations, use `df.persist()` or `df.cache()` to avoid multiple source reads, and `txnVersion`/`txnAppId` for idempotent Delta writes
- Keep the handler function concise — avoid threading, heavy library dependencies, or large in-memory data manipulations
- **databricks-connect compatibility**: If your pipeline may run on databricks-connect, the handler function must be serializable and must not use `dbutils`. Avoid referencing local objects, classes, or unpickleable resources — use pure Python modules. Move `dbutils` calls (e.g., `dbutils.widgets.get()`) outside the handler and capture values in variables. The pipeline raises a warning in the event log for non-serializable UDFs but does not fail the pipeline. However, non-serializable logic can break at runtime in databricks-connect contexts
