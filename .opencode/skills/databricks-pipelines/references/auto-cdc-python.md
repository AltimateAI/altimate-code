Auto CDC in Spark Declarative Pipelines processes change data capture (CDC) events from streaming sources or snapshots.

**API Reference:**

**dp.create_auto_cdc_flow() / dp.apply_changes() / dlt.create_auto_cdc_flow() / dlt.apply_changes()**
Applies CDC operations (inserts, updates, deletes) from a streaming source to a target table. Supports SCD Type 1 (latest) and Type 2 (history). Does NOT return a value - call at top level without assignment.

```python
dp.create_auto_cdc_flow(
  target="<target-table>",
  source="<source-table-name>",
  keys=["key1", "key2"],
  sequence_by="<sequence-column>",
  ignore_null_updates=False,
  apply_as_deletes=None,
  apply_as_truncates=None,
  column_list=None,
  except_column_list=None,
  stored_as_scd_type=1,
  track_history_column_list=None,
  track_history_except_column_list=None,
  name=None,
  once=False
)
```

Parameters:

- `target` (str): Target table name (must exist, create with `dp.create_streaming_table()`). **Required.**
- `source` (str): Source table name with CDC events. **Required.**
- `keys` (list): Primary key columns for row identification. **Required.**
- `sequence_by` (str | Column): Column for ordering events (timestamp, version). **Required.** Accepts a string column name or a `Column` expression. For multi-column sequencing, use `struct("col1", "col2")` to order by multiple columns.
- `ignore_null_updates` (bool): If True, NULL values won't overwrite existing non-NULL values
- `apply_as_deletes` (str or Column): Expression identifying delete operations. Use `expr("op = 'D'")` (Column) or `"op = 'D'"` (string).
- `apply_as_truncates` (str or Column): Expression identifying truncate operations. Use `expr("op = 'TRUNCATE'")` (Column) or `"op = 'TRUNCATE'"` (string).
- `column_list` (list): Columns to include (mutually exclusive with `except_column_list`)
- `except_column_list` (list): Columns to exclude
- `stored_as_scd_type` (int): `1` for latest values (default), `2` for full history with `__START_AT`/`__END_AT` columns
- `track_history_column_list` (list): For SCD Type 2, columns to track history for (others use Type 1)
- `track_history_except_column_list` (list): For SCD Type 2, columns to exclude from history tracking
- `name` (str): Flow name (for multiple flows to same target)
- `once` (bool): Process once and stop (default: False)

**dp.create_auto_cdc_from_snapshot_flow() / dp.apply_changes_from_snapshot() / dlt.create_auto_cdc_from_snapshot_flow() / dlt.apply_changes_from_snapshot()**
Applies CDC from full snapshots by comparing to previous state. Automatically infers inserts, updates, deletes.

```python
dp.create_auto_cdc_from_snapshot_flow(
  target="<target-table>",
  source=<source-table-name-or-callable>,
  keys=["key1", "key2"],
  stored_as_scd_type=1,
  track_history_column_list=None,
  track_history_except_column_list=None
)
```

Parameters:

- `target` (str): Target table name (must exist). **Required.**
- `source` (str or callable): **Required.** Can be one of:
  - **String**: Source table name containing the full snapshot (most common)
  - **Callable**: Function for processing historical snapshots with type `SnapshotAndVersionFunction = Callable[[SnapshotVersion], SnapshotAndVersion]`
    - `SnapshotVersion = Union[int, str, float, bytes, datetime.datetime, datetime.date, decimal.Decimal]`
    - `SnapshotAndVersion = Optional[Tuple[DataFrame, SnapshotVersion]]`
    - Function receives the latest processed snapshot version (or None for first run)
    - Must return `None` when no more snapshots to process
    - Must return tuple of `(DataFrame, SnapshotVersion)` for next snapshot to process
    - Snapshot version is used to track progress and must be comparable/orderable
- `keys` (list): Primary key columns. **Required.**
- `stored_as_scd_type` (int): `1` for latest (default), `2` for history
- `track_history_column_list` (list): Columns to track history for (SCD Type 2)
- `track_history_except_column_list` (list): Columns to exclude from history tracking

**Use create_auto_cdc_flow when:** Processing streaming CDC events from transaction logs, Kafka, Delta change feeds
**Use create_auto_cdc_from_snapshot_flow when:** Processing periodic full snapshots (daily dumps, batch extracts)

