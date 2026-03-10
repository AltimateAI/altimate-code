---
name: databricks-pipelines
description: Develop Lakeflow Spark Declarative Pipelines (formerly Delta Live Tables) on Databricks. Use when building batch or streaming data pipelines with Python or SQL. Invoke BEFORE starting implementation.
compatibility: Requires databricks CLI (>= v0.292.0)
metadata:
  version: "0.1.0"
parent: databricks
tags: ["databricks"]
---

# Lakeflow Spark Declarative Pipelines Development

**FIRST**: Use the parent `databricks` skill for CLI basics, authentication, profile selection, and data discovery commands.

## Decision Tree

Use this tree to determine which dataset type and features to use. Multiple features can apply to the same dataset — e.g., a Streaming Table can use Auto Loader for ingestion, Append Flows for fan-in, and Expectations for data quality. Choose the dataset type first, then layer on applicable features.

```
User request → What kind of output?
├── Intermediate/reusable logic (not persisted) → Temporary View
│   ├── Preprocessing/filtering before Auto CDC → Temporary View feeding CDC flow
│   ├── Shared intermediate streaming logic reused by multiple downstream tables
│   ├── Pipeline-private helper logic (not published to catalog)
│   └── Published to UC for external queries → Persistent View (SQL only)
├── Persisted dataset
│   ├── Source is streaming/incremental/continuously growing → Streaming Table
│   │   ├── File ingestion (cloud storage, Volumes) → Auto Loader
│   │   ├── Message bus (Kafka, Kinesis, Pub/Sub, Pulsar, Event Hubs) → streaming source read
│   │   ├── Existing streaming/Delta table → streaming read from table
│   │   ├── CDC / upserts / track changes / keep latest per key / SCD Type 1 or 2 → Auto CDC
│   │   ├── Multiple sources into one table → Append Flows (NOT union)
│   │   ├── Historical backfill + live stream → one-time Append Flow + regular flow
│   │   └── Windowed aggregation with watermark → stateful streaming
│   └── Source is batch/historical/full scan → Materialized View
│       ├── Aggregation/join across full dataset (GROUP BY, SUM, COUNT, etc.)
│       ├── Gold layer aggregation from streaming table → MV with batch read (spark.read / no STREAM)
│       ├── JDBC/Federation/external batch sources
│       └── Small static file load (reference data, no streaming read)
├── Output to external system (Python only) → Sink
│   ├── Existing external table not managed by this pipeline → Sink with format="delta"
│   │   (prefer fully-qualified dataset names if the pipeline should own the table — see Publishing Modes)
│   ├── Kafka / Event Hubs → Sink with format="kafka" + @dp.append_flow(target="sink_name")
│   ├── Custom destination not natively supported → Sink with custom format
│   ├── Custom merge/upsert logic per batch → ForEachBatch Sink (Public Preview)
│   └── Multiple destinations per batch → ForEachBatch Sink (Public Preview)
└── Data quality constraints → Expectations (on any dataset type)
```

## Common Traps

