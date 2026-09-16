# Metrics Vault and Error Mart

Production Data Vault 2.0 deployments include two operational
structures the book treats as first-class: a **metrics vault**
(load statistics, timings, row counts per load) and an **error
mart** (rows rejected by hard rules, plus audit information for
downstream investigation).

These aren't "nice to have". Without them:
- You can't answer "how long did last night's load take, per feed?"
- You can't diagnose "why is this hub 5% smaller than yesterday?"
- Rejected rows disappear silently — no one sees them until a
  business user notices missing data three weeks later.
- SLA reporting is impossible.

## Metrics Vault

A metrics vault is a set of hubs / links / satellites *about the
loads themselves*. It sits alongside the raw vault, follows the same
DV 2.0 discipline, and captures every load event.

### Metrics Vault Hubs

Two hubs, minimum:

**`hub_load_batch`** — one row per load batch (per dbt invocation).

```sql
-- models/metrics_vault/hub_load_batch.sql
{{ config(materialized='incremental', unique_key='load_batch_hk',
         tags=['metrics_vault', 'hub']) }}

SELECT
    {{ dv_hash_bk(['batch_id']) }}       AS load_batch_hk,
    batch_id                             AS load_batch_bk,
    '{{ run_started_at }}'::TIMESTAMP    AS load_dts,
    'metrics_vault.batch_registration'   AS record_source
FROM (
    SELECT '{{ invocation_id }}' AS batch_id
) src
{% if is_incremental() %}
WHERE {{ dv_hash_bk(['batch_id']) }} NOT IN (SELECT load_batch_hk FROM {{ this }})
{% endif %}
```

**`hub_data_feed`** — one row per unique source feed
(`crm.customers`, `stripe.payments`).

```sql
-- models/metrics_vault/hub_data_feed.sql
{{ config(materialized='incremental', unique_key='feed_hk',
         tags=['metrics_vault', 'hub']) }}

SELECT
    {{ dv_hash_bk(['feed_name']) }}      AS feed_hk,
    feed_name                            AS feed_bk,
    '{{ run_started_at }}'::TIMESTAMP    AS load_dts,
    'metrics_vault.feed_registration'    AS record_source
FROM {{ ref('ref_data_feeds') }}         -- seed with known feeds
{% if is_incremental() %}
WHERE {{ dv_hash_bk(['feed_name']) }} NOT IN (SELECT feed_hk FROM {{ this }})
{% endif %}
```

### Metrics Vault Links

**`lnk_load_batch_feed`** — which feeds ran in which batch.

```sql
-- models/metrics_vault/lnk_load_batch_feed.sql
{{ config(materialized='incremental', unique_key='lnk_load_batch_feed_hk',
         tags=['metrics_vault', 'link']) }}

SELECT
    {{ dv_hash_bk(['batch_id', 'feed_name']) }} AS lnk_load_batch_feed_hk,
    {{ dv_hash_bk(['batch_id']) }}              AS load_batch_hk,
    {{ dv_hash_bk(['feed_name']) }}             AS feed_hk,
    '{{ run_started_at }}'::TIMESTAMP           AS load_dts,
    'metrics_vault.batch_feed_link'             AS record_source
FROM {{ ref('stg_metrics__batch_feed_events') }}
```

### Metrics Vault Satellites

**`sat_lnk_load_batch_feed_metrics`** — per-(batch, feed) statistics.

```sql
-- models/metrics_vault/sat_lnk_load_batch_feed_metrics.sql
{{ config(materialized='incremental', incremental_strategy='append',
         unique_key=['lnk_load_batch_feed_hk', 'load_dts'],
         tags=['metrics_vault', 'satellite']) }}

WITH stats AS (
    SELECT
        {{ dv_hash_bk(['batch_id', 'feed_name']) }} AS lnk_load_batch_feed_hk,
        rows_read,
        rows_loaded_hub,
        rows_loaded_link,
        rows_loaded_sat,
        rows_rejected,
        started_at,
        ended_at,
        DATEDIFF('second', started_at, ended_at)   AS duration_seconds,
        '{{ run_started_at }}'::TIMESTAMP           AS load_dts,
        'metrics_vault.load_stats'                  AS record_source
    FROM {{ ref('stg_metrics__load_stats') }}
),

hashed AS (
    SELECT
        stats.*,
        {{ dv_hashdiff([
            'duration_seconds',
            'ended_at',
            'rows_loaded_hub',
            'rows_loaded_link',
            'rows_loaded_sat',
            'rows_read',
            'rows_rejected',
            'started_at'
        ]) }} AS hashdiff
    FROM stats
)

SELECT * FROM hashed
-- Metrics are typically append-only per batch; each batch is unique so no dedup needed
```

