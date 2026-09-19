# Record Tracking Satellites (RTS)

A record tracking satellite (RTS) records **when a parent hash key
was seen in a load**, without carrying any descriptive payload. It's
the audit-focused sibling of the status tracking satellite (STS)
and the multi-active satellite (MAS).

Distinguish carefully:

- **Standard satellite** — historizes descriptive attributes; new row
  on hashdiff change.
- **Status tracking satellite (STS)** — records `'PRESENT'` /
  `'DELETED'` status per parent, allowing deletion detection.
- **Record tracking satellite (RTS)** — records *every* load in
  which the parent hash key appeared, regardless of change or status.
  No descriptive attributes.

The book introduces RTS as a specialized structure for CDC and
audit use cases where you need to know "when was this key in the
source", not "what did the key look like".

## When to Use an RTS

- **Auditing.** You need to prove which loads a specific business key
  participated in — for compliance, SLA reporting, or forensic
  investigations.
- **Late-arriving data detection.** Comparing RTS load_dts to an
  applied timestamp on a satellite tells you if data arrived late.
- **Source availability tracking.** Which feeds contributed which
  keys on which days.
- **Snapshot-based CDC where no `updated_at` exists.** You dump the
  full source every load; the RTS + STS pair records what was in
  each dump.

Do *not* use RTS as a substitute for status tracking. RTS records
presence over time; STS records the state (present vs. deleted). They
answer different questions.

## RTS Structure

```sql
-- models/raw_vault/satellites/rts_customer.sql
{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key=['customer_hk', 'load_dts', 'record_source'],
    tags=['raw_vault', 'satellite', 'record_tracking']
) }}

WITH source_current AS (
    SELECT
        {{ dv_hash_bk(['customer_id']) }} AS customer_hk,
        '{{ run_started_at }}'::TIMESTAMP AS load_dts,
        'crm.customers'                   AS record_source
    FROM {{ ref('stg_crm__customers__hashed') }}
    WHERE customer_id IS NOT NULL
),

deduped AS (
    -- One row per parent per load
    SELECT
        customer_hk,
        load_dts,
        record_source
    FROM source_current
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY customer_hk, record_source
        ORDER BY load_dts
    ) = 1
)

SELECT * FROM deduped
{% if is_incremental() %}
-- Only insert (parent, load_dts, record_source) combinations we haven't recorded yet
-- For same-day re-runs, the anti-join keeps the earliest load_dts per (customer, source, day)
LEFT JOIN {{ this }} existing
    ON deduped.customer_hk = existing.customer_hk
   AND deduped.record_source = existing.record_source
   AND DATE_TRUNC('day', deduped.load_dts) = DATE_TRUNC('day', existing.load_dts)
WHERE existing.customer_hk IS NULL
{% endif %}
```

Columns are the minimum: `parent_hk`, `load_dts`, `record_source`.
Optionally add `load_batch_id` if you want batch-level traceability.

**Grain:** one row per (parent, load_dts, source). Or, if you dedupe
to a daily grain, one row per (parent, load_date, source). Pick the
grain based on how you'll query the RTS.

## RTS + STS Pair (Snapshot CDC)

The most common production use of RTS: paired with an STS to
implement CDC over a source that only ever provides full snapshots.

**Setup:**
- Source dumps the full customer table daily.
- RTS records every (customer_hk, load_dts) pair — every day a
  customer was in the dump.
- STS records `'PRESENT'` / `'DELETED'` transitions — computed as
  the difference between one day's RTS entries and the next.

```sql
-- sts_customer.sql, driven by RTS
WITH todays_keys AS (
    SELECT DISTINCT customer_hk
    FROM {{ ref('rts_customer') }}
    WHERE DATE_TRUNC('day', load_dts) = CURRENT_DATE
),

yesterdays_keys AS (
    SELECT DISTINCT customer_hk
    FROM {{ ref('rts_customer') }}
    WHERE DATE_TRUNC('day', load_dts) = CURRENT_DATE - 1
),

new_keys AS (
    SELECT
        customer_hk,
        'PRESENT'                            AS cdc_status,
        '{{ run_started_at }}'::TIMESTAMP    AS load_dts,
        'system.cdc'                         AS record_source
    FROM todays_keys
    WHERE customer_hk NOT IN (SELECT customer_hk FROM yesterdays_keys)
),

deleted_keys AS (
    SELECT
        customer_hk,
        'DELETED'                            AS cdc_status,
        '{{ run_started_at }}'::TIMESTAMP    AS load_dts,
        'system.cdc'                         AS record_source
    FROM yesterdays_keys
    WHERE customer_hk NOT IN (SELECT customer_hk FROM todays_keys)
)

SELECT * FROM new_keys
UNION ALL
SELECT * FROM deleted_keys
-- (Full STS also handles re-appearance and initial load; simplified here)
```

