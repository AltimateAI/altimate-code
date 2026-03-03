# Databricks Cost Calculation

## Cost Structure
Databricks bills via DBUs (Databricks Units) — a normalized compute measure. Infrastructure (cloud VMs) is billed separately by AWS/Azure/GCP. Storage is cloud provider cost (S3/ADLS/GCS).

## How to Calculate Compute Cost

### Primary Data Source: `system.billing.usage`
System table available on Unity Catalog-enabled workspaces. Contains daily DBU consumption.

```sql
SELECT
  usage_date,
  workspace_id,
  sku_name,
  usage_unit,  -- 'DBU'
  SUM(usage_quantity) AS total_dbus,
  -- Multiply by your contracted $/DBU rate for cost
  billing_origin_product
FROM system.billing.usage
WHERE usage_date >= DATEADD(DAY, -30, CURRENT_DATE())
GROUP BY usage_date, workspace_id, sku_name, usage_unit, billing_origin_product
ORDER BY total_dbus DESC;
```

### Query-Level Cost: `system.query.history`
Available on Unity Catalog workspaces with system tables enabled.

```sql
SELECT
  statement_id,
  executed_by,
  warehouse_id,
  statement_text,
  total_duration_ms / 1000 AS duration_seconds,
  execution_status,
  rows_produced,
  -- I/O metrics
  read_bytes / POW(1024, 3) AS read_gb,
  written_bytes / POW(1024, 3) AS written_gb,
  spilled_local_bytes,
  spilled_remote_bytes,
  start_time
FROM system.query.history
WHERE start_time >= DATEADD(DAY, -30, CURRENT_TIMESTAMP())
ORDER BY total_duration_ms DESC;
```

### DBU Rates by Workload Type
Rates vary by cloud, region, and contract. Approximate list prices (USD):

| Workload Type | $/DBU (approx.) | Use Case |
|--------------|-----------------|----------|
| Jobs Compute | $0.15-0.25 | Scheduled ETL/ELT pipelines |
| SQL Serverless | $0.22-0.35 | Ad-hoc SQL, BI dashboards |
| SQL Classic (Pro) | $0.22 | Predictable SQL workloads |
| All-Purpose | $0.40-0.55 | Development, notebooks |
| Delta Live Tables | $0.20-0.36 | Streaming/batch pipelines |

Your actual rate: check `system.billing.list_prices` or your contract.

### Cluster-Level Cost: `system.compute.clusters`
```sql
SELECT
  cluster_id,
  cluster_name,
  cluster_source,  -- 'UI', 'JOB', 'API'
  driver_node_type,
  node_type_id,
  autoscale_min_workers,
  autoscale_max_workers,
  auto_termination_minutes,
  state
FROM system.compute.clusters;
```

## Key Cost Signals
- `spilled_remote_bytes > 0` — cluster needs more memory, size up or use photon
- `auto_termination_minutes > 30` or `NULL` — idle clusters burning DBUs
- `cluster_source = 'UI'` with high DBU — interactive clusters left running
- All-Purpose compute used for scheduled jobs — switch to Jobs Compute (2-3x cheaper)
- `read_bytes` very high — missing partition pruning or Z-ordering