- **"Create a table"** without specifying type → ask whether the source is streaming or batch
- **Materialized View from streaming source** is an error → use a Streaming Table instead, or switch to a batch read
- **Streaming Table from batch source** is an error → use a Materialized View instead, or switch to a streaming read
- **Aggregation over streaming table** → use a Materialized View with batch read (`spark.read.table` / `SELECT FROM` without `STREAM`), NOT a Streaming Table. This is the correct pattern for Gold layer aggregation.
- **Aggregation over batch/historical data** → use a Materialized View, not a Streaming Table. MVs recompute or incrementally refresh aggregates to stay correct; STs are append-only and don't recompute when source data changes.
- **Preprocessing before Auto CDC** → use a Temporary View to filter/transform the source before feeding into the CDC flow. SQL: the CDC flow reads from the view via `STREAM(view_name)`. Python: use `spark.readStream.table("view_name")`.
- **Intermediate logic → default to Temporary View** → Use a Temporary View for intermediate/preprocessing logic, even when reused by multiple downstream tables. Only consider a Private MV/ST (`private=True` / `CREATE PRIVATE ...`) when the computation is expensive and materializing once would save significant reprocessing.
- **View vs Temporary View** → Persistent Views publish to Unity Catalog (SQL only), Temporary Views are pipeline-private
- **Union of streams** → use multiple Append Flows. Do NOT present UNION as an alternative — it is an anti-pattern for streaming sources.
- **Changing dataset type** → cannot change ST→MV or MV→ST without manually dropping the existing table first. Full refresh does NOT help. Rename the new dataset instead.
- **SQL `OR REFRESH`** → Prefer `CREATE OR REFRESH` over bare `CREATE` for SQL dataset definitions. Both work identically, but `OR REFRESH` is the idiomatic convention. For PRIVATE datasets: `CREATE OR REFRESH PRIVATE STREAMING TABLE` / `CREATE OR REFRESH PRIVATE MATERIALIZED VIEW`.
- **Kafka/Event Hubs sink serialization** → The `value` column is mandatory. Use `to_json(struct(*)) AS value` to serialize the entire row as JSON. Read the sink skill for details.
- **Multi-column sequencing** in Auto CDC → SQL: `SEQUENCE BY STRUCT(col1, col2)`. Python: `sequence_by=struct("col1", "col2")`. Read the auto-cdc skill for details.
- **Auto CDC supports TRUNCATE** (SCD Type 1 only) → SQL: `APPLY AS TRUNCATE WHEN condition`. Python: `apply_as_truncates=expr("condition")`. Do NOT say truncate is unsupported.
- **Python-only features** → Sinks, ForEachBatch Sinks, CDC from snapshots, and custom data sources are Python-only. When the user is working in SQL, explicitly clarify this and suggest switching to Python.
- **MV incremental refresh** → Materialized Views on **serverless** pipelines support automatic incremental refresh for aggregations. Mention the serverless requirement when discussing incremental refresh.
- **Recommend ONE clear approach** → Present a single recommended approach. Do NOT present anti-patterns or significantly inferior alternatives — it confuses users. Only mention alternatives if they are genuinely viable for different trade-offs.

## Publishing Modes

Pipelines use a **default catalog and schema** configured in the pipeline settings. All datasets are published there unless overridden.

- **Fully-qualified names**: Use `catalog.schema.table` in the dataset name to write to a different catalog/schema than the pipeline default. The pipeline creates the dataset there directly — no Sink needed.
- **USE CATALOG / USE SCHEMA**: SQL commands that change the current catalog/schema for all subsequent definitions in the same file.
- **LIVE prefix**: Deprecated. Ignored in the default publishing mode.
- When reading or defining datasets within the pipeline, use the dataset name only — do NOT use fully-qualified names unless the pipeline already does so or the user explicitly requests a different target catalog/schema.

## Comprehensive API Reference

**MANDATORY:** Before implementing, editing, or suggesting any code for a feature, you MUST read the linked reference file for that feature. NO exceptions — always look up the reference before writing code.

Some features require reading multiple skills together:

- **Auto Loader** → also read the streaming-table skill (Auto Loader produces a streaming DataFrame, so the target is a streaming table) and look up format-specific options for the file format being loaded
- **Auto CDC** → also read the streaming-table skill (Auto CDC always targets a streaming table)
- **Sinks** → also read the streaming-table skill (sinks use streaming append flows)
- **Expectations** → also read the corresponding dataset definition skill to ensure constraints are correctly placed

### Dataset Definition APIs

