# BigQuery Cost Model

## How Costs Work
BigQuery has two pricing models:
- **On-demand** — Charged per TB of data scanned by queries. Current rate: $6.25/TB (first 1 TB/month free). Only bytes in columns referenced by the query are counted.
- **Capacity (Editions)** — Purchase slot-hours (Standard, Enterprise, Enterprise Plus). Slots are units of compute; cost is fixed regardless of data scanned. Best for predictable, high-volume workloads.
- **Storage** — $0.02/GB/month for active storage, $0.01/GB/month for long-term (90+ days untouched). Applies to both models.

## Key Metrics
- `total_bytes_processed` — Data volume scanned; directly determines on-demand cost
- `total_slot_ms` — Compute time in slot-milliseconds; key metric for capacity pricing
- `estimated_cost` — Approximate dollar cost based on bytes processed
- `cache_hit` — Whether the query used cached results (zero cost if true)
- `bi_engine_statistics` — Indicates BI Engine acceleration usage

## Cost Estimation
On-demand: `cost = (total_bytes_processed / 1TB) * $6.25`
Capacity: `cost = (total_slot_hours * slot_price_per_hour)`

## Optimization Tips
- **Partition pruning** — Always filter on the partition column (`_PARTITIONTIME`, `date`, etc.) to avoid full-table scans. Partitioned tables can reduce scan volume by 100x+.
- **Clustering** — Cluster on frequently filtered columns (up to 4). BigQuery automatically re-clusters; no maintenance needed. Order columns by filter cardinality (low to high).
- **Avoid SELECT *** — BigQuery is columnar; selecting unused columns scans unnecessary data and increases cost proportionally.
- **Use LIMIT with previews only** — `LIMIT` does not reduce bytes scanned in BigQuery. Use the preview feature or `_PARTITIONTIME` filters instead.
- **Materialized views** — Automatic, incremental refresh. BigQuery rewrites queries to use them transparently.
- **BI Engine** — In-memory acceleration for sub-second dashboard queries.
- **Dry run** — Use `--dry_run` to estimate cost before executing.