### Populating the Metrics Vault

The metrics vault reads from a **staging area** that captures load
events. Sources of load stats:

- **dbt run results** — parse `target/run_results.json` after each
  invocation; extract per-model row counts, timing, status.
- **dbt on-run-end hooks** — write metrics inline into a table:
  ```yaml
  # dbt_project.yml
  on-run-end:
    - "{{ log_batch_stats() }}"
  ```
- **Warehouse query history** — Snowflake `INFORMATION_SCHEMA.QUERY_HISTORY`,
  BigQuery `INFORMATION_SCHEMA.JOBS_BY_PROJECT` for cost/duration.
- **Custom orchestrator** (Airflow, Dagster) — emit a metrics event
  per task and land it in staging.

Whichever source, the metrics vault reads from a staging table with
the fields `batch_id, feed_name, rows_read, rows_loaded_*, rows_rejected,
started_at, ended_at`. That table is your instrumentation contract.

### Metrics-Driven Alerts

Once the metrics vault is populated, alert on:

```sql
-- Load duration regression
SELECT feed_bk, load_dts, duration_seconds
FROM metrics_mart_recent_loads
WHERE duration_seconds > 3 * (
    SELECT AVG(duration_seconds) FROM metrics_mart_recent_loads WHERE feed_bk = f.feed_bk
);

-- Row count anomaly
SELECT feed_bk, load_dts, rows_read,
       AVG(rows_read) OVER (PARTITION BY feed_bk ORDER BY load_dts ROWS 7 PRECEDING) AS rolling_avg
FROM metrics_mart_recent_loads
WHERE rows_read < 0.5 * rolling_avg      -- 50%+ drop
   OR rows_read > 2.0 * rolling_avg;     -- 100%+ spike
```

These queries feed a metrics mart consumed by ops dashboards or
alerting (PagerDuty, Slack).

## Error Mart

An error mart is where **rows rejected by hard rules** go. It's not
a full DV 2.0 structure (no hashes, no historization required) —
it's a flat, timestamped log of "row failed X check on Y load".

### Error Mart Table Structure

```sql
-- models/error_mart/err_load_rejections.sql
{{ config(materialized='incremental',
         incremental_strategy='append',
         unique_key='rejection_id',
         tags=['error_mart']) }}

WITH source_rejections AS (
    -- Every staging model can UNION into this table
    SELECT
        '{{ invocation_id }}'                AS load_batch_id,
        '{{ run_started_at }}'::TIMESTAMP    AS rejected_at,
        'crm.customers'                      AS record_source,
        'null_business_key'                  AS rejection_reason,
        OBJECT_CONSTRUCT('customer_id', customer_id, 'row', TO_JSON(t.*))
                                             AS rejected_row,
        UUID_STRING()                        AS rejection_id
    FROM {{ ref('stg_crm__customers') }} t
    WHERE customer_id IS NULL

    UNION ALL

    SELECT
        '{{ invocation_id }}',
        '{{ run_started_at }}'::TIMESTAMP,
        'stripe.payments',
        'amount_out_of_range',
        OBJECT_CONSTRUCT('payment_id', payment_id, 'amount', amount_cents),
        UUID_STRING()
    FROM {{ ref('stg_stripe__payments') }}
    WHERE amount_cents < 0 OR amount_cents > 1000000000
)

SELECT * FROM source_rejections
```

**Columns:**
| Column | Purpose |
|--------|---------|
| `rejection_id` | Unique identifier for this rejection event |
| `load_batch_id` | Ties back to the metrics-vault batch |
| `rejected_at` | Load timestamp |
| `record_source` | Which feed the rejected row came from |
| `rejection_reason` | Machine-readable code (`null_business_key`, `unparseable_date`, `amount_out_of_range`, ...) |
| `rejected_row` | Full serialized row for investigation (JSON / VARIANT) |

