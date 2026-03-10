# Materialized Views in Spark Declarative Pipelines

Materialized views store the results of a query physically, enabling faster query performance for expensive transformations and aggregations.

## Key Concepts

Materialized views in Spark Declarative Pipelines:

- Physically store query results
- Are incrementally refreshed when source data changes
- Support complex transformations and aggregations
- Published to Unity Catalog

## Language-Specific Implementations

For detailed implementation guides:

- **Python**: [materialized-view-python.md](materialized-view-python.md)
- **SQL**: [materialized-view-sql.md](materialized-view-sql.md)
