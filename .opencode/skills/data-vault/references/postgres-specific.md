# PostgreSQL-Specific Data Vault Patterns

PostgreSQL is a viable DV 2.0 host for small-to-medium projects
(up to ~1B satellite rows on a well-tuned instance). Beyond that,
Postgres's row-store, single-node compute becomes a bottleneck —
prefer Snowflake / BigQuery / Databricks for large-scale DV.

Where Postgres shines for DV: dev environments, embedded warehouses,
small-domain vaults (< 100M rows), edge deployments, and as a
staging engine before promoting to a cloud warehouse.

## Hash Storage — `TEXT` (hex) or `BYTEA` (binary)

Postgres's `md5()` returns hex `TEXT` (32 chars). For binary
(halves storage, ~2× faster joins):

```sql
-- Hex TEXT (default, human-readable)
md5(<normalized_bk>)                    AS customer_hk       -- TEXT (32 hex chars)

-- Binary BYTEA (preferred for larger vaults)
decode(md5(<normalized_bk>), 'hex')     AS customer_hk       -- BYTEA (16 bytes)
```

**Do not use `hashtext()`** — 32-bit; collisions at scale.

Use `pgcrypto` for `sha256()` etc. if compliance requires:
```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SELECT digest(<normalized_bk>, 'sha256') AS customer_hk;    -- BYTEA (32 bytes)
```

## Column Types for a Postgres Vault

```sql
CREATE TABLE raw_vault.hub_customer (
    customer_hk    BYTEA         NOT NULL,
    customer_bk    TEXT          NOT NULL,
    load_dts       TIMESTAMPTZ   NOT NULL,
    record_source  TEXT          NOT NULL,
    load_batch_id  UUID,

    PRIMARY KEY (customer_hk)
);

-- Btree on the primary key is automatic.
-- If joins on business_key are also common:
CREATE INDEX idx_hub_customer_bk ON raw_vault.hub_customer (customer_bk);
```

Rules:
- **`TIMESTAMPTZ`** with microsecond precision — timezone-aware,
  avoids the DST ambiguity that bites `TIMESTAMP` (no TZ).
- **PK is enforced** — unlike Snowflake / Redshift / Fabric.
  Useful safety belt against duplicate hub rows.
- **BYTEA for hash storage** in production; `TEXT` is fine for
  dev / small deployments.

## Table Partitioning for Large Satellites

For satellites > 100M rows, native table partitioning:

```sql
CREATE TABLE raw_vault.sat_customer_details (
    customer_hk    BYTEA         NOT NULL,
    load_dts       TIMESTAMPTZ   NOT NULL,
    hashdiff       BYTEA         NOT NULL,
    record_source  TEXT          NOT NULL,
    first_name     TEXT,
    last_name      TEXT,
    email          TEXT,
    ...
    PRIMARY KEY (customer_hk, load_dts)
)
PARTITION BY RANGE (load_dts);

-- Monthly partitions
CREATE TABLE raw_vault.sat_customer_details_2024_01
    PARTITION OF raw_vault.sat_customer_details
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

CREATE TABLE raw_vault.sat_customer_details_2024_02
    PARTITION OF raw_vault.sat_customer_details
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');

-- Automate partition creation via pg_partman or manual DDL
```

Benefits:
- Constraint exclusion — mart queries filtering `load_dts` scan
  only relevant partitions.
- Old partitions can be detached and archived to cheaper storage.
- VACUUM operates per-partition; less lock contention.

## Indexes for Vault Queries

```sql
-- Hub: PK on _hk is enough for most queries.
-- Satellite: PK on (parent_hk, load_dts) covers the most common access:
--   - Latest row per parent: index scan
--   - As-of query: index range scan on (parent_hk, load_dts <= X)
-- Link: PK on _hk, plus additional indexes if the mart traverses
--   through specific hubs frequently:
CREATE INDEX idx_lnk_order_customer_customer_hk
    ON raw_vault.lnk_order_customer (customer_hk);
CREATE INDEX idx_lnk_order_customer_order_hk
    ON raw_vault.lnk_order_customer (order_hk);
```

**Hash indexes** on `_hk` don't help — Postgres's btree is
already effective on equality-heavy lookups, and hash indexes
have historically been less mature. Use btree.

## dbt-Postgres Config for Vault Tables

```yaml
# dbt_project.yml
models:
  my_project:
    +on_schema_change: fail
    raw_vault:
      +materialized: incremental
      +incremental_strategy: append
      hubs:
        +indexes:
          - columns: ['customer_hk']
            unique: true
      satellites:
        +indexes:
          - columns: ['customer_hk', 'load_dts']
            unique: true
    business_vault:
      +materialized: incremental
      +incremental_strategy: append
    information_marts:
      +materialized: table
```

## Insert-Only via `INSERT ... ON CONFLICT DO NOTHING`

Postgres's `ON CONFLICT DO NOTHING` gives insert-only-on-new
semantics directly, without a separate anti-join:

```sql
INSERT INTO raw_vault.hub_customer (customer_hk, customer_bk, load_dts, record_source)
SELECT DISTINCT
    decode(md5(upper(trim(customer_id::TEXT))), 'hex')  AS customer_hk,
    customer_id                                          AS customer_bk,
    NOW()                                                AS load_dts,
    'crm.customers'                                      AS record_source
FROM staging.stg_crm__customers
WHERE customer_id IS NOT NULL
ON CONFLICT (customer_hk) DO NOTHING;
```

Requires the PK to be declared (which Postgres actually enforces).
Cleaner than the anti-join pattern for Postgres, though functionally
equivalent.

For satellites, use the anti-join pattern from
[loading-patterns.md](loading-patterns.md) — `ON CONFLICT` on
`(parent_hk, load_dts)` alone won't detect hashdiff-based changes.

