# Redshift-Specific Data Vault Patterns

Redshift can host Data Vault 2.0 — the book explicitly covers it —
but the platform's constraints (no binary hash storage, limited
MERGE, DIST/SORT-key tuning, VACUUM/ANALYZE cadence) require
deliberate choices. Redshift RA3 nodes with managed storage make
this easier than legacy DS2 nodes.

## Hash Storage — `VARCHAR(32)` Hex (only choice)

Redshift's `MD5()` returns `VARCHAR(32)` (hex). There is no binary
type equivalent to Snowflake's `BINARY(16)`. Live with it:

```sql
MD5(<normalized_bk>)                    AS customer_hk    -- VARCHAR(32)
```

Do not attempt `HEX(...)`-based binary tricks — they end up
`VARCHAR` anyway and complicate joins.

**Do not use `FNV_HASH()` or `CHECKSUM()`** — non-cryptographic;
collisions possible.

## Column Types for a Redshift Vault

```sql
CREATE TABLE raw_vault.hub_customer (
    customer_hk    VARCHAR(32)  NOT NULL ENCODE ZSTD,
    customer_bk    VARCHAR(255) NOT NULL ENCODE ZSTD,
    load_dts       TIMESTAMP    NOT NULL ENCODE AZ64,
    record_source  VARCHAR(255) NOT NULL ENCODE ZSTD,
    load_batch_id  VARCHAR(36)           ENCODE ZSTD,

    PRIMARY KEY (customer_hk)                          -- informational only in Redshift
)
DISTSTYLE KEY
DISTKEY (customer_hk)
COMPOUND SORTKEY (customer_hk);
```

Rules:
- **DISTKEY on `_hk`** for hubs and links — co-locates rows for
  join to satellites and other links.
- **SORTKEY on `_hk`** for hubs; **compound SORTKEY on
  `(parent_hk, load_dts)`** for satellites — enables zone-map
  pruning on both join key and time-range filters.
- **ZSTD encoding** on VARCHAR columns; **AZ64** on TIMESTAMP /
  numeric.
- **PK is informational only** — Redshift doesn't enforce it.
  Rely on the anti-join / dedup pattern to guarantee uniqueness.

## Satellite DISTKEY / SORTKEY

```sql
CREATE TABLE raw_vault.sat_customer_details (
    customer_hk    VARCHAR(32)  NOT NULL,
    load_dts       TIMESTAMP    NOT NULL,
    hashdiff       VARCHAR(32)  NOT NULL,
    record_source  VARCHAR(255) NOT NULL,
    first_name     VARCHAR(255),
    last_name      VARCHAR(255),
    email          VARCHAR(255),
    ...
)
DISTSTYLE KEY
DISTKEY (customer_hk)                                  -- co-locate with hub
COMPOUND SORTKEY (customer_hk, load_dts);              -- range-prune on time
```

**Interleaved sort keys** (`INTERLEAVED SORTKEY (customer_hk,
load_dts)`) may perform better for satellites with balanced query
patterns (as-of queries and per-customer queries roughly equal),
but require regular `VACUUM REINDEX` — more operational overhead.
Prefer compound for most cases.

## dbt-Redshift Config for Vault Tables

```yaml
# dbt_project.yml
models:
  my_project:
    +on_schema_change: fail
    raw_vault:
      +materialized: incremental
      +incremental_strategy: delete+insert          # append works too
      hubs:
        +dist: customer_hk
        +sort: [customer_hk]
      satellites:
        +dist: customer_hk
        +sort: [customer_hk, load_dts]
    business_vault:
      +materialized: incremental
      +incremental_strategy: delete+insert
    information_marts:
      +materialized: table
```

**Incremental strategy — `delete+insert` vs. `append`:**
- **`append`** — preferred for DV. Combined with an explicit
  anti-join in the model, this is byte-for-byte the insert-only
  pattern. Fastest.
- **`delete+insert`** — dbt-managed alternative; deletes matching
  `unique_key` rows before insert. For a hub / link this is
  functionally identical to append (nothing matches on `_hk` for
  new rows). For a satellite, it can be dangerous — the `unique_key`
  must be `(parent_hk, load_dts)`, not just `parent_hk`, or you'll
  wipe history.

Prefer `append` with a hand-rolled anti-join for the raw vault.

## No MERGE — Emulate with Anti-Join

Redshift does not support `MERGE`. Use the anti-join pattern in
[loading-patterns.md](loading-patterns.md):

```sql
-- Hub load — insert-only-on-new via anti-join
INSERT INTO raw_vault.hub_customer (customer_hk, customer_bk, load_dts, record_source)
SELECT DISTINCT
    MD5(UPPER(TRIM(customer_id))) AS customer_hk,
    customer_id                   AS customer_bk,
    GETDATE()                     AS load_dts,
    'crm.customers'               AS record_source
FROM staging.stg_crm__customers s
LEFT JOIN raw_vault.hub_customer t
    ON MD5(UPPER(TRIM(s.customer_id))) = t.customer_hk
WHERE s.customer_id IS NOT NULL
  AND t.customer_hk IS NULL;
```

The anti-join is Redshift's native way to enforce insert-only. dbt's
`incremental_strategy='append'` produces this pattern automatically
when the model includes the appropriate `is_incremental()` filter.

## Streaming Ingestion via Kinesis + Materialized Views

Redshift's streaming ingestion pattern (introduced 2022):

