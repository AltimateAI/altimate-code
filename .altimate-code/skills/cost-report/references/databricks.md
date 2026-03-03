# Databricks Cost Model

## How Costs Work
Databricks charges via DBUs (Databricks Units) — a normalized measure of compute:
- **DBU rate** varies by workload type: Jobs Compute, SQL Warehouse, All-Purpose Compute, Serverless, each with different $/DBU rates.
- **Infrastructure cost** — Underlying cloud VMs billed separately by the cloud provider. Spot instances reduce this by 60-90%.
- **Storage** — Delta Lake tables on cloud object storage, billed by the cloud provider. No Databricks markup.

## Key Metrics
- `dbu_consumption` — Total DBUs consumed; multiply by $/DBU rate for cost
- `cluster_uptime_hours` — Duration clusters were running (including idle time)
- `spot_vs_on_demand_ratio` — Percentage of compute on spot instances
- `bytes_read` / `bytes_written` — I/O volume; high values suggest missing pruning
- `photon_enabled` — Whether Photon vectorized engine was active (faster but higher DBU rate)

## Cluster Types

| Type | DBU Rate | Best For |
|------|----------|----------|
| Jobs Compute | Lowest | Scheduled ETL/ELT pipelines |
| SQL Warehouse (Serverless) | Medium | Ad-hoc SQL analytics, BI |
| SQL Warehouse (Classic) | Medium | Predictable SQL workloads |
| All-Purpose Compute | Highest | Development, notebooks |

## Optimization Tips
- **Right-size clusters** — Use auto-scaling and auto-termination (5-10 min idle). Oversized fixed clusters are the top cost driver.
- **Jobs Compute for pipelines** — 2-3x cheaper per DBU than All-Purpose. Reserve All-Purpose for development only.
- **Spot instances** — Use spot for worker nodes (not driver). Fallback to on-demand for reliability.
- **Delta cache** — SSD caching of remote data. Speeds up repeated reads without re-scanning storage.
- **Z-ordering / Liquid clustering** — Z-order on filter columns for data skipping. Liquid clustering automates this.
- **Photon** — Vectorized engine, 2-8x faster for SQL. Higher DBU rate but net cheaper due to reduced runtime.
- **Serverless SQL Warehouses** — Auto-scale to zero, no idle cost. Best for bursty SQL workloads.
