#### Core SQL Statements

- `CREATE MATERIALIZED VIEW` - Batch processing with full refresh or incremental computation
- `CREATE STREAMING TABLE` - Continuous incremental processing
- `CREATE TEMPORARY VIEW` - Non-materialized views (pipeline lifetime only)
- `CREATE VIEW` - Non-materialized catalog views (Unity Catalog only)
- `AUTO CDC INTO` - Change data capture flows
- `CREATE FLOW` - Define flows or backfills for streaming tables

#### Message Bus Ingestion Functions

- `read_kafka(bootstrapServers => '...', subscribe => '...')` - Apache Kafka
- `read_kinesis(streamName => '...', region => '...')` - AWS Kinesis
- `read_pubsub(subscriptionId => '...', topicId => '...')` - Google Cloud Pub/Sub
- `read_pulsar(serviceUrl => '...', topics => '...')` - Apache Pulsar
- Event Hubs: Use `read_kafka()` with Kafka-compatible Event Hubs config

#### Critical Rules

- ✅ Prefer `CREATE OR REFRESH` syntax for defining datasets (bare `CREATE` also works, but `OR REFRESH` is the idiomatic convention)
- ✅ Use `STREAM` keyword when reading sources for streaming tables
- ✅ Use `read_files()` function for Auto Loader (cloud storage ingestion)
- ✅ Look up documentation for statement parameters when unsure
- ❌ NEVER use `LIVE.` prefix when reading other datasets (deprecated)
- ❌ NEVER use `CREATE LIVE TABLE` or `CREATE LIVE VIEW` (deprecated - use `CREATE STREAMING TABLE`, `CREATE MATERIALIZED VIEW`, or `CREATE TEMPORARY VIEW` instead)
- ❌ Do not use `PIVOT` clause (unsupported)

#### SQL-Specific Considerations

**Streaming vs. Batch Semantics:**

- Omit `STREAM` keyword for materialized views (batch processing)
- Use `STREAM` keyword for streaming tables to enable streaming semantics

**GROUP BY Best Practices:**

- Prefer `GROUP BY ALL` over explicitly listing individual columns unless the user specifically requests explicit grouping
- Benefits: more maintainable when adding/removing columns, less verbose, reduces risk of missing columns in the GROUP BY clause
- Example: `SELECT category, region, SUM(sales) FROM table GROUP BY ALL` instead of `GROUP BY category, region`

**Python UDFs:**

- You can use Python user-defined functions (UDFs) in SQL queries
- UDFs must be defined in Python files before calling them in SQL source files

**Configuration:**

- Use `SET` statements and `${}` string interpolation for dynamic values and Spark configurations

#### skipChangeCommits

When a downstream streaming table reads from an upstream streaming table that has updates or deletes, use `skipChangeCommits` to ignore change commits:

```sql
CREATE OR REFRESH STREAMING TABLE downstream
AS SELECT * FROM STREAM read_stream("upstream_table", skipChangeCommits => true)
```
