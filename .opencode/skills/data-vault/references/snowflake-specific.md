# Snowflake-Specific Data Vault Patterns

Snowflake is the most common warehouse for DV 2.0 in 2024–2026. Its
feature set (binary types, clustering, streams+tasks, dynamic tables)
maps cleanly onto vault load patterns. This file captures the
Snowflake-native choices that produce fastest, cheapest, correctest
DV loads.

## Hash Storage — `BINARY(16)`, Not `VARCHAR(32)`

Snowflake stores MD5 as either 32-hex `VARCHAR` or 16-byte `BINARY`.
Prefer binary everywhere:

```sql
-- Right — half the storage, ~2× faster joins
MD5_BINARY(<normalized_bk>) AS customer_hk

-- Wrong — hex form; only use when you must expose a hash to a system that can't read binary
MD5(<normalized_bk>)        AS customer_hk_hex
```

Downstream consumers who need hex can convert on demand:
`TO_VARCHAR(customer_hk, 'HEX')`.

## Column Types for a Snowflake Vault

```sql
-- Hub schema
CREATE OR REPLACE TABLE hub_customer (
    customer_hk    BINARY(16)   NOT NULL,
    customer_bk    VARCHAR      NOT NULL,
    load_dts       TIMESTAMP_NTZ(6) NOT NULL,   -- microsecond precision
    record_source  VARCHAR      NOT NULL,
    CONSTRAINT pk_hub_customer PRIMARY KEY (customer_hk)
)
CLUSTER BY (customer_hk);

-- Satellite schema
CREATE OR REPLACE TABLE sat_customer_details (
    customer_hk    BINARY(16)   NOT NULL,
    load_dts       TIMESTAMP_NTZ(6) NOT NULL,
    hashdiff       BINARY(16)   NOT NULL,
    record_source  VARCHAR      NOT NULL,
    first_name     VARCHAR,
    last_name      VARCHAR,
    email          VARCHAR,
    -- ...
    CONSTRAINT pk_sat_customer_details PRIMARY KEY (customer_hk, load_dts)
)
CLUSTER BY (customer_hk, load_dts);
```

**Snowflake's `PRIMARY KEY` and `NOT NULL` constraints are informational
only** — they aren't enforced. Use dbt tests to actually validate.
The declaration still helps the query optimizer and downstream BI tools.

## Clustering Keys

Cluster by the join column you use most:

| Table type | Cluster key | Reason |
|-----------|-------------|--------|
| Hub | `(<entity>_hk)` | Every satellite join and every link join filters/joins on the hash |
| Link | `(<lnk>_hk)` or the most-used hub `_hk` | Depends on read pattern; profile with `SYSTEM$CLUSTERING_INFORMATION` |
| Satellite | `(<parent>_hk, load_dts)` | PIT-driven joins land on this composite; also helps `MAX(load_dts)` scans |
| Effectivity satellite | `(<lnk>_hk, effective_from)` | Effectivity queries filter by date range |
| PIT | `(snapshot_dts, <parent>_hk)` | Marts filter `WHERE snapshot_dts = 'x'` first |
| Bridge | `(snapshot_dts, <primary hub>_hk)` | Same |

For small tables (< 1M rows), clustering is unnecessary — Snowflake's
micro-partition metadata already handles the pruning.

## dbt Snowflake Config for Vault Tables

```yaml
# dbt_project.yml
models:
  my_project:
    raw_vault:
      +materialized: incremental
      +incremental_strategy: append           # never merge on raw vault
      +on_schema_change: fail
      +transient: false                        # need Time Travel on vault tables
      +file_format: default                    # not applicable to Snowflake, but for adapter compat
      hubs:
        +cluster_by: ['<entity>_hk']
      satellites:
        +cluster_by: ['<parent>_hk', 'load_dts']
    business_vault:
      +materialized: incremental
      +incremental_strategy: append
      +on_schema_change: fail
    information_marts:
      +materialized: table                    # rebuild-friendly
```

**`transient: false`** matters — Snowflake's default for dbt-managed
tables can be transient (no Time Travel), which trades safety for cost.
Raw vault should have Time Travel enabled so accidental corruption is
recoverable.

## Streams + Tasks for Real-Time Vault Loads

For continuous or near-real-time vault loading, Snowflake **streams**
consume change data from source tables, and **tasks** run vault loads
when new data appears.

