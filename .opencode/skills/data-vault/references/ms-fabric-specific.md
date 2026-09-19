# Microsoft Fabric-Specific Data Vault Patterns

Microsoft Fabric (GA 2023) hosts two DV-capable engines:

- **Fabric Warehouse** — T-SQL compute over OneLake-backed Delta
  Parquet. Full DML including MERGE. Best fit for classical
  DV 2.0 loading.
- **Fabric Lakehouse** — Spark-based, Delta Lake on OneLake, same
  semantics as Databricks Delta. Best fit for streaming + notebook
  workflows.

Both write to the same **OneLake** storage layer using Delta Parquet,
so downstream consumers see the same tables regardless of which
engine loaded them. Choose the engine per feed / per workload; mix
freely.

## Hash Storage — `VARBINARY(16)` (Warehouse) or `BINARY` (Lakehouse)

Fabric Warehouse:
```sql
HASHBYTES('MD5', <normalized_bk>)          AS customer_hk    -- VARBINARY(16)
```

Fabric Lakehouse (Spark SQL):
```sql
unhex(md5(<normalized_bk>))                 AS customer_hk    -- BINARY (16 bytes)
-- OR
md5(<normalized_bk>)                        AS customer_hk    -- STRING (32 hex chars)
```

**Match choices project-wide.** If Warehouse and Lakehouse both write
to the same vault tables, both must produce the *same bytes* for
the same normalized business key. Test explicitly:
```sql
-- Warehouse:
SELECT HASHBYTES('MD5', '^^') AS x;
-- Lakehouse (Spark):
SELECT unhex(md5('^^')) AS x;
-- Bytes must be identical.
```

MD5 output is standardized, so this holds as long as both sides
apply identical normalization. Diverging on TRIM / UPPER / delimiter
is the more common bug source.

**Do not use** `CHECKSUM()`, `BINARY_CHECKSUM()`, or `HASHBYTES('SHA1', ...)`
mixed with Lakehouse `sha1()` without checking equivalence — SQL
Server's SHA1 output is `VARBINARY(20)`; Spark's is also 20 bytes
but the encoding path may differ. Stick with MD5 for cross-engine
consistency.

## Column Types for a Fabric Warehouse Vault

```sql
CREATE TABLE dv_prod.raw_vault.hub_customer (
    customer_hk    VARBINARY(16)   NOT NULL,
    customer_bk    VARCHAR(255)    NOT NULL,
    load_dts       DATETIME2(6)    NOT NULL,
    record_source  VARCHAR(255)    NOT NULL,
    load_batch_id  VARCHAR(36)
);

-- Fabric Warehouse doesn't yet support explicit clustered indexes
-- like Synapse Dedicated Pool. Physical layout is managed by the engine.
```

Fabric Warehouse constraints (as of 2026):
- **No enforced PK / FK** — informational only.
- **No IDENTITY columns** — not applicable to DV anyway.
- **T-SQL surface** is broadly SQL Server-compatible but not 100%.
  Test all reference SQL before assuming.
- **DATETIME2(6)** for microsecond precision on `load_dts`.

## Column Types for a Fabric Lakehouse Vault

Same as Databricks Delta — see [databricks-specific.md](databricks-specific.md).
OneLake exposes the same Delta tables to Warehouse queries via
SQL Analytics Endpoint, so a Lakehouse-loaded table is queryable
from T-SQL.

## dbt-Fabric Config for Vault Tables

dbt has adapters for both:
- **`dbt-fabric`** — for Fabric Warehouse (T-SQL).
- **`dbt-fabricspark`** — for Fabric Lakehouse (Spark).

```yaml
# dbt_project.yml — Warehouse
models:
  my_project:
    +on_schema_change: fail
    raw_vault:
      +materialized: incremental
      +incremental_strategy: append          # Fabric Warehouse supports append + merge
```

MERGE is supported natively; use it for hubs and links with
insert-only-on-new semantics (WHEN NOT MATCHED THEN INSERT only,
same pattern as [bigquery-specific.md](bigquery-specific.md)).

## MERGE for Insert-Only-on-New (Fabric Warehouse)

```sql
MERGE dv_prod.raw_vault.hub_customer AS target
USING (
    SELECT DISTINCT
        HASHBYTES('MD5', UPPER(TRIM(CAST(customer_id AS VARCHAR(255)))))  AS customer_hk,
        customer_id                                                         AS customer_bk,
        SYSUTCDATETIME()                                                    AS load_dts,
        'crm.customers'                                                     AS record_source
    FROM dv_prod.staging.stg_crm__customers
    WHERE customer_id IS NOT NULL
) AS source
ON target.customer_hk = source.customer_hk
WHEN NOT MATCHED BY TARGET THEN
    INSERT (customer_hk, customer_bk, load_dts, record_source)
    VALUES (source.customer_hk, source.customer_bk, source.load_dts, source.record_source);
-- No WHEN MATCHED clause → insert-only
```

`SYSUTCDATETIME()` gives microsecond-precision UTC — use it, not
`GETDATE()` (which returns server-local time in older SQL Server
dialects; behavior in Fabric is standardized to UTC but explicit
is better).

