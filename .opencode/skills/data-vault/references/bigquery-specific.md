# BigQuery-Specific Data Vault Patterns

BigQuery's serverless, columnar architecture is a strong fit for
DV 2.0: `MERGE` is native and cheap, partitioning + clustering
give per-partition-scan cost control, and materialized views cover
some PIT use cases automatically.

The main constraints are BigQuery's per-partition-per-day insertion
limits, streaming buffer latency, and the fact that hashes are
either `BYTES` or `STRING` — with different cost implications.

## Hash Storage — `BYTES` (preferred) or `STRING`

BigQuery's `MD5()` returns `BYTES` (16 bytes). Prefer keeping it as
`BYTES` throughout the vault; convert to hex `STRING` only when a
downstream consumer requires it:

```sql
-- Preferred: native BYTES, half the storage vs. hex string
MD5(<normalized_bk>)                    AS customer_hk    -- BYTES

-- Only when hex display / interop is required:
TO_HEX(MD5(<normalized_bk>))            AS customer_hk_hex -- STRING (32 hex chars)
```

**Do not use `FARM_FINGERPRINT()`** — 64-bit signed int; collisions
possible at billion-row scale. Same for `HASH()` and generic
`CHECKSUM`-style functions.

## Column Types for a BigQuery Vault

```sql
CREATE TABLE `project.raw_vault.hub_customer` (
    customer_hk    BYTES         NOT NULL,
    customer_bk    STRING        NOT NULL,
    load_dts       TIMESTAMP     NOT NULL,
    record_source  STRING        NOT NULL,
    load_batch_id  STRING
)
PARTITION BY DATE(load_dts)
CLUSTER BY customer_hk
OPTIONS(
    partition_expiration_days = NULL,
    require_partition_filter  = FALSE
);
```

Rules:
- **Partition by `DATE(load_dts)`** for large tables. Marts filter
  on load date; partition pruning becomes free.
- **Cluster by `_hk`** (hubs, links) or `(parent_hk, load_dts)`
  (satellites). BigQuery re-clusters automatically as data lands.
- **`require_partition_filter = TRUE`** on satellites over 100 GB
  forces queries to specify a `load_dts` filter — prevents
  accidental full-table scans that dominate BigQuery bills.

## dbt-BigQuery Config for Vault Tables

```yaml
# dbt_project.yml
models:
  my_project:
    +on_schema_change: fail
    raw_vault:
      +materialized: incremental
      +incremental_strategy: insert_overwrite    # OR merge (see below)
      +partition_by:
        field: load_dts
        data_type: timestamp
        granularity: day
      hubs:
        +cluster_by: ['customer_hk']
      satellites:
        +cluster_by: ['customer_hk', 'load_dts']
    business_vault:
      +materialized: incremental
      +incremental_strategy: merge
    information_marts:
      +materialized: table
```

Choose incremental strategy:
- **`merge`** (default) — good for hubs and links; use with
  `unique_key` and a `WHEN NOT MATCHED THEN INSERT`-only clause.
  See below.
- **`insert_overwrite`** — good for satellites when partition is
  `load_dts` day; re-run today's partition idempotently.

## MERGE for Insert-Only-on-New

BigQuery's `MERGE` is expressive enough to implement insert-only-on-new:

```sql
MERGE `project.raw_vault.hub_customer` AS target
USING (
    SELECT DISTINCT
        MD5(UPPER(TRIM(CAST(customer_id AS STRING))))  AS customer_hk,
        customer_id                                    AS customer_bk,
        CURRENT_TIMESTAMP()                            AS load_dts,
        'crm.customers'                                AS record_source
    FROM `project.staging.stg_crm__customers`
    WHERE customer_id IS NOT NULL
) AS source
ON target.customer_hk = source.customer_hk
WHEN NOT MATCHED THEN
    INSERT (customer_hk, customer_bk, load_dts, record_source)
    VALUES (source.customer_hk, source.customer_bk, source.load_dts, source.record_source);
```