```sql
-- 1. Create a stream on the source table
CREATE OR REPLACE STREAM stream_crm__customers
ON TABLE crm.customers
APPEND_ONLY = FALSE                     -- capture updates and deletes too
SHOW_INITIAL_ROWS = TRUE;

-- 2. Task that runs the vault load when the stream has data
CREATE OR REPLACE TASK task_load_hub_customer
    WAREHOUSE = wh_dv_load
    SCHEDULE = '5 MINUTE'
    WHEN SYSTEM$STREAM_HAS_DATA('stream_crm__customers')
AS
    INSERT INTO hub_customer (customer_hk, customer_bk, load_dts, record_source)
    SELECT
        MD5_BINARY(COALESCE(NULLIF(UPPER(TRIM(CAST(customer_id AS VARCHAR))), ''), '^^')) AS customer_hk,
        customer_id AS customer_bk,
        CURRENT_TIMESTAMP() AS load_dts,
        'crm.customers' AS record_source
    FROM stream_crm__customers
    WHERE METADATA$ACTION = 'INSERT'    -- only new source rows
      AND customer_id IS NOT NULL
    QUALIFY ROW_NUMBER() OVER (PARTITION BY MD5_BINARY(...) ORDER BY 1) = 1;
```

**Considerations:**
- **Idempotency** still matters — the stream consumer is one-shot per
  task run, so re-runs need the anti-join filter.
- **`APPEND_ONLY = FALSE`** captures updates and deletes. If you want
  raw-vault insert-only-from-inserts and separate handling for
  updates/deletes, filter on `METADATA$ACTION`.
- **Cost trade-off**: warehouse is billed while the task runs.
  5-minute cadence + 1-second task = ~$0.30/day on X-Small; going
  smaller than 1 minute rarely helps.

## Dynamic Tables — Emerging Alternative

Snowflake **dynamic tables** (GA 2024) let you declare a target
lag and Snowflake refreshes the table incrementally to meet it. For
vault loads, dynamic tables can replace tasks + incremental dbt models
for near-real-time cases.

```sql
CREATE OR REPLACE DYNAMIC TABLE hub_customer
    TARGET_LAG = '5 minutes'
    WAREHOUSE = wh_dv_load
    REFRESH_MODE = INCREMENTAL
    INITIALIZE = ON_CREATE
AS
    WITH source_unioned AS (
        SELECT customer_id, CURRENT_TIMESTAMP() AS load_dts, 'crm.customers' AS record_source
        FROM crm.customers
        WHERE customer_id IS NOT NULL
        UNION ALL
        SELECT cust_no, CURRENT_TIMESTAMP(), 'erp.customer_master'
        FROM erp.customer_master
        WHERE cust_no IS NOT NULL
    ),
    hashed AS (
        SELECT
            MD5_BINARY(COALESCE(NULLIF(UPPER(TRIM(CAST(customer_id AS VARCHAR))), ''), '^^')) AS customer_hk,
            customer_id AS customer_bk,
            load_dts,
            record_source
        FROM source_unioned
    )
    SELECT customer_hk, ANY_VALUE(customer_bk) AS customer_bk,
           MIN(load_dts) AS load_dts, MIN(record_source) AS record_source
    FROM hashed
    GROUP BY customer_hk;
```

**Trade-offs vs. dbt incremental:**
- (+) No dbt scheduler needed; Snowflake handles the refresh.
- (+) Truly incremental — Snowflake tracks changed source rows.
- (–) Not all vault patterns fit dynamic-table semantics
  (effectivity satellites with two-pass logic are painful).
- (–) `CURRENT_TIMESTAMP()` in the definition means every refresh
  gets a *different* load_dts for the same key. That's usually fine
  for hubs (first-seen wins on `MIN`) but breaks satellite hashdiff
  detection.

**Use dynamic tables** for hubs and standard links. **Prefer dbt
incremental** for satellites and anything with hashdiff comparison
that requires deterministic `load_dts`.

## Warehouse Sizing for Vault Loads

Vault loads are typically hash-join heavy — the anti-join against
the target table dominates. Sizing:

| Vault volume | Warehouse size |
|--------------|---------------|
| < 10M rows total | XS (1 credit/hr) |
| 10M – 500M rows | S – M |
| 500M – 5B rows | L |
| 5B+ rows | XL or multi-cluster L |

Use separate warehouses for **loading** and **querying** so BI
users don't queue behind vault loads. Suspend automatically after
60 seconds.

