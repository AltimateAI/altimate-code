# Temporary Views in Spark Declarative Pipelines

Temporary views are pipeline-private views that exist only within the context of the pipeline and are not published to Unity Catalog.

## Key Concepts

Temporary views in Spark Declarative Pipelines:

- Are private to the pipeline (not published to Unity Catalog)
- Can be referenced by other tables/views in the same pipeline
- Do not persist after pipeline execution
- Useful for organizing complex transformations

## Language-Specific Implementations

For detailed implementation guides:

- **Python**: [temporary-view-python.md](temporary-view-python.md)
- **SQL**: [temporary-view-sql.md](temporary-view-sql.md)