| Feature                    | Python (current)                     | Python (deprecated)                   | SQL (current)                               | SQL (deprecated)              | Skill (Py)                                                                | Skill (SQL)                                                         |
| -------------------------- | ------------------------------------ | ------------------------------------- | ------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Streaming Table            | `@dp.table()` returning streaming DF | `@dlt.table()` returning streaming DF | `CREATE OR REFRESH STREAMING TABLE`         | `CREATE STREAMING LIVE TABLE` | [streaming-table-python](streaming-table/streaming-table-python.md)       | [streaming-table-sql](streaming-table/streaming-table-sql.md)       |
| Materialized View          | `@dp.materialized_view()`            | `@dlt.table()` returning batch DF     | `CREATE OR REFRESH MATERIALIZED VIEW`       | `CREATE LIVE TABLE` (batch)   | [materialized-view-python](materialized-view/materialized-view-python.md) | [materialized-view-sql](materialized-view/materialized-view-sql.md) |
| Temporary View             | `@dp.temporary_view()`               | `@dlt.view()`, `@dp.view()`           | `CREATE TEMPORARY VIEW`                     | `CREATE TEMPORARY LIVE VIEW`  | [temporary-view-python](temporary-view/temporary-view-python.md)          | [temporary-view-sql](temporary-view/temporary-view-sql.md)          |
| Persistent View (UC)       | N/A — SQL only                       | —                                     | `CREATE VIEW`                               | —                             | —                                                                         | [view-sql](view/view-sql.md)                                        |
| Streaming Table (explicit) | `dp.create_streaming_table()`        | `dlt.create_streaming_table()`        | `CREATE OR REFRESH STREAMING TABLE` (no AS) | —                             | [streaming-table-python](streaming-table/streaming-table-python.md)       | [streaming-table-sql](streaming-table/streaming-table-sql.md)       |

### Flow and Sink APIs

| Feature                      | Python (current)             | Python (deprecated)           | SQL (current)                          | SQL (deprecated) | Skill (Py)                                                                   | Skill (SQL)                                                   |
| ---------------------------- | ---------------------------- | ----------------------------- | -------------------------------------- | ---------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Append Flow                  | `@dp.append_flow()`          | `@dlt.append_flow()`          | `CREATE FLOW ... INSERT INTO`          | —                | [streaming-table-python](streaming-table/streaming-table-python.md)          | [streaming-table-sql](streaming-table/streaming-table-sql.md) |
| Backfill Flow                | `@dp.append_flow(once=True)` | `@dlt.append_flow(once=True)` | `CREATE FLOW ... INSERT INTO ... ONCE` | —                | [streaming-table-python](streaming-table/streaming-table-python.md)          | [streaming-table-sql](streaming-table/streaming-table-sql.md) |
| Sink (Delta/Kafka/EH/custom) | `dp.create_sink()`           | `dlt.create_sink()`           | N/A — Python only                      | —                | [sink-python](sink/sink-python.md)                                           | —                                                             |
| ForEachBatch Sink            | `@dp.foreach_batch_sink()`   | —                             | N/A — Python only                      | —                | [foreach-batch-sink-python](foreach-batch-sink/foreach-batch-sink-python.md) | —                                                             |

### CDC APIs

| Feature                      | Python (current)                          | Python (deprecated)                         | SQL (current)                   | SQL (deprecated)                     | Skill (Py)                                     | Skill (SQL)                              |
| ---------------------------- | ----------------------------------------- | ------------------------------------------- | ------------------------------- | ------------------------------------ | ---------------------------------------------- | ---------------------------------------- |
| Auto CDC (streaming source)  | `dp.create_auto_cdc_flow()`               | `dlt.apply_changes()`, `dp.apply_changes()` | `AUTO CDC INTO ... FROM STREAM` | `APPLY CHANGES INTO ... FROM STREAM` | [auto-cdc-python](auto-cdc/auto-cdc-python.md) | [auto-cdc-sql](auto-cdc/auto-cdc-sql.md) |
| Auto CDC (periodic snapshot) | `dp.create_auto_cdc_from_snapshot_flow()` | `dlt.apply_changes_from_snapshot()`         | N/A — Python only               | —                                    | [auto-cdc-python](auto-cdc/auto-cdc-python.md) | —                                        |

### Data Quality APIs

