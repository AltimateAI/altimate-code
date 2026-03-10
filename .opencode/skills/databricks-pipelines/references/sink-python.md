Sinks enable writing pipeline data to alternative targets like event streaming services (Apache Kafka, Azure Event Hubs), external Delta tables, or custom data sources using Python code. Sinks are Python-only and work exclusively with streaming append flows.

## Creating Sinks

**dp.create_sink() / dlt.create_sink()**

Defines a sink for writing to alternative targets (Kafka, Event Hubs, external Delta tables). Call at top level before using in append flows.

```python
dp.create_sink(
  name="<sink-name>",
  format="<format>",
  options={"<key>": "<value>"}
)
```

Parameters:

- `name` (str): Unique identifier for the sink within the pipeline. Used to reference the sink in append flows. **Required.**
- `format` (str): Output format (`"kafka"`, `"delta"`, or custom format). Determines required options. **Required.**
- `options` (dict): Configuration dictionary with format-specific key-value pairs. Required options depend on the format. **Required.**

## Writing to Sinks

After creating a sink, use `@dp.append_flow()` (or `@dlt.append_flow()`) decorator to write streaming data to it. The `target` parameter specifies which sink to write to (must match a sink name created with `dp.create_sink()`).

For complete documentation on append flows, see [streaming-table-python.md](../streaming-table/streaming-table-python.md).

## Supported Sink Formats

### Delta Sinks

Write to Unity Catalog external/managed tables or file paths.

**Options for Unity Catalog tables:**

```python
{
  "tableName": "catalog_name.schema_name.table_name"  # Fully qualified table name
}
```

**Options for file paths:**

```python
{
  "path": "/Volumes/catalog_name/schema_name/path/to/data"
}
```

**Example:**

```python
# Create Delta sink with table name
dp.create_sink(
  name="delta_sink",
  format="delta",
  options={"tableName": "main.sales.transactions"}
)

# Write to sink using append flow
@dp.append_flow(name="write_to_delta", target="delta_sink")
def write_transactions():
    return spark.readStream.table("bronze_transactions") \
        .select("transaction_id", "customer_id", "amount", "timestamp")
```

### Kafka and Azure Event Hubs Sinks

Write to Apache Kafka or Azure Event Hubs topics for real-time event streaming.

**Important**: This code works for both Apache Kafka and Azure Event Hubs sinks.

**Required options:**

```python
{
  "kafka.bootstrap.servers": "host:port",           # Kafka/Event Hubs endpoint
  "topic": "topic_name",                            # Target topic
  "databricks.serviceCredential": "credential_name" # Unity Catalog service credential
}
```

**Authentication**: Use `databricks.serviceCredential` to reference a Unity Catalog service credential for connecting to external cloud services.

**Data format requirements**:

- The `value` parameter is mandatory for Kafka and Azure Event Hubs sinks
- Optional parameters: `key`, `partition`, `headers`, and `topic`

**Example (works for both Kafka and Event Hubs):**

```python
# Define credentials and connection details
credential_name = "<service-credential>"
bootstrap_servers = "kafka-broker:9092"  # or "{eh-namespace}.servicebus.windows.net:9093" for Event Hubs
topic_name = "customer_events"

# Create Kafka/Event Hubs sink
dp.create_sink(
  name="kafka_sink",
  format="kafka",
  options={
    "databricks.serviceCredential": credential_name,
    "kafka.bootstrap.servers": bootstrap_servers,
    "topic": topic_name
  }
)

# Write to sink with required value parameter
@dp.append_flow(name="stream_to_kafka", target="kafka_sink")
def kafka_flow():
    return spark.readStream.table("customer_events") \
        .selectExpr(
            "cast(customer_id as string) as key",
            "to_json(struct(*)) AS value"
        )
```

## Limitations and Considerations

- Sinks only work with streaming queries and cannot be used with batch DataFrames
- Only compatible with `@dp.append_flow()` decorator
- Full refresh updates don't clean existing sink data
  - Reprocessed data will be appended to the sink
  - Consider idempotency: Design for duplicate writes since full refresh appends data
- Delta sink table names must be fully qualified (catalog.schema.table), use three-part names for Unity Catalog tables
- Volume file paths are supported as an alternative
- Pipeline expectations cannot be applied to sinks
  - Apply data quality checks before writing to sinks
  - Validate data in upstream tables/views instead
- Sinks are Python-only in Spark Declarative Pipelines, SQL does not support sink creation or usage
- Handle serialization: For Kafka/Event Hubs, convert data to JSON or appropriate format