```sql
-- Create external schema pointing at Kinesis Data Streams
CREATE EXTERNAL SCHEMA IF NOT EXISTS kinesis
FROM KINESIS IAM_ROLE 'arn:aws:iam::...:role/redshift-kinesis';

-- Materialized view that auto-refreshes from the stream
CREATE MATERIALIZED VIEW raw_vault.stg_crm__customers_stream
AUTO REFRESH YES
AS
SELECT
    approximate_arrival_timestamp,
    JSON_PARSE(from_varbyte(kinesis_data, 'utf-8')) AS payload,
    partition_key, shard_id, sequence_number
FROM kinesis."crm-customers-stream";

-- Vault load runs on scheduled query, reading the MV
```

Faster than S3-based ingestion for near-real-time DV. Latency:
seconds after Kinesis publish.

## VACUUM and ANALYZE Cadence

Redshift's storage doesn't self-heal like Snowflake's or BigQuery's.
Vault tables need periodic maintenance:

- **`VACUUM DELETE ONLY`** — reclaims space from deleted rows.
  Raw vault inserts only, so this is rarely needed for the vault
  itself (unless you use `delete+insert`). Needed for effectivity
  sats with close events.
- **`VACUUM SORT ONLY`** — re-sorts rows into sort-key order.
  Needed after large batch inserts to keep zone-map pruning
  effective. Schedule weekly for large satellites.
- **`ANALYZE`** — updates statistics for the query planner. Run
  after every significant load; dbt's `on-run-end` is a good place.

```yaml
# dbt_project.yml
on-run-end:
  - "ANALYZE {{ target.schema }}.hub_customer"
  - "ANALYZE {{ target.schema }}.sat_customer_details"
  # ... or a macro that loops through all vault tables
```

Newer Redshift (RA3) supports **automatic table optimization (ATO)**
which handles sort-key and dist-key tuning automatically. Enable
it and skip much of this operational burden.

## Redshift Spectrum for Cold Satellite Partitions

For very large historical satellites, offload old data to S3 via
Spectrum:

1. Partition satellite by `load_dts` year.
2. Unload old partitions to S3 with `UNLOAD ... FORMAT PARQUET`.
3. Create external table over S3 partitions.
4. Union external + local via a view for downstream queries.

Cuts local storage cost dramatically for satellites where >2-year-old
data is queried rarely.

## Cluster Sizing

| Vault volume | Redshift cluster |
|--------------|------------------|
| < 1 TB compressed | 2× ra3.xlplus |
| 1–10 TB compressed | 4× ra3.xlplus / 2× ra3.4xlarge |
| 10–100 TB compressed | 4–8× ra3.4xlarge / ra3.16xlarge |
| 100 TB+ | ra3.16xlarge with concurrency scaling |

RA3 nodes decouple storage from compute; storage grows independently
of nodes. Prefer RA3 over legacy DS2 for any modern DV workload.

## No QUALIFY — Rewrite as CTE

Redshift does NOT support the `QUALIFY` clause. Every skill example
that reads:

```sql
SELECT ... FROM sat_x
QUALIFY ROW_NUMBER() OVER (PARTITION BY parent_hk ORDER BY load_dts DESC) = 1
```

must be rewritten for Redshift as:

```sql
WITH ranked AS (
    SELECT ..., ROW_NUMBER() OVER (PARTITION BY parent_hk ORDER BY load_dts DESC) AS rn
    FROM sat_x
)
SELECT ... FROM ranked WHERE rn = 1
```

Every satellite / PIT / mart pattern in the skill needs this
rewrite on Redshift. dbt macros can hide this via
`{{ dbt_utils.deduplicate() }}`.

## Common Redshift-Specific Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Using `FNV_HASH()` or `CHECKSUM()` for hash keys | Collisions | Always `MD5(x)` for cryptographic hashes |
| No DISTKEY on `_hk` | Every hub-satellite join broadcasts data | `DISTSTYLE KEY DISTKEY (customer_hk)` |
| Missing SORTKEY on satellites | No zone-map pruning; time-range scans slow | Compound `(parent_hk, load_dts)` |
| `delete+insert` incremental with `unique_key=parent_hk` on satellites | Wipes history on every load | Use `append` with anti-join; or `unique_key=[parent_hk, load_dts]` |
| No VACUUM SORT | Sort keys degrade after inserts; zone maps stale | Weekly `VACUUM SORT ONLY` on large tables; or RA3 auto-ATO |
| No ANALYZE after loads | Planner picks bad plans; slow mart queries | `on-run-end` ANALYZE after every dbt run |
| Assuming MERGE is available | Loader errors | Use anti-join pattern; MERGE not supported |
| Undersized VARCHAR (`VARCHAR(50)` for a business key that grows to 100 chars) | Truncation on load; hash drift | Size generously; VARCHAR storage is bounded by actual content in Redshift |
| No encoding | Storage 3-5× larger than necessary | `ZSTD` for VARCHAR; `AZ64` for numeric/timestamp |
| Cross-DB queries via federated queries | Doesn't respect vault's insert-only across engines | Land data in Redshift first via COPY/streaming, then apply DV |
| Legacy DS2 for new DV | Storage capped at node count; expensive scale-out | Migrate to RA3 |
| PK/FK declared but relied upon for enforcement | Duplicates slip through | Redshift doesn't enforce; use anti-join + dbt tests |
