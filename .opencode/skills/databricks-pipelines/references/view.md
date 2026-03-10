# Views in Spark Declarative Pipelines

Views provide a way to define reusable query logic and publish datasets to Unity Catalog for broader consumption.

## Key Concepts

Views in Spark Declarative Pipelines:

- Are published to Unity Catalog when the pipeline runs
- Can reference other tables and views in the pipeline
- Support both SQL and Python (with limitations)
- Are refreshed when the pipeline updates

## Language-Specific Implementations

For detailed implementation guides:

- **SQL**: [view-sql.md](view-sql.md)

**Important**: Python in Spark Declarative Pipelines only supports temporary views (private to the pipeline), not persistent views published to Unity Catalog. For Unity Catalog-published views, use SQL syntax with `CREATE VIEW`.
