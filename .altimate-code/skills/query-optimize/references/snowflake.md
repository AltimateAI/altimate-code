# Snowflake Query Optimization

## Micro-Partitions and Pruning
Snowflake stores data in immutable micro-partitions (~16 MB compressed). Queries scan only partitions matching filter predicates. Effective pruning can skip 90%+ of data.

**Check pruning**: `SELECT SYSTEM$CLUSTERING_INFORMATION('table', '(col)')` shows overlap and depth metrics. Overlap > 2 means poor clustering.

## Clustering Keys
Explicit clustering reorders micro-partitions to improve pruning on specific columns:
- Cluster on columns used in WHERE, JOIN, and ORDER BY
- Best for columns with high cardinality (timestamps, IDs) used in range filters
- Clustering is automatic background maintenance (costs credits)
- Avoid clustering tables under 1 TB -- natural insertion order is usually sufficient

## Result Cache
Identical queries return cached results in <100ms at zero compute cost:
- Cache persists 24 hours and invalidates when underlying data changes
- Avoid non-deterministic functions (`CURRENT_TIMESTAMP()`, `RANDOM()`) in repeated queries
- Same SQL text + same role + same warehouse = cache hit

## Warehouse Sizing and Spilling
- Queries that exceed warehouse memory spill to local SSD, then remote storage
- Check `BYTES_SPILLED_TO_LOCAL_STORAGE` and `BYTES_SPILLED_TO_REMOTE_STORAGE` in query profile
- Spilling to remote storage = significant slowdown; size up the warehouse
- Scale **up** for complex single queries; scale **out** (multi-cluster) for concurrency

## Key Optimizations
- **Predicate pushdown**: Filter early in CTEs/subqueries; Snowflake pushes predicates down to scan
- **Join order**: Put the smaller table on the right side of JOINs for better hash join performance
- **COPY grants**: Use `CLUSTER BY` on timestamp + high-cardinality dimension for time-series tables
- **Avoid SELECT ***: Forces scanning all columns across all micro-partitions; specify needed columns
- **Use LIMIT with ORDER BY**: Without LIMIT, Snowflake sorts the entire result set in memory