No `WHEN MATCHED` clause → existing rows are untouched. This is the
DV 2.0-correct pattern on BigQuery.

For **satellites**, MERGE is possible but more complex — the
"insert if hashdiff changed" needs a subquery for the latest row per
parent. Simpler to use the anti-join pattern with `MERGE`:

```sql
MERGE `project.raw_vault.sat_customer_details` AS target
USING (
    WITH incoming AS (
        SELECT customer_hk, load_dts, hashdiff, ...
        FROM `project.staging.stg_crm__customers__hashed`
    ),
    latest AS (
        SELECT customer_hk, hashdiff AS latest_hashdiff
        FROM `project.raw_vault.sat_customer_details`
        QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_hk ORDER BY load_dts DESC) = 1
    )
    SELECT i.*
    FROM incoming i
    LEFT JOIN latest l USING (customer_hk)
    WHERE l.customer_hk IS NULL OR l.latest_hashdiff != i.hashdiff
) AS source
ON FALSE                                        -- force NOT MATCHED for all rows
WHEN NOT MATCHED THEN INSERT ROW;
```

`ON FALSE` is the idiom for "always insert" — every source row
becomes a NOT MATCHED and inserts.

## Streaming Inserts for Real-Time

BigQuery's Streaming API (or Storage Write API for better dedup) is
the standard real-time ingestion path:

```python
from google.cloud import bigquery
client = bigquery.Client()
table_id = "project.staging.stg_crm__customers_stream"

rows_to_insert = [
    {"customer_id": "C-123", "email": "...", "source_event_time": "..."},
    ...
]
errors = client.insert_rows_json(table_id, rows_to_insert)
```

Considerations:
- **Streaming buffer latency**: rows are query-visible within ~90
  seconds. For strict-real-time consumers, use the Storage Write API
  with committed streams.
- **Per-table-per-day insertion limit** (100k rows/second/table by
  default) — request quota increase for high-volume feeds.
- **Cost**: streaming inserts are billed separately from storage.

Then a **scheduled query** (5-minute minimum) runs the vault load
from the streaming staging into the vault MERGE:

```sql
-- Schedule this every 5 minutes
MERGE `project.raw_vault.hub_customer` AS target
USING (SELECT ... FROM `project.staging.stg_crm__customers_stream`
       WHERE _PARTITIONTIME > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 10 MINUTE))
    AS source
ON target.customer_hk = source.customer_hk
WHEN NOT MATCHED THEN INSERT ROW;
```

Look-back window (`10 MINUTE`) accounts for streaming buffer
latency + safety margin.

## Materialized Views for PIT / Aggregations

BigQuery **materialized views** auto-refresh on source change; a
good fit for aggregation marts and some PIT use cases:

```sql
CREATE MATERIALIZED VIEW `project.info_marts.mv_customer_current`
    OPTIONS(refresh_interval_minutes = 5)
AS
SELECT
    h.customer_hk,
    h.customer_bk,
    ARRAY_AGG(s ORDER BY s.load_dts DESC LIMIT 1)[SAFE_OFFSET(0)] AS current_sat
FROM `project.raw_vault.hub_customer` h
LEFT JOIN `project.raw_vault.sat_customer_details` s USING (customer_hk)
GROUP BY h.customer_hk, h.customer_bk;
```

Restrictions to remember:
- No self-joins.
- No non-deterministic functions (`RAND()`, `CURRENT_TIMESTAMP()`).
- No window functions (before recent updates — check current docs).
- Limited to certain aggregation forms.

For full PIT construction with cross-satellite as-of joins,
regular `table` materialization + scheduled rebuild is more flexible.

## Authorized Views for Virtualized Marts

An **authorized view** grants query access to a view without granting
access to the underlying tables. Perfect for exposing a virtualized
mart on top of a vault without giving consumers the vault itself:

```sql
CREATE VIEW `project.info_marts.dim_customer`
    OPTIONS(description = 'Current customer dim, virtualized over vault')
AS
SELECT
    h.customer_hk        AS customer_key,
    h.customer_bk        AS customer_id,
    s.first_name,
    s.last_name,
    s.email
FROM `project.raw_vault.hub_customer` h
LEFT JOIN `project.raw_vault.sat_customer_details` s USING (customer_hk)
QUALIFY ROW_NUMBER() OVER (PARTITION BY h.customer_hk ORDER BY s.load_dts DESC) = 1
WHERE h.customer_bk != '^^';

-- Grant view access without underlying-table access
GRANT `roles/bigquery.dataViewer` ON VIEW `project.info_marts.dim_customer`
    TO 'group:analysts@example.com';
```

## Cost Model — Watch Full Scans

BigQuery bills per byte scanned (on-demand) or per slot-hour
(reservation). For DV 2.0:

- **Every unqualified vault scan is expensive.** A `SELECT *
  FROM sat_customer_details` on a billion-row satellite reads
  hundreds of GB.
- **Partition pruning is your primary defense.** Filter every mart
  query on `load_dts` (or use a PIT that pre-computed the pointers).
- **Cluster on `_hk`** — cluster-pruning on point lookups
  (`WHERE customer_hk = X`) reads only the relevant blocks.
- **Materialized views** are pre-scanned; consumers pay only the
  view's cost, not the underlying tables'.
- **Reserved slots** for predictable vault-load cost; on-demand for
  bursty ad-hoc mart queries.

## Data Transfer Service for CDC

BigQuery Data Transfer Service supports scheduled ingestion from
common sources (Google Ads, S3, Cloud Storage, Amazon Redshift, etc.).
For DV 2.0 sourcing:

- Transfer lands raw source in a `landing_zone` dataset.
- dbt (or scheduled queries) transforms landing → staging with hard
  rules.
- Staging → raw vault via `MERGE`.

Datastream (BigQuery's official CDC pipeline for Postgres / MySQL /
Oracle) writes CDC events directly to BigQuery, which then feed a
real-time vault loader.

## Common BigQuery-Specific Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Using `FARM_FINGERPRINT()` for hash keys | 64-bit; collisions at scale | `MD5(x)` returning BYTES |
| Storing hashes as hex STRING instead of BYTES | 2× storage, slower joins | `MD5(x)` (BYTES); `TO_HEX` only when display needed |
| `MERGE` with `WHEN MATCHED THEN UPDATE` on raw vault | Insert-only violated | `WHEN NOT MATCHED THEN INSERT` only |
| No partition filter on vault mart queries | Full-scan cost blows up | `require_partition_filter = TRUE` on large satellites |
| Missing cluster on `_hk` | Point lookups scan full partitions | `CLUSTER BY customer_hk` (or `(parent_hk, load_dts)` on sats) |
| Streaming inserts without dedup | At-least-once → duplicate hub rows | Storage Write API with commit; or dedup in MERGE |
| Scheduled query cadence < streaming buffer latency | Load misses newly-streamed rows | Cadence + look-back ≥ 90 seconds |
| Materialized view over data that requires window functions | View creation fails | Use `table` materialization + scheduled rebuild |
| Views over vault without authorized-view grants | Downstream needs full vault access | Authorized view; grant view only |
| `CURRENT_TIMESTAMP()` inline in MERGE per row instead of one value per run | Rows in one logical batch get different timestamps | Compute `load_dts` once in a subquery or scheduled-query variable |
| Not clustering on `partition_by` interaction | Cluster-pruning ineffective inside a large partition | Cluster on the point-lookup column (`_hk`), partition on the range column (`load_dts`) |
| Assuming DML costs are free | Small hub/link MERGEs can dominate bill | Batch MERGE inputs; avoid per-row loops |
