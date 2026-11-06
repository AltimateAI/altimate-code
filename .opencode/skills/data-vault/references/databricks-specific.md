# Databricks-Specific Data Vault Patterns

Databricks / Delta Lake is a natural fit for DV 2.0: Delta's insert-only
`APPEND` mode maps directly onto the vault's insert-only rule; Delta
Live Tables (DLT) handle streaming loaders declaratively; Unity Catalog
gives lineage and permission surface for the vault + mart split.

This reference captures Databricks-native choices that produce
fastest, cheapest, correctest DV loads on the platform.

## Hash Storage — `STRING` (32 hex) or `BINARY` (16 bytes)

Databricks supports both. Choose one project-wide:

```sql
-- Option A: hex string (most common, readable)
md5(<normalized_bk>)                     AS customer_hk    -- STRING (32 hex chars)

-- Option B: binary (~2× faster joins, half the storage)
unhex(md5(<normalized_bk>))              AS customer_hk    -- BINARY (16 bytes)
```

**Prefer `unhex(md5(...))` for large vaults.** Delta stores binary
efficiently; joins on 16-byte binary are noticeably faster than on
32-char strings at Photon scale.

**Do not use `hash()`, `xxhash64()`, or `crc32()` for hash keys** —
they're 32/64-bit fingerprints, not cryptographic hashes. Collisions
possible at billion-row scale.

## Column Types for a Databricks Vault

```sql
CREATE TABLE hub_customer (
    customer_hk    STRING     NOT NULL,
    customer_bk    STRING     NOT NULL,
    load_dts       TIMESTAMP  NOT NULL,
    record_source  STRING     NOT NULL,
    load_batch_id  STRING
)
USING DELTA
PARTITIONED BY (DATE(load_dts))         -- only for very large hubs
TBLPROPERTIES (
    'delta.autoOptimize.optimizeWrite' = 'true',
    'delta.autoOptimize.autoCompact'   = 'true'
);

-- ZORDER for join performance on hash key
OPTIMIZE hub_customer ZORDER BY (customer_hk);
```

Notes:
- Delta uses schema evolution via `ALTER TABLE` and column mapping —
  add new columns to satellites safely, but plan hashdiff evolution
  as described in [hashing-and-keys.md](hashing-and-keys.md).
- Partition by `DATE(load_dts)` only when the table exceeds a few
  hundred million rows; small tables pay penalty for over-partitioning.
- ZORDER on `_hk` for hubs and links; ZORDER on `(parent_hk, load_dts)`
  for satellites.

## dbt-Databricks Config for Vault Tables

```yaml
# dbt_project.yml
models:
  my_project:
    +file_format: delta
    +on_schema_change: fail
    raw_vault:
      +materialized: incremental
      +incremental_strategy: append
      hubs:
        +liquid_clustering: ['customer_hk']       # dbt 1.7+ / Databricks liquid clustering
        # OR:
        # +cluster_by: ['customer_hk']            # traditional ZORDER via post-hook
      satellites:
        +liquid_clustering: ['customer_hk', 'load_dts']
    business_vault:
      +materialized: incremental
      +incremental_strategy: append
    information_marts:
      +materialized: table
```

**Liquid Clustering** (Databricks 13.3+) replaces manual `ZORDER`
runs — Delta clusters on the specified columns automatically as
data lands. Preferred for vault tables that receive continuous
appends.

## Delta Live Tables (DLT) for Streaming DV Loads

DLT provides declarative streaming with automatic dependency
management. Ideal fit for real-time hub / link loaders:

```python
# hub_customer_dlt.py
import dlt
from pyspark.sql import functions as F

@dlt.table(
    name="hub_customer",
    comment="Customer hub — insert-only, one row per business key",
    table_properties={"quality": "silver"}
)
def hub_customer():
    df = (
        dlt.read_stream("stg_crm__customers_streaming")
        .filter(F.col("customer_id").isNotNull())
        .withColumn(
            "customer_hk",
            F.md5(F.upper(F.trim(F.col("customer_id").cast("string"))))
        )
        .withColumn("customer_bk", F.col("customer_id"))
        .withColumn("load_dts", F.current_timestamp())
        .withColumn("record_source", F.lit("crm.customers"))
        .select("customer_hk", "customer_bk", "load_dts", "record_source")
        .dropDuplicates(["customer_hk"])
    )
    return df

# Apply MERGE INTO semantics: insert only new hash keys
@dlt.table(name="hub_customer_final")
@dlt.expect_or_drop("valid_hash", "customer_hk IS NOT NULL")
def hub_customer_final():
    ...
```

**DLT + AutoLoader** for CDC:
```python
@dlt.table
def stg_crm__customers_streaming():
    return (
        spark.readStream
        .format("cloudFiles")
        .option("cloudFiles.format", "json")
        .load("s3://landing-bucket/crm/customers/")
    )
```

The book's `APPLY CHANGES INTO` pattern in DLT handles CDC directly
against Delta, honoring insert-only for the target table.

## `MERGE INTO` for Hub / Link Idempotency

Databricks supports `MERGE` and it's the natural way to enforce
insert-only-on-new:

```sql
MERGE INTO hub_customer AS target
USING (
    SELECT DISTINCT
        md5(upper(trim(cast(customer_id AS STRING))))  AS customer_hk,
        customer_id                                    AS customer_bk,
        current_timestamp()                            AS load_dts,
        'crm.customers'                                AS record_source
    FROM stg_crm__customers
    WHERE customer_id IS NOT NULL
) AS source
ON target.customer_hk = source.customer_hk
WHEN NOT MATCHED THEN INSERT *;
-- No WHEN MATCHED clause → existing hubs are never updated
```

