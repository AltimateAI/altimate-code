# ForEachBatch Sinks in Spark Declarative Pipelines

> **Public Preview** — This API may change.

ForEachBatch sinks process a stream as a series of micro-batches, each handled by a custom Python function. Use when built-in sink formats (Delta, Kafka) are insufficient.

## When to Use

- Custom merge/upsert into a Delta table
- Writing to multiple destinations per batch
- Unsupported streaming sinks (e.g., JDBC targets)
- Custom per-batch transformations

## Language Support

- **Python only** — SQL does not support ForEachBatch sinks.

## Implementation Guide

- **Python**: [foreach-batch-sink-python.md](foreach-batch-sink-python.md)
