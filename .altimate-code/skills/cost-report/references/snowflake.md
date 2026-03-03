# Snowflake Cost Model

## How Costs Work
Snowflake charges for three categories:
- **Compute** — Credits consumed by virtual warehouses running queries. Billed per-second with a 60-second minimum.
- **Storage** — Monthly cost per TB stored (compressed). Includes active data, Time Travel, and Fail-safe.
- **Cloud Services** — Metadata operations, authentication, query optimization. Free up to 10% of daily compute; excess is billed.

## Key Metrics
- `credits_used` — Total compute credits consumed by a query (this is the primary cost signal)
- `bytes_scanned` — Data volume read from storage; correlates with cost for large scans
- `compilation_time` — Time spent in query optimization; high values suggest complex plans
- `queuing_time` — Time waiting for warehouse resources; indicates undersized warehouse
- `spillage` — Bytes spilled to local/remote disk; indicates warehouse needs sizing up

## Warehouse Sizing

| Size | Credits/Hour | Nodes | Best For |
|------|-------------|-------|----------|
| X-Small | 1 | 1 | Light queries, development |
| Small | 2 | 2 | Standard analytics |
| Medium | 4 | 4 | Medium ETL, BI workloads |
| Large | 8 | 8 | Heavy transformations |
| X-Large | 16 | 16 | Large data processing |
| 2XL–6XL | 32–256 | 32–256 | Massive workloads |

## Optimization Tips
- **Result cache** — Identical queries within 24 hours return cached results at zero compute cost. Avoid non-deterministic functions (e.g., `CURRENT_TIMESTAMP()`) in frequently-run queries.
- **Clustering** — Add cluster keys on high-cardinality filter columns to minimize partition scanning. Check `SYSTEM$CLUSTERING_INFORMATION` to verify effectiveness.
- **Auto-suspend** — Set warehouses to auto-suspend after 1-5 minutes of inactivity. Each idle minute costs credits.
- **Multi-cluster warehouses** — Scale out for concurrency, not up for query speed. Size up only when queries spill to disk.
- **Materialized views** — Pre-compute expensive aggregations for repeated dashboard queries.
