# Snowflake Query Optimization

## Micro-Partitions and Pruning
Snowflake stores data in immutable micro-partitions (~16 MB compressed). Queries scan only partitions matching filter predicates. Effective pruning can skip 90%+ of data.

**Check pruning efficiency**: Look at `PARTITIONS_SCANNED` vs `PARTITIONS_TOTAL` in the query profile. If the ratio is high (>50%), filters are not pruning effectively.

## Clustering Keys — Use With Caution
Clustering keys reorder micro-partitions to improve pruning on specific columns. **This is an advanced feature with real cost implications:**

- Clustering is **automatic background maintenance** that runs continuously and **consumes credits**
- For small-to-medium tables (under ~1 TB), **natural insertion order is almost always sufficient** — don't cluster
- Only consider clustering when you have evidence of poor pruning on a large, frequently-queried table:
  1. Run `SELECT SYSTEM$CLUSTERING_INFORMATION('table_name', '(column_name)')` to check overlap and depth
  2. `average_overlap > 2` or `average_depth > 2` indicates data is poorly organized for that column
  3. Only then consider `ALTER TABLE ... CLUSTER BY (col)`
- Best candidates: high-cardinality columns (timestamps, IDs) used in range filters on tables with billions of rows
- **Do not cluster** on low-cardinality columns, rarely-filtered columns, or tables with low query volume — the maintenance cost won't be justified
- Monitor clustering cost via `SNOWFLAKE.ACCOUNT_USAGE.AUTOMATIC_CLUSTERING_HISTORY`

## Warehouse Sizing and Spilling
- Queries that exceed warehouse memory spill to local SSD, then remote storage
- Check `BYTES_SPILLED_TO_LOCAL_STORAGE` and `BYTES_SPILLED_TO_REMOTE_STORAGE` in the query profile
- Spilling to remote storage = significant slowdown; size up the warehouse
- Scale **up** (larger warehouse size) for complex single queries; scale **out** (multi-cluster) for concurrency

## Key Optimizations
- **Predicate pushdown**: Filter early in CTEs/subqueries; Snowflake pushes predicates down to the scan operator
- **Avoid SELECT ***: Forces scanning all columns across all micro-partitions; specify only needed columns
- **Use LIMIT with ORDER BY**: Without LIMIT, Snowflake sorts the entire result set in memory
- **Functions on filter columns**: `WHERE UPPER(name) = 'FOO'` prevents partition pruning; restructure to avoid wrapping filtered columns in functions
- **Join pruning**: Filter the driving table before joining to reduce intermediate result sizes