| Feature            | Python (current)             | Python (deprecated)           | SQL (current)                                          | Skill (Py)                                                 | Skill (SQL)                                          |
| ------------------ | ---------------------------- | ----------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------- |
| Expect (warn)      | `@dp.expect()`               | `@dlt.expect()`               | `CONSTRAINT ... EXPECT (...)`                          | [expectations-python](expectations/expectations-python.md) | [expectations-sql](expectations/expectations-sql.md) |
| Expect or drop     | `@dp.expect_or_drop()`       | `@dlt.expect_or_drop()`       | `CONSTRAINT ... EXPECT (...) ON VIOLATION DROP ROW`    | [expectations-python](expectations/expectations-python.md) | [expectations-sql](expectations/expectations-sql.md) |
| Expect or fail     | `@dp.expect_or_fail()`       | `@dlt.expect_or_fail()`       | `CONSTRAINT ... EXPECT (...) ON VIOLATION FAIL UPDATE` | [expectations-python](expectations/expectations-python.md) | [expectations-sql](expectations/expectations-sql.md) |
| Expect all (warn)  | `@dp.expect_all({})`         | `@dlt.expect_all({})`         | Multiple `CONSTRAINT` clauses                          | [expectations-python](expectations/expectations-python.md) | [expectations-sql](expectations/expectations-sql.md) |
| Expect all or drop | `@dp.expect_all_or_drop({})` | `@dlt.expect_all_or_drop({})` | Multiple constraints with `DROP ROW`                   | [expectations-python](expectations/expectations-python.md) | [expectations-sql](expectations/expectations-sql.md) |
| Expect all or fail | `@dp.expect_all_or_fail({})` | `@dlt.expect_all_or_fail({})` | Multiple constraints with `FAIL UPDATE`                | [expectations-python](expectations/expectations-python.md) | [expectations-sql](expectations/expectations-sql.md) |

### Reading Data APIs

| Feature                           | Python (current)                               | Python (deprecated)                                 | SQL (current)                                    | SQL (deprecated)                   | Skill (Py)                                                          | Skill (SQL)                                                   |
| --------------------------------- | ---------------------------------------------- | --------------------------------------------------- | ------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| Batch read (pipeline dataset)     | `spark.read.table("name")`                     | `dp.read("name")`, `dlt.read("name")`               | `SELECT ... FROM name`                           | `SELECT ... FROM LIVE.name`        | —                                                                   | —                                                             |
| Streaming read (pipeline dataset) | `spark.readStream.table("name")`               | `dp.read_stream("name")`, `dlt.read_stream("name")` | `SELECT ... FROM STREAM name`                    | `SELECT ... FROM STREAM LIVE.name` | —                                                                   | —                                                             |
| Auto Loader (cloud files)         | `spark.readStream.format("cloudFiles")`        | —                                                   | `STREAM read_files(...)`                         | —                                  | [auto-loader-python](auto-loader/auto-loader-python.md)             | [auto-loader-sql](auto-loader/auto-loader-sql.md)             |
| Kafka source                      | `spark.readStream.format("kafka")`             | —                                                   | `STREAM read_kafka(...)`                         | —                                  | —                                                                   | —                                                             |
| Kinesis source                    | `spark.readStream.format("kinesis")`           | —                                                   | `STREAM read_kinesis(...)`                       | —                                  | —                                                                   | —                                                             |
| Pub/Sub source                    | `spark.readStream.format("pubsub")`            | —                                                   | `STREAM read_pubsub(...)`                        | —                                  | —                                                                   | —                                                             |
| Pulsar source                     | `spark.readStream.format("pulsar")`            | —                                                   | `STREAM read_pulsar(...)`                        | —                                  | —                                                                   | —                                                             |
| Event Hubs source                 | `spark.readStream.format("kafka")` + EH config | —                                                   | `STREAM read_kafka(...)` + EH config             | —                                  | —                                                                   | —                                                             |
| JDBC / Lakehouse Federation       | `spark.read.format("postgresql")` etc.         | —                                                   | Direct table ref via federation catalog          | —                                  | —                                                                   | —                                                             |
| Custom data source                | `spark.read[Stream].format("custom")`          | —                                                   | N/A — Python only                                | —                                  | —                                                                   | —                                                             |
| Static file read (batch)          | `spark.read.format("json"\|"csv"\|...).load()` | —                                                   | `read_files(...)` (no STREAM)                    | —                                  | —                                                                   | —                                                             |
| Skip upstream change commits      | `.option("skipChangeCommits", "true")`         | —                                                   | `read_stream("name", skipChangeCommits => true)` | —                                  | [streaming-table-python](streaming-table/streaming-table-python.md) | [streaming-table-sql](streaming-table/streaming-table-sql.md) |

### Table/Schema Feature APIs