```sql
CREATE WAREHOUSE wh_dv_load
    WAREHOUSE_SIZE = 'MEDIUM'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE
    INITIALLY_SUSPENDED = TRUE;
```

## Snowflake Hash Function Notes

- `MD5(x)` returns `VARCHAR(32)` hex.
- `MD5_BINARY(x)` returns `BINARY(16)`.
- `SHA1(x)` returns `VARCHAR(40)` hex.
- `SHA1_BINARY(x)` returns `BINARY(20)`.
- `SHA2(x, 256)` returns `VARCHAR(64)` hex.
- `SHA2_BINARY(x, 256)` returns `BINARY(32)`.

**Do not use `HASH(x)`** — it's a 64-bit integer with no cryptographic
guarantees. Collisions are possible at billion-row scale.

MD5 is fine for DV — collision probability at 1 trillion keys is
~10⁻²⁴. If your compliance requires SHA-1 or SHA-256, pick that
project-wide and stick with it.

## Case-Sensitivity Trap

Snowflake identifiers are **case-insensitive unless quoted**. This
is the source of the "same source, different hash" bug when raw
tables and staging models disagree on column casing.

Pick **UPPER-case unquoted identifiers everywhere** for vault columns
(`CUSTOMER_HK`, `LOAD_DTS`) — Snowflake convention, and it removes
quoting from downstream queries. Enforce via lint / review.

```sql
-- Convention: all-uppercase, unquoted
CREATE TABLE HUB_CUSTOMER (
    CUSTOMER_HK BINARY(16),
    ...
);

-- Not the convention:
CREATE TABLE "hub_customer" ("customer_hk" BINARY(16), ...);
```

Configure dbt to preserve case:
```yaml
# dbt_project.yml
quoting:
  database: false
  schema: false
  identifier: false
```

## Time Travel + Fail-Safe for Vault Recovery

Snowflake keeps 24 hours (Standard) or up to 90 days (Enterprise) of
Time Travel history on non-transient tables. Use it to recover from
accidental corruption:

```sql
-- What did hub_customer look like an hour ago?
SELECT * FROM hub_customer AT (OFFSET => -3600);

-- Restore hub_customer to how it was an hour ago (destructive!)
CREATE OR REPLACE TABLE hub_customer AS
SELECT * FROM hub_customer AT (OFFSET => -3600);

-- Or clone to a scratch table for inspection first
CREATE TABLE hub_customer_recovery CLONE hub_customer AT (OFFSET => -3600);
```

Set `DATA_RETENTION_TIME_IN_DAYS = 90` on vault schemas if the
Enterprise edition supports it. Fail-Safe (7 additional days) is
disaster-only, not user-queryable.

## Zero-Copy Cloning for Dev / Test

Snowflake zero-copy clone lets you branch a vault instantly for
testing:

```sql
-- Clone production vault into dev schema, no data movement
CREATE SCHEMA dv_dev CLONE dv_prod;

-- Test destructive changes freely, drop when done
DROP SCHEMA dv_dev;
```

This is the correct way to try schema changes on a vault. Never
develop directly against prod-connected sources.

## Common Snowflake-Specific Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Using `HASH()` instead of `MD5_BINARY()` | 64-bit hash → collisions at scale | Always `MD5_BINARY` or `SHA1_BINARY` |
| Using `VARCHAR(32)` instead of `BINARY(16)` for hash keys | 2× storage, ~2× slower joins | `BINARY(16)` |
| `transient=true` on raw vault tables | No Time Travel; accidental corruption unrecoverable | `transient=false` for vault |
| Not clustering large satellites | PIT queries do full scan | Cluster by `(parent_hk, load_dts)` |
| Dynamic table with `CURRENT_TIMESTAMP()` in satellite | Every refresh emits fresh `load_dts` → new hashdiff row for unchanged data | Use dbt incremental for satellites |
| Case-insensitive collisions (`customer_ID` vs `CUSTOMER_ID`) | dbt refs break intermittently based on adapter behavior | Uppercase everything unquoted; disable quoting in dbt config |
| Merging load + query workload on one warehouse | BI users queue behind vault loads | Separate warehouses; auto-suspend after 60s |
| Loading with a too-large warehouse | Pays for idle CPU; auto-suspend closes it before amortizing spin-up | Right-size (see table); use multi-cluster for parallel loads instead |
| Cross-region unload for backup | Egress cost | Use zero-copy clone within region; only cross-region for DR |