## Streaming Sources — Logical Replication

Postgres's **logical replication** is the standard CDC surface —
publish changes from an operational Postgres to a warehouse
Postgres for DV ingestion:

```sql
-- On source
CREATE PUBLICATION dv_source FOR TABLE crm.customers, crm.orders;

-- On target (DV warehouse)
CREATE SUBSCRIPTION dv_ingest
    CONNECTION 'host=source-db.internal dbname=crm ...'
    PUBLICATION dv_source
    WITH (copy_data = true, create_slot = true);
```

CDC events land in a staging table; a scheduled job (cron / pg_cron
/ Airflow) applies the DV load pattern.

For richer CDC (row-level events with before/after), use **Debezium**
against Postgres → Kafka → DV loader.

## `MERGE` in Postgres 15+

Postgres 15+ supports `MERGE`. Use insert-only-on-new form:

```sql
MERGE INTO raw_vault.hub_customer AS target
USING (
    SELECT DISTINCT
        decode(md5(upper(trim(customer_id::TEXT))), 'hex')  AS customer_hk,
        customer_id                                          AS customer_bk,
        NOW()                                                AS load_dts,
        'crm.customers'                                      AS record_source
    FROM staging.stg_crm__customers
    WHERE customer_id IS NOT NULL
) AS source
ON target.customer_hk = source.customer_hk
WHEN NOT MATCHED THEN
    INSERT VALUES (source.customer_hk, source.customer_bk, source.load_dts, source.record_source);
```

Functionally equivalent to `INSERT ... ON CONFLICT` for a hub. Pick
whichever your team prefers; both are correct.

## VACUUM and Autovacuum

Postgres MVCC accumulates row versions with every insert (dead tuples
from prior transactions). Autovacuum handles most cleanup, but:

- **Tune `autovacuum_vacuum_scale_factor`** lower (0.05 to 0.1) on
  large vault tables — otherwise autovacuum lags on tables that
  never receive deletes.
- **`ANALYZE`** frequently for query planner accuracy. Run
  post-load via dbt `on-run-end`.
- **`REINDEX`** rarely — btree indexes on insert-only tables don't
  bloat significantly.

## Postgres Extensions Worth Considering

- **`pgcrypto`** — for `sha256()` and stronger hashes.
- **`pg_partman`** — automated partition management for large
  satellites.
- **`pg_stat_statements`** — query performance metrics for the
  metrics vault.
- **`timescaledb`** — if load_dts range queries dominate; converts
  satellites into hypertables. Trade-off: extra complexity, some
  DV patterns require adjustment.
- **`citus`** — if you outgrow single-node Postgres. Distributes
  vault tables by `_hk`. Effectively converts Postgres into a
  cluster-warehouse (though at that point, evaluate Snowflake /
  BigQuery / Databricks too).

## Scaling Limits and Migration Signals

Signals it's time to leave Postgres for a cloud warehouse:

- **Satellite over 500M rows** and mart queries taking > 30 seconds.
- **VACUUM / autovacuum consuming > 10% of instance CPU**.
- **Backups taking > 2 hours**.
- **Concurrent BI query load** saturating connections.

Migrate raw vault → cloud warehouse first (via `pg_dump` + `COPY`
to S3 + warehouse-native load); marts follow.

## No QUALIFY — Rewrite as CTE

Postgres does NOT support the `QUALIFY` clause that Snowflake /
BigQuery / Databricks / DuckDB use for post-window filters. Any
skill example that reads:

```sql
SELECT ... FROM sat_x
QUALIFY ROW_NUMBER() OVER (PARTITION BY parent_hk ORDER BY load_dts DESC) = 1
```

must be rewritten for Postgres as:

```sql
WITH ranked AS (
    SELECT ..., ROW_NUMBER() OVER (PARTITION BY parent_hk ORDER BY load_dts DESC) AS rn
    FROM sat_x
)
SELECT ... FROM ranked WHERE rn = 1
```

Every satellite / PIT / mart query in the skill that uses QUALIFY
needs this rewrite on Postgres. dbt macros can hide this via
`{{ dbt_utils.deduplicate() }}`.

## Common Postgres-Specific Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| `hashtext()` for hash keys | 32-bit; collisions | `md5()` or `pgcrypto.digest()` |
| Storing hashes as `TEXT(32)` for very large vaults | 2× storage, slower joins | `decode(md5(x), 'hex')` → `BYTEA` |
| No partitioning on billion-row satellites | Full-table scans on mart queries | Partition by `load_dts` range |
| Missing indexes on link `_hk` join columns | Slow mart joins | Btree index per hub `_hk` referenced on the link |
| Not tuning autovacuum on insert-heavy tables | Stats stale; planner picks bad plans | Lower `autovacuum_vacuum_scale_factor` |
| `TIMESTAMP` instead of `TIMESTAMPTZ` for `load_dts` | Timezone ambiguity; DST bugs | Always `TIMESTAMPTZ` |
| `MERGE` with `WHEN MATCHED THEN UPDATE` on raw vault | Insert-only violated | Only `WHEN NOT MATCHED THEN INSERT` |
| `ON CONFLICT DO UPDATE` on raw vault | Same as above | `DO NOTHING` |
| Long-running vault load blocking mart queries | Lock contention on shared connections | Separate connection pool for loads vs. reads |
| Single-node Postgres for large DV | Compute bottleneck; nights-long loads | Migrate to cloud warehouse; use Postgres for dev only |
| Not running `ANALYZE` post-load | Planner underestimates row counts | `ANALYZE` in dbt `on-run-end` |
| Storing UUIDs as TEXT for `load_batch_id` | Slow comparisons, wasteful storage | Use `UUID` type; 16 bytes native |