**Common Patterns:**

**Pattern 1: Basic CDC flow from streaming source**

```python
# Step 1: Create target table
dp.create_streaming_table(name="users")

# Step 2: Define CDC flow (source must be a table name)
dp.create_auto_cdc_flow(
    target="users",
    source="user_changes",
    keys=["user_id"],
    sequence_by="updated_at"
)
```

**Pattern 2: CDC flow with upstream transformation**

```python
# Step 1: Define view with transformation (source preprocessing)
@dp.temporary_view()
def filtered_user_changes():
    return (
        spark.readStream.table("raw_user_changes")
        .filter("user_id IS NOT NULL")
    )

# Step 2: Create target table
dp.create_streaming_table(name="users")

# Step 3: Define CDC flow using the view as source
dp.create_auto_cdc_flow(
    target="users",
    source="filtered_user_changes",  # References the view name
    keys=["user_id"],
    sequence_by="updated_at"
)
# Note: Use distinct names for view and target for clarity
# Note: If "raw_user_changes"  is defined in the pipeline and no additional transformations or expectations are needed,
#  source="raw_user_changes" can be used directly
```

**Pattern 3: CDC with explicit deletes and truncates**

```python
from pyspark.sql.functions import expr

dp.create_streaming_table(name="orders")

dp.create_auto_cdc_flow(
    target="orders",
    source="order_events",
    keys=["order_id"],
    sequence_by="event_timestamp",
    apply_as_deletes=expr("operation = 'DELETE'"),
    apply_as_truncates=expr("operation = 'TRUNCATE'"),
    ignore_null_updates=True
)
```

**Pattern 4: SCD Type 2 (Historical tracking)**

```python
dp.create_streaming_table(name="customer_history")

dp.create_auto_cdc_flow(
    target="customer_history",
    source="source.customer_changes",
    keys=["customer_id"],
    sequence_by="changed_at",
    stored_as_scd_type=2  # Track full history
)
# Target will include __START_AT and __END_AT columns
```

**Pattern 5: Snapshot-based CDC (Simple - table source)**

```python
dp.create_streaming_table(name="products")

@dp.materialized_view(name="product_snapshot")
def product_snapshot():
    return spark.read.table("source.daily_product_dump")

dp.create_auto_cdc_from_snapshot_flow(
    target="products",
    source="product_snapshot",  # String table name - most common
    keys=["product_id"],
    stored_as_scd_type=1
)
```

**Pattern 6: Snapshot-based CDC (Advanced - callable for historical snapshots)**

```python
dp.create_streaming_table(name="products")

# Define a callable to process historical snapshots sequentially
def next_snapshot_and_version(latest_snapshot_version: Optional[int]) -> Tuple[DataFrame, Optional[int]]:
    if latest_snapshot_version is None:
        return (spark.read.load("products.csv"), 1)
    else:
        return None

dp.create_auto_cdc_from_snapshot_flow(
    target="products",
    source=next_snapshot_and_version,  # Callable function for historical processing
    keys=["product_id"],
    stored_as_scd_type=1
)
```

**Pattern 7: Selective column tracking**

```python
dp.create_streaming_table(name="accounts")

dp.create_auto_cdc_flow(
    target="accounts",
    source="account_changes",
    keys=["account_id"],
    sequence_by="modified_at",
    stored_as_scd_type=2,
    track_history_column_list=["balance", "status"],  # Only track history for these columns
    ignore_null_updates=True
)
```

**KEY RULES:**

- Create target with `dp.create_streaming_table()` before defining CDC flow
- `dp.create_auto_cdc_flow()` does NOT return a value - call it at top level without assigning to a variable
- `source` must be a table name (string) - use `@dp.temporary_view()` to preprocess/filter/transform data before CDC processing. A temporary view is the **preferred** approach for source preprocessing (not a streaming table)
- SCD Type 2 adds `__START_AT` and `__END_AT` columns for validity tracking
- When specifying the schema of the target table for SCD Type 2, you must also include the `__START_AT` and `__END_AT` columns with the same data type as the `sequence_by` field
- Legacy names (`apply_changes`, `apply_changes_from_snapshot`) are equivalent but deprecated - prefer `create_auto_cdc_*` variants