## Direct Lake Mode for Power BI Marts

**Direct Lake** is Fabric's flagship BI mode: Power BI reads Delta
Parquet directly from OneLake without importing data or executing
DirectQuery. For DV 2.0 marts, this means:

- Build materialized dimensional marts as Delta tables in the mart
  schema.
- Point Power BI datasets at them via Direct Lake.
- Users see near-real-time freshness (whenever the mart is refreshed)
  with in-memory query performance.

This is the most compelling BI story for a DV on Fabric:
virtualization-tier freshness with materialized-tier performance.

Direct Lake constraints:
- Only works with Delta tables in OneLake.
- Falls back to DirectQuery for unsupported operations.
- Requires an F64+ capacity.

## Data Pipelines and Dataflows Gen2 for Ingestion

Fabric's ingestion surface:

- **Data Pipelines** (Azure Data Factory-derived) — orchestrated
  copy activities from ~100 connectors into Lakehouse or Warehouse
  staging.
- **Dataflows Gen2** — Power Query-based transformation, best for
  business-analyst-driven ingestion.
- **Notebooks** — Spark-based, best for complex transformations and
  Python/PyPI dependencies.
- **Eventstream** — real-time event ingestion (Event Hubs, Kafka)
  into Lakehouse.

**Recommended DV 2.0 ingestion architecture on Fabric:**
1. **Data Pipelines** copy source rows into Lakehouse landing zone.
2. **Notebooks or dbt-fabric** apply hard-rule transforms → staging.
3. **T-SQL / dbt-fabric** load staging → raw vault via MERGE.
4. **T-SQL** for PIT + business vault + mart layer.
5. **Direct Lake** exposes mart to Power BI.

## Eventstream + Real-Time for Streaming DV

For real-time feeds:

```
Event Hub / Kafka
      │
      ▼
Eventstream (Fabric)
      │
      ▼
Lakehouse table (Delta)
      │
      ▼
Notebook streaming job → raw vault
      │
      ▼
Direct Lake dataset → Power BI (near-real-time)
```

Eventstream provides the landing zone; a Structured Streaming
notebook (same pattern as [databricks-specific.md](databricks-specific.md))
consumes into vault tables.

## Cross-Engine Consistency

Because Warehouse and Lakehouse share OneLake storage:

- A hub loaded by Lakehouse notebooks is queryable from Warehouse
  T-SQL.
- Both engines must produce byte-identical hashes for the same
  business key (test explicitly, as noted above).
- Both must use the same convention for `load_dts` precision, NULL
  handling, casing.

Pick a **primary engine per table**:
- Hub `hub_customer` is written by *X*, read by any.
- Sat `sat_customer_details` is written by *X*, read by any.

Concurrent writes from both engines to the same table are supported
(Delta ACID) but complicate the mental model — prefer one writer
per table.

## Cost Model

Fabric uses **Capacity Units (CU)** — a shared pool across all
Fabric workloads in a workspace. DV 2.0 loads consume CU during
execution; keep an eye on:

- Warehouse query CU consumption via the Capacity Metrics App.
- Notebook Spark CU via the same app.
- Storage in OneLake (billed separately, cheap).

Auto-suspend / auto-resume applies at the capacity level, not per
warehouse — the whole capacity scales together.

## Common Fabric-Specific Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Using `CHECKSUM()` or `BINARY_CHECKSUM()` for hash keys | 32-bit; collisions | `HASHBYTES('MD5', x)` for cryptographic hash |
| Mixing Warehouse hash (`HASHBYTES('MD5', ...)`) with Lakehouse hash (`md5(...)`) without verifying bytes match | Cross-engine joins miss | Test explicitly at project setup |
| Assuming PK/FK enforcement | Duplicates slip through | Rely on anti-join + dbt tests |
| Using `GETDATE()` instead of `SYSUTCDATETIME()` | Timezone drift; ambiguous audit | Always UTC |
| Materialized views for PITs (not supported in Warehouse as of 2026) | Load fails | `table` materialization + scheduled rebuild |
| Direct Lake dataset over a Delta table with unsupported types (VARIANT, complex nested) | Silent DirectQuery fallback; slow | Keep mart tables to simple types |
| Two engines writing to the same vault table concurrently | Consistency headaches; race conditions on load_dts | One writer per table |
| Building marts as views over vault when Direct Lake is available | BI queries slow | Materialize mart Delta tables; Direct Lake reads them |
| Data Pipelines with per-row transforms | Slow, expensive | Use as pure copy; transform in notebook / T-SQL |
| No Capacity Metrics tracking | Vault load exhausts capacity; other workloads throttled | Monitor CU consumption; size accordingly |
| Assuming T-SQL 100% compatibility with SQL Server | Some patterns don't work (e.g., certain window-function forms) | Test against Fabric explicitly; don't port SQL Server code blindly |
| DATETIME instead of DATETIME2 for `load_dts` | Millisecond precision only; concurrent loads collide | `DATETIME2(6)` for microsecond precision |