| Feature                      | Python (current)                                      | SQL (current)                           | Skill (Py)                                                                | Skill (SQL)                                                         |
| ---------------------------- | ----------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Liquid clustering            | `cluster_by=[...]`                                    | `CLUSTER BY (col1, col2)`               | [materialized-view-python](materialized-view/materialized-view-python.md) | [materialized-view-sql](materialized-view/materialized-view-sql.md) |
| Auto liquid clustering       | `cluster_by_auto=True`                                | `CLUSTER BY AUTO`                       | [materialized-view-python](materialized-view/materialized-view-python.md) | [materialized-view-sql](materialized-view/materialized-view-sql.md) |
| Partition columns            | `partition_cols=[...]`                                | `PARTITIONED BY (col1, col2)`           | [materialized-view-python](materialized-view/materialized-view-python.md) | [materialized-view-sql](materialized-view/materialized-view-sql.md) |
| Table properties             | `table_properties={...}`                              | `TBLPROPERTIES (...)`                   | [materialized-view-python](materialized-view/materialized-view-python.md) | [materialized-view-sql](materialized-view/materialized-view-sql.md) |
| Explicit schema              | `schema="col1 TYPE, ..."`                             | `(col1 TYPE, ...) AS`                   | [materialized-view-python](materialized-view/materialized-view-python.md) | [materialized-view-sql](materialized-view/materialized-view-sql.md) |
| Generated columns            | `schema="..., col TYPE GENERATED ALWAYS AS (expr)"`   | `col TYPE GENERATED ALWAYS AS (expr)`   | [materialized-view-python](materialized-view/materialized-view-python.md) | [materialized-view-sql](materialized-view/materialized-view-sql.md) |
| Row filter (Public Preview)  | `row_filter="ROW FILTER fn ON (col)"`                 | `WITH ROW FILTER fn ON (col)`           | [materialized-view-python](materialized-view/materialized-view-python.md) | [materialized-view-sql](materialized-view/materialized-view-sql.md) |
| Column mask (Public Preview) | `schema="..., col TYPE MASK fn USING COLUMNS (col2)"` | `col TYPE MASK fn USING COLUMNS (col2)` | [materialized-view-python](materialized-view/materialized-view-python.md) | [materialized-view-sql](materialized-view/materialized-view-sql.md) |
| Private dataset              | `private=True`                                        | `CREATE PRIVATE ...`                    | [materialized-view-python](materialized-view/materialized-view-python.md) | [materialized-view-sql](materialized-view/materialized-view-sql.md) |

### Import / Module APIs

| Current                                           | Deprecated                                                            | Notes                                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `from pyspark import pipelines as dp`             | `import dlt`                                                          | Both work. Prefer `dp`. Do NOT change existing `dlt` imports.                                          |
| `spark.read.table()` / `spark.readStream.table()` | `dp.read()` / `dp.read_stream()` / `dlt.read()` / `dlt.read_stream()` | Deprecated reads still work. Prefer `spark.*`.                                                         |
| —                                                 | `LIVE.` prefix                                                        | Fully deprecated. NEVER use. Causes errors in newer pipelines.                                         |
| —                                                 | `CREATE LIVE TABLE` / `CREATE LIVE VIEW`                              | Fully deprecated. Use `CREATE STREAMING TABLE` / `CREATE MATERIALIZED VIEW` / `CREATE TEMPORARY VIEW`. |

## Language-specific guides


Lakeflow Spark Declarative Pipelines (formerly Delta Live Tables / DLT) is a framework for building batch and streaming data pipelines.

## Scaffolding a New Pipeline Project

Use `databricks bundle init` with a config file to scaffold non-interactively. This creates a project in the `<project_name>/` directory:

```bash
databricks bundle init lakeflow-pipelines --config-file <(echo '{"project_name": "my_pipeline", "language": "python", "serverless": "yes"}') --profile <PROFILE> < /dev/null
```

- `project_name`: letters, numbers, underscores only
- `language`: `python` or `sql`. Ask the user which they prefer:
  - SQL: Recommended for straightforward transformations (filters, joins, aggregations)
  - Python: Recommended for complex logic (custom UDFs, ML, advanced processing)

After scaffolding, create `CLAUDE.md` and `AGENTS.md` in the project directory. These files are essential to provide agents with guidance on how to work with the project. Use this content:

