# Sinks in Spark Declarative Pipelines

Sinks enable writing pipeline data to alternative targets beyond Databricks-managed Delta tables, including event streaming services and external tables.

## Key Concepts

Sinks in Spark Declarative Pipelines:

- Write to event streaming services (Apache Kafka, Azure Event Hubs)
- Write to externally-managed Delta tables (Unity Catalog external/managed tables)
- Enable reverse ETL into systems outside Databricks
- Support custom Python data sources
- Work exclusively with streaming queries and append flows

## Language-Specific Implementations

For detailed implementation guides:

- **Python**: [sink-python.md](sink-python.md)

**Important**: Sinks are only available in Python. SQL does not support sinks in Spark Declarative Pipelines.
