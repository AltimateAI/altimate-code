#### Setup

- `from pyspark import pipelines as dp` (preferred) or `import dlt` (deprecated but still works) is always required on top when doing Python. Prefer `dp` import style unless `dlt` was already imported, don't change existing imports unless explicitly asked.
- The SparkSession object is already available (no need to import it again) - unless in a utility file

#### Core Decorators

- `@dp.materialized_view()` - Materialized views (batch processing, recommended for materialized views)
- `@dp.table()` - Streaming tables (when returning streaming DataFrame) or materialized views (legacy, when returning batch DataFrame)
- `@dp.temporary_view()` - Temporary views (non-materialized, private to pipeline)
- `@dp.expect*()` - Data quality constraints (expect, expect_or_drop, expect_or_fail, expect_all, expect_all_or_drop, expect_all_or_fail)

#### Core Functions

- `dp.create_streaming_table()` - Continuous processing
- `dp.create_auto_cdc_flow()` - Change data capture
- `dp.create_auto_cdc_from_snapshot_flow()` - Change data capture from database snapshots
- `dp.create_sink()` - Write to alternative targets (Kafka, Event Hubs, external Delta tables)
- `@dp.foreach_batch_sink()` - Custom streaming sink with per-batch Python logic (Public Preview)
- `dp.append_flow()` - Append-only patterns
- `dp.read()`/`dp.read_stream()` - Read from other pipeline datasets (deprecated - always use `spark.read.table()` or `spark.readStream.table()` instead)

#### Critical Rules

- ✅ Dataset functions MUST return Spark DataFrames
- ✅ Use `spark.read.table`/`spark.readStream.table` (NOT dp.read* and NOT dlt.read*)
- ✅ Use `auto_cdc` API (NOT apply_changes)
- ✅ Look up documentation for decorator/function parameters when unsure
- ❌ Do not use star imports
- ❌ NEVER use .collect(), .count(), .toPandas(), .save(), .saveAsTable(), .start(), .toTable()
- ❌ AVOID custom monitoring in dataset definitions
- ❌ Keep functions pure (evaluated multiple times)
- ❌ NEVER use the "LIVE." prefix when reading other datasets (deprecated)
- ❌ No arbitrary Python logic in dataset definitions - focus on DataFrame operations only

#### Python-Specific Considerations

**Reading Pipeline Datasets:**

When reading from other datasets defined in the pipeline, use the dataset's **dataset name directly** - NEVER use the `LIVE.` prefix:

```python
# ✅ CORRECT - use the function name directly
customers = spark.read.table("bronze_customers")
transactions = spark.readStream.table("bronze_transactions")

# ❌ WRONG - do NOT use "LIVE." prefix (deprecated)
customers = spark.read.table("LIVE.bronze_customers")
transactions = spark.readStream.table("LIVE.bronze_transactions")
```

The `LIVE.` prefix is deprecated and should never be used. The pipeline automatically resolves dataset references by dataset name.

**Streaming vs. Batch Semantics:**

- Use `spark.read.table()` (or deprecated `dp.read()`/`dlt.read()`) for batch processing (materialized views with full refresh or incremental computation)
- Use `spark.readStream.table()` (or deprecated `dp.read_stream()`/`dlt.read_stream()`) for streaming tables to enable continuous incremental processing
- **Materialized views**: Use `@dp.materialized_view()` decorator (recommended) with batch DataFrame (`spark.read`)
- **Streaming tables**: Use `@dp.table()` decorator with streaming DataFrame (`spark.readStream`)
- Note: The `@dp.table()` decorator can create both batch and streaming tables based on return type, but `@dp.materialized_view()` is preferred for materialized views

#### skipChangeCommits

When a downstream streaming table reads from an upstream streaming table that has updates or deletes (e.g., GDPR compliance, Auto CDC targets), use `skipChangeCommits` to ignore those change commits:

```python
@dp.table()
def downstream():
    return spark.readStream.option("skipChangeCommits", "true").table("upstream_table")
```