```
# Databricks Asset Bundles Project

This project uses Databricks Asset Bundles for deployment.

## Prerequisites

Install the Databricks CLI (>= v0.288.0) if not already installed:
- macOS: `brew tap databricks/tap && brew install databricks`
- Linux: `curl -fsSL https://raw.githubusercontent.com/databricks/setup-cli/main/install.sh | sh`
- Windows: `winget install Databricks.DatabricksCLI`

Verify: `databricks -v`

## For AI Agents

Read the `databricks` skill for CLI basics, authentication, and deployment workflow.
Read the `databricks-pipelines` skill for pipeline-specific guidance.

If skills are not available, install them: `databricks experimental aitools skills install`
```

## Pipeline Structure

- Follow the medallion architecture pattern (Bronze → Silver → Gold) unless the user specifies otherwise
- Use the convention of 1 dataset per file, named after the dataset
- Place transformation files in a `src/` or `transformations/` folder

```
my-pipeline-project/
├── databricks.yml                        # Bundle configuration
├── resources/
│   ├── my_pipeline.pipeline.yml          # Pipeline definition
│   └── my_pipeline_job.job.yml           # Scheduling job (optional)
└── src/
    ├── my_table.py (or .sql)             # One dataset per file
    ├── another_table.py (or .sql)
    └── ...
```

## Scheduling Pipelines

To schedule a pipeline, add a job that triggers it in `resources/<name>.job.yml`:

```yaml
resources:
  jobs:
    my_pipeline_job:
      trigger:
        periodic:
          interval: 1
          unit: DAYS
      tasks:
        - task_key: refresh_pipeline
          pipeline_task:
            pipeline_id: ${resources.pipelines.my_pipeline.id}
```

## Running Pipelines

**You must deploy before running.** In local development, code changes only take effect after `databricks bundle deploy`. Always deploy before any run, dry run, or selective refresh.

- Selective refresh is preferred when you only need to run one table. For selective refresh it is important that dependencies are already materialized.
- **Full refresh is the most expensive and dangerous option, and can lead to data loss**, so it should be used only when really necessary. Always suggest this as a follow-up that the user explicitly needs to select.

## Development Workflow

1. **Validate**: `databricks bundle validate --profile <profile>`
2. **Deploy**: `databricks bundle deploy -t dev --profile <profile>`
3. **Run pipeline**: `databricks bundle run <pipeline_name> -t dev --profile <profile>`
4. **Check status**: `databricks pipelines get --pipeline-id <id> --profile <profile>`

## Pipeline API Reference

Detailed reference guides for each pipeline API. **Read the relevant guide before writing pipeline code.**

- [Write Spark Declarative Pipelines](references/write-spark-declarative-pipelines.md) — Core syntax and rules ([Python](references/python-basics.md), [SQL](references/sql-basics.md))
- [Streaming Tables](references/streaming-table.md) — Continuous data stream processing ([Python](references/streaming-table-python.md), [SQL](references/streaming-table-sql.md))
- [Materialized Views](references/materialized-view.md) — Physically stored query results with incremental refresh ([Python](references/materialized-view-python.md), [SQL](references/materialized-view-sql.md))
- [Views](references/view.md) — Reusable query logic published to Unity Catalog ([SQL](references/view-sql.md))
- [Temporary Views](references/temporary-view.md) — Pipeline-private views ([Python](references/temporary-view-python.md), [SQL](references/temporary-view-sql.md))
- [Auto Loader](references/auto-loader.md) — Incrementally ingest files from cloud storage ([Python](references/auto-loader-python.md), [SQL](references/auto-loader-sql.md))
- [Auto CDC](references/auto-cdc.md) — Process Change Data Capture feeds, SCD Type 1 & 2 ([Python](references/auto-cdc-python.md), [SQL](references/auto-cdc-sql.md))
- [Expectations](references/expectations.md) — Define and enforce data quality constraints ([Python](references/expectations-python.md), [SQL](references/expectations-sql.md))
- [Sinks](references/sink.md) — Write to Kafka, Event Hubs, external Delta tables ([Python](references/sink-python.md))
- [ForEachBatch Sinks](references/foreach-batch-sink.md) — Custom streaming sink with per-batch Python logic ([Python](references/foreach-batch-sink-python.md))