**Insert-only-by-omission.** No `WHEN MATCHED` clause means matched
rows are ignored. This is the correct semantic for a hub or link
load on Databricks.

For satellites, MERGE is trickier because the "insert if hashdiff
changed" condition requires comparing against the latest row per
parent. Use the anti-join pattern from
[loading-patterns.md](loading-patterns.md) with
`incremental_strategy='append'`:

```sql
{{ config(
    materialized='incremental',
    incremental_strategy='append',
    file_format='delta',
    unique_key=['customer_hk', 'load_dts']
) }}
```

## Structured Streaming for Ad-Hoc Real-Time

If not using DLT, plain Structured Streaming works:

```python
(spark.readStream
    .table("stg_crm__customers_streaming")
    .filter("customer_id IS NOT NULL")
    .selectExpr(
        "md5(upper(trim(cast(customer_id AS STRING)))) AS customer_hk",
        "customer_id AS customer_bk",
        "current_timestamp() AS load_dts",
        "'crm.customers' AS record_source"
    )
    .dropDuplicates(["customer_hk"])
    .writeStream
    .format("delta")
    .outputMode("append")
    .option("checkpointLocation", "s3://checkpoints/hub_customer/")
    .trigger(processingTime="1 minute")
    .toTable("hub_customer")
)
```

`outputMode("append")` matches DV 2.0's insert-only rule.
`dropDuplicates` handles at-least-once semantics from the source
stream. Use a durable `checkpointLocation` per loader.

## Unity Catalog for Vault + Mart Separation

Unity Catalog gives three-level namespace + granular permissions:

```sql
-- Catalogs / schemas for the DV layering
CREATE CATALOG IF NOT EXISTS dv_prod;
CREATE SCHEMA dv_prod.staging;
CREATE SCHEMA dv_prod.raw_vault;
CREATE SCHEMA dv_prod.business_vault;
CREATE SCHEMA dv_prod.info_marts;
CREATE SCHEMA dv_prod.metrics_vault;
CREATE SCHEMA dv_prod.error_mart;

-- Grant separately per layer
GRANT SELECT ON SCHEMA dv_prod.info_marts     TO `analysts`;
GRANT SELECT ON SCHEMA dv_prod.metrics_vault  TO `ops-team`;
GRANT SELECT ON SCHEMA dv_prod.raw_vault      TO `data-engineers`;
```

Unity Catalog's **lineage view** auto-captures column-level flows
between all these — vault → mart lineage is queryable without any
custom setup, which supports audits.

## Photon Considerations

Photon accelerates most DV operations transparently, but:
- **`md5()`** is Photon-native.
- **`unhex()`** and binary joins are Photon-native.
- **Very wide LISTAGG-style aggregations** (multi-active satellite
  hashdiff) may fall out of Photon; check the query plan and prefer
  `collect_list` + `sort_array` + `concat_ws` when necessary.

## Cluster Sizing for Vault Loads

| Vault volume | Cluster type | Nodes |
|--------------|--------------|-------|
| < 100M rows total | Single-node (D-series) | 1 |
| 100M – 1B rows | Autoscaling job cluster | 2–8 |
| 1B – 10B rows | Autoscaling job cluster with Photon | 4–16 |
| 10B+ rows | Photon + dedicated large cluster | 8–32 |

Use **job clusters** (not all-purpose) for scheduled vault loads —
cheaper, cleaner isolation. All-purpose clusters for interactive
development against the mart.

## Time Travel for Vault Recovery

Delta's Time Travel gives you point-in-time recovery for accidental
corruption:

```sql
-- What did the hub look like yesterday?
SELECT * FROM hub_customer VERSION AS OF 42;
SELECT * FROM hub_customer TIMESTAMP AS OF '2024-06-15 00:00:00';

-- Restore
RESTORE TABLE hub_customer TO VERSION AS OF 42;
```

Set `delta.deletedFileRetentionDuration = 'interval 30 days'` on
raw vault tables so accidental issues remain recoverable.

## Common Databricks-Specific Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Using `hash()` or `xxhash64()` for hash keys | 32/64-bit fingerprints; collisions at scale | `md5(x)` or `unhex(md5(x))` for cryptographic hashes |
| MERGE with `WHEN MATCHED THEN UPDATE` on raw vault | Updates existing rows; violates insert-only | Omit `WHEN MATCHED` entirely; only `WHEN NOT MATCHED THEN INSERT` |
| Storing hashes as `STRING` when project needs joins at billion-row scale | Slower joins, larger storage | `unhex(md5(x))` → `BINARY` |
| Missing `checkpointLocation` on Structured Streaming | Re-runs re-process from scratch or lose state | Durable, per-loader checkpoint path |
| Over-partitioning small tables | Many tiny files; performance degrades | Partition only when > 100M rows; ZORDER / liquid clustering for smaller |
| `outputMode("update")` on streaming vault loader | Non-insert-only behavior | Always `outputMode("append")` for vault tables |
| Not `OPTIMIZE`-ing large satellites | File count grows, queries slow | Nightly `OPTIMIZE ... ZORDER BY (parent_hk, load_dts)`, or Liquid Clustering |
| `spark.sql("MERGE ...")` from a driver-side loop | Serial MERGE per key; extremely slow | One MERGE per batch, not per row |
| All-purpose cluster for scheduled loads | Cost overhead; noisy neighbors | Job cluster per load |
| Missing `dropDuplicates` in streaming loaders | At-least-once → duplicate hub rows | `dropDuplicates([hash_key])` before write |
| `delta.deletedFileRetentionDuration` too short | Time Travel window closes; accidental corruption unrecoverable | 30 days or longer for raw vault |