### Rejection Reasons — Standard Set

Adopt a controlled vocabulary so downstream aggregation makes sense:

| Code | Meaning |
|------|---------|
| `null_business_key` | Business key column was NULL; hub can't hash |
| `duplicate_business_key_in_load` | BK appeared >1 time in the same load batch (may be intentional) |
| `unparseable_timestamp` | Source's date/timestamp couldn't be cast |
| `unparseable_number` | Numeric column couldn't be cast |
| `character_encoding_error` | UTF-8 / Latin-1 conversion failed |
| `field_length_exceeded` | Value longer than target column allows |
| `referential_integrity_missing` | FK on a link doesn't exist in the hub |
| `checksum_mismatch` | Source checksum failed |
| `schema_mismatch` | Source schema changed unexpectedly |

Add project-specific codes; keep the total set small.

### Error Mart Consumption

Feed an ops dashboard with:

```sql
-- Rejections per feed per day
SELECT
    record_source,
    DATE_TRUNC('day', rejected_at) AS rejected_date,
    rejection_reason,
    COUNT(*) AS rejection_count
FROM {{ ref('err_load_rejections') }}
WHERE rejected_at >= CURRENT_DATE - 30
GROUP BY 1, 2, 3
ORDER BY rejected_date DESC, rejection_count DESC;
```

Alert when:
- Any feed's rejection count > N per day.
- New `rejection_reason` appears (schema-drift indicator).
- Rejection count for a feed spikes (regressive change upstream).

### Rows That Are Rejected AND Loaded

Some rejections are informational, not fatal — a hard-rule failure
where the row *does* flow into the vault (with sentinel values for
the failed column). For those, log to the error mart *and* insert
into staging with a flag column:

```sql
-- stg_crm__customers.sql
SELECT
    ...
    CASE WHEN email NOT LIKE '%@%' THEN TRUE ELSE FALSE END AS email_format_invalid
FROM source
```

The row still loads; a downstream mart consumer filters or
highlights invalid-email customers. Rejection is a data-quality
signal, not always a load blocker.

## Reconciliation — Metrics Vault + Error Mart Together

Full audit reconciliation:

```sql
-- For a given batch, did every source row end up somewhere?
WITH batch_stats AS (
    SELECT feed_name, rows_read, rows_loaded_sat, rows_rejected
    FROM metrics_mart_recent_loads
    WHERE load_batch_id = 'abc-123'
)

SELECT
    feed_name,
    rows_read,
    rows_loaded_sat,
    rows_rejected,
    rows_read - rows_loaded_sat - rows_rejected AS unaccounted
FROM batch_stats;
```

`unaccounted` should always be 0 (or explained by intentional
filtering with an audit trail). Non-zero → row leakage; investigate.

## Common Metrics/Error Vault Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| No metrics vault | Can't answer "did last night's load succeed"; no SLA basis | Instrument every load; land in staging → metrics vault |
| Metrics vault only tracks success/failure, not row counts | Can't detect silent row-count regressions | Row-count metrics per feed per batch, minimum |
| Rejected rows silently dropped (no error mart) | Downstream users notice data missing weeks later | Every hard-rule failure emits a row to `err_load_rejections` |
| `rejected_row` stored as strings, not structured | Investigation requires parsing | Store as JSON / VARIANT with full row snapshot |
| Rejection reasons are free-text | Aggregation impossible; alerting can't grep | Controlled vocabulary of reason codes |
| No `load_batch_id` in error mart | Can't tie rejections back to specific batches | Include `invocation_id` on every rejection |
| Metrics vault outside the DV discipline (mutable, no `load_dts`) | Metrics themselves become unaudited | Same insert-only + hashdiff rules as raw vault |
| Alerting off the raw metrics vault instead of a metrics mart | Alerts fire on raw hash keys; unreadable | Build a metrics mart with human-readable columns |
| Rejections that should be loaded-with-flag are dropped | Fixable data quality issues lost | Choose per-rule: fatal (reject only) vs. informational (load + flag + log) |