The RTS is the substrate; the STS interprets it. Both live in the
raw vault.

## RTS for Multi-Source Tracking

When two source systems feed the same hub, an RTS with
`record_source` in its grain records which source contributed the
key on which days:

```sql
SELECT customer_hk, record_source, MIN(load_dts) AS first_seen, MAX(load_dts) AS last_seen
FROM rts_customer
GROUP BY customer_hk, record_source
ORDER BY customer_hk;
```

Answer: "Customer X first appeared in CRM on 2024-01-15; started
appearing in ERP on 2024-06-01; last seen in CRM 2025-03-01;
still active in ERP."

## RTS at Sub-Hub Grain (per Source Row)

The default RTS records at the parent-hash-key grain (one row per
customer per load). For higher-fidelity auditing, record per
**source row** — every raw source row that produced or referenced the
parent gets an RTS entry:

```sql
-- rts_customer_per_source_row.sql
SELECT
    {{ dv_hash_bk(['customer_id']) }}                            AS customer_hk,
    {{ dv_hash_bk(['customer_id', 'source_row_ingest_id']) }}    AS source_row_hk,   -- unique per source row
    source_row_ingest_id,
    '{{ run_started_at }}'::TIMESTAMP                            AS load_dts,
    'crm.customers'                                              AS record_source
FROM {{ ref('stg_crm__customers__hashed') }}
WHERE customer_id IS NOT NULL
```

This is heavier — RTS grows at source-row rate — but it lets you
answer "which specific source row produced this satellite row"
questions.

## RTS Cost Considerations

RTS grows at parent × load-frequency rate. For a 10M-parent hub with
daily loads, RTS grows ~10M rows/day. Manage by:

- **Cluster on `(load_dts, customer_hk)`** — most queries filter by
  time window.
- **Partition by month** on warehouses that support it (BigQuery,
  Databricks).
- **Coarsen the grain to daily** if per-load granularity isn't
  needed. `DATE_TRUNC('day', load_dts)` in the incremental filter.
- **Retention policy** — delete or archive RTS rows older than N
  years if compliance allows. This is the only vault structure that
  can be selectively purged (because it's audit metadata, not
  business data).

## Tests

```yaml
# _models.yml
models:
  - name: rts_customer
    description: |
      Records every load in which a customer_hk appeared. Grain:
      (customer_hk, load_dts, record_source).
    columns:
      - name: customer_hk
        tests:
          - not_null
          - relationships:
              to: ref('hub_customer')
              field: customer_hk
      - name: load_dts
        tests: [not_null]
      - name: record_source
        tests: [not_null]

    tests:
      - dbt_utils.unique_combination_of_columns:
          combination_of_columns:
            - customer_hk
            - load_dts
            - record_source
```

## Common RTS Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Confusing RTS with STS | RTS records presence over time; STS records current state. Using one where the other is needed answers wrong questions | Pair them: RTS is substrate, STS is interpretation |
| Adding descriptive payload to RTS | Blurs the distinction with standard satellite | RTS has no payload; put attributes in a separate sat |
| No `record_source` in grain | Can't distinguish which source contributed the key on which day | Include `record_source` in `unique_key` |
| Running RTS with hashdiff logic | RTS has no hashdiff; every load appends fresh rows | RTS is append-only, no change detection needed |
| Growing without bound | Storage cost dominates over time | Coarsen grain, cluster/partition by `load_dts`, retention policy |
| Building STS without RTS on snapshot-CDC source | STS can't compute deletions without a prior-state reference | RTS is the prior-state substrate |
| Using RTS as a replacement for the standard satellite | No payload = no history of descriptive attributes | RTS and standard sat coexist |
