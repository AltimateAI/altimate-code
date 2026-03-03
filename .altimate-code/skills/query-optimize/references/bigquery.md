# BigQuery Query Optimization

## Partitioning
Partitioned tables divide data by a column (typically date/timestamp). Queries filtering on the partition column scan only relevant partitions.

- **Time-unit partitioning**: `PARTITION BY DATE(created_at)` -- daily, hourly, monthly, or yearly
- **Integer-range partitioning**: For numeric columns with known ranges
- **Ingestion-time**: `_PARTITIONTIME` pseudo-column, automatic
- Always filter on the partition column in WHERE clauses

## Clustering
Clustering sorts data within partitions by up to 4 columns:
- Order columns by filter cardinality: low cardinality first (status), high cardinality last (id)
- BigQuery auto-re-clusters in the background; no manual maintenance
- Most effective on columns used in WHERE, JOIN, GROUP BY, ORDER BY
- Combine with partitioning: partition on date, cluster on frequently filtered dimensions

## Slot Management
- On-demand: automatic slot allocation, billed per TB scanned
- Capacity: fixed slot reservations, predictable cost
- Check `total_slot_ms` in INFORMATION_SCHEMA.JOBS to understand compute usage
- High slot contention = queries queue; consider slot reservations for critical workloads

## Materialized Views
- Auto-maintained; BigQuery rewrites queries to use them transparently
- Best for repeated aggregation queries (dashboards, rollups)
- Support incremental refresh -- only reprocess changed data

## Key Optimizations
- **Avoid SELECT ***: BigQuery is columnar; each column adds scan cost proportionally
- **Use approximate functions**: `APPROX_COUNT_DISTINCT` is much faster than `COUNT(DISTINCT x)` for large tables
- **Partition pruning**: Always filter on partition column; without it, full table scan occurs
- **LIMIT does not reduce cost**: BigQuery scans full data before applying LIMIT; use partition filters instead
- **Nested/repeated fields**: Prefer `UNNEST` over self-joins for arrays; avoid unnecessary flattening
- **BI Engine**: In-memory acceleration for sub-second BI queries; configure per-project reservations
