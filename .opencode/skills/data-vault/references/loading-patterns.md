# Loading Patterns

Every raw-vault load is **insert-only** and **idempotent**: re-running
the same input produces zero new rows the second time. The patterns
in this file give you those two properties. Losing either breaks the
vault's audit contract.

## The Three Load Rules

1. **Insert-only.** No `UPDATE`, no `DELETE`, no `MERGE` on the raw
   vault. New information appends; old information stays exactly
   where it was.
2. **Idempotent.** Running the same load twice does not double-insert.
   Re-running yesterday's load today produces zero new rows.
3. **Deterministic.** The same input rows produce the same output
   rows, byte-for-byte, regardless of what else is in the warehouse
   or how many parallel loads are running.

Each pattern below is a template for one of the three vault table
types. All three rules are baked into each template.

## Hub Load Pattern

```sql
{{ config(
    materialized='incremental',
    unique_key='<entity>_hk',
    on_schema_change='fail',
    tags=['raw_vault', 'hub']
) }}

WITH source_unioned AS (
    SELECT <bk_col> AS <entity>_bk,
           '{{ run_started_at }}'::TIMESTAMP AS load_dts,
           '<source_a>'                      AS record_source
    FROM {{ ref('stg_source_a') }}
    WHERE <bk_col> IS NOT NULL

    UNION ALL

    SELECT <bk_col_2> AS <entity>_bk,
           '{{ run_started_at }}'::TIMESTAMP AS load_dts,
           '<source_b>'                      AS record_source
    FROM {{ ref('stg_source_b') }}
    WHERE <bk_col_2> IS NOT NULL
),

hashed AS (
    SELECT {{ dv_hash_bk(['<entity>_bk']) }} AS <entity>_hk,
           <entity>_bk,
           load_dts,
           record_source
    FROM source_unioned
),

deduped AS (
    SELECT <entity>_hk, <entity>_bk, load_dts, record_source
    FROM hashed
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY <entity>_hk
        ORDER BY load_dts, record_source
    ) = 1
)

SELECT * FROM deduped
{% if is_incremental() %}
LEFT JOIN {{ this }} existing USING (<entity>_hk)
WHERE existing.<entity>_hk IS NULL
{% endif %}
```

**Idempotency:** the anti-join filters out anything already loaded.
**Determinism:** the dedup tiebreak (`load_dts, record_source`) is
deterministic.
**Insert-only:** no `MERGE`, no `unique_key`-driven upsert — dbt's
default incremental strategy is `append` when the anti-join is
already filtering. If your adapter defaults to `merge`, force it:

```jinja
{{ config(
    materialized='incremental',
    incremental_strategy='append',    -- force append; the anti-join enforces uniqueness
    unique_key='<entity>_hk',         -- required for schema tests; not used for loading
    tags=['raw_vault', 'hub']
) }}
```

## Link Load Pattern

Identical shape to the hub, differing only in the hash and the number
of hub keys carried.

```sql
{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key='<lnk>_hk',
    tags=['raw_vault', 'link']
) }}

WITH source_rows AS (
    SELECT <bk_1>, <bk_2>, ...,
           '{{ run_started_at }}'::TIMESTAMP AS load_dts,
           '<source>'                        AS record_source
    FROM {{ ref('stg_source') }}
    WHERE <bk_1> IS NOT NULL AND <bk_2> IS NOT NULL AND ...
),

hashed AS (
    SELECT
        {{ dv_hash_bk(['<bk_1>', '<bk_2>']) }}  AS <lnk>_hk,
        {{ dv_hash_bk(['<bk_1>']) }}            AS <hub_a>_hk,
        {{ dv_hash_bk(['<bk_2>']) }}            AS <hub_b>_hk,
        load_dts,
        record_source
    FROM source_rows
),

deduped AS (
    SELECT * FROM hashed
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY <lnk>_hk
        ORDER BY load_dts, record_source
    ) = 1
)

SELECT * FROM deduped
{% if is_incremental() %}
LEFT JOIN {{ this }} existing USING (<lnk>_hk)
WHERE existing.<lnk>_hk IS NULL
{% endif %}
```

## Satellite Load Pattern

Different filter from hubs and links: the row loads if either the
parent has never been seen, or the current hashdiff differs from the
latest one on record.

```sql
{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key=['<parent>_hk', 'load_dts'],
    tags=['raw_vault', 'satellite']
) }}

WITH source_current AS (
    SELECT <bk_col>, <attr_1>, <attr_2>, ...,
           '{{ run_started_at }}'::TIMESTAMP AS load_dts,
           '<source>'                        AS record_source
    FROM {{ ref('stg_source') }}
    WHERE <bk_col> IS NOT NULL
),

hashed AS (
    SELECT
        {{ dv_hash_bk(['<bk_col>']) }}                   AS <parent>_hk,
        {{ dv_hashdiff(['<attr_1>', '<attr_2>', ...]) }} AS hashdiff,
        load_dts,
        record_source,
        <attr_1>, <attr_2>, ...
    FROM source_current
),

{% if is_incremental() %}
latest_in_target AS (
    SELECT <parent>_hk, hashdiff AS latest_hashdiff
    FROM {{ this }}
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY <parent>_hk ORDER BY load_dts DESC
    ) = 1
),
{% endif %}

to_load AS (
    SELECT h.*
    FROM hashed h
    {% if is_incremental() %}
    LEFT JOIN latest_in_target l USING (<parent>_hk)
    WHERE l.<parent>_hk IS NULL
       OR l.latest_hashdiff <> h.hashdiff
    {% endif %}
)

SELECT * FROM to_load
```

## Choosing an Incremental Strategy Per Warehouse

| Warehouse | Preferred strategy | Notes |
|-----------|--------------------|-------|
| Snowflake | `append` | Works cleanly. The anti-join is the filter; no MERGE needed. |
| BigQuery | `append` | Cheap append. Cluster by `_hk` for join speed. |
| Redshift | `append` | Use `sortkey(load_dts)` and `distkey(_hk)`. |
| Databricks | `append` | Use `ZORDER BY (_hk)`. |
| PostgreSQL | `append` | Add btree index on `_hk`. |
| DuckDB | `append` | Use table partitioning on `load_dts` for large sats. |

**Never use `incremental_strategy='merge'` or `'delete+insert'`** on
a raw vault table. Both violate insert-only. The rare exception:
some effectivity-satellite implementations use `merge` for the
"close previous interval" step — prefer AutomateDV's `eff_sat`
macro rather than hand-rolling the merge.

## `load_dts` — Use `run_started_at`, Not `NOW()`

```sql
-- Right: every row in one dbt run gets the same load_dts.
'{{ run_started_at }}'::TIMESTAMP AS load_dts

-- Wrong: rows inserted at different points in the run get different timestamps,
-- fragmenting what should be one logical load event.
CURRENT_TIMESTAMP() AS load_dts
```

`{{ run_started_at }}` is a Jinja variable dbt sets once at run start.
Every model in the same run gets the same value, which means hubs +
links + satellites loaded in the same run share a `load_dts`. That's
the correct atomicity — the vault has a single "we loaded this batch"
event, not one event per model.

**Microsecond precision.** Snowflake, BigQuery, and Postgres store
timestamps at microsecond precision by default. Two loads that run
within the same second are still distinguishable because
`run_started_at` includes microseconds. If you're on a warehouse that
only stores second precision, ensure loads never run more than once
per second (rare, but check).

## `record_source` — Granularity Matters

The `record_source` column is what lets you trace any vault row back
to its origin. Recommended format:

```
'<source_system>.<feed_or_table_name>'
```

Examples:
- `'salesforce.accounts'`
- `'stripe.payments'`
- `'crm.customers'`
- `'system.deletion_detection'`   (for status-tracking-sat close events)
- `'system.effectivity_close'`   (for effectivity-sat close events)

Store it as a `VARCHAR` — do not tokenize into a lookup table. When a
production incident requires tracing a row's source three years later,
you want the answer inline, not via a join to a lookup that may have
been dropped.

## Load Ordering — Hubs Before Links Before Satellites

dbt's DAG handles this automatically as long as every satellite `ref`s
its parent hub (or link), and every link `ref`s the source. Do not
run in parallel across layers without confirming the DAG:

```
stg_source_a  ─┐
               ├──►  hub_customer  ─┐
stg_source_b  ─┘                    ├──►  sat_customer_details
                                    │
stg_source_c  ─────► lnk_order_customer ─┐
                                          ├──►  sat_lnk_order_status
                                          │
                             hub_order  ──┘
```

The DAG guarantees hubs load before satellites and links load before
their satellites. Do not use `dbt run --select sat_x --exclude hub_x`
during initial builds — the satellite's foreign-key tests will fail
against a missing hub.

## Idempotency Verification

After any change to a load pattern, verify idempotency:

```bash
altimate-dbt build --model hub_customer          # first load
altimate-dbt build --model hub_customer          # second load; should insert 0 rows
```

Check via query:
```sql
SELECT COUNT(*) FROM {{ ref('hub_customer') }}
WHERE load_dts = <second_run_started_at>;
-- Must be 0. If not, the anti-join is failing.
```

For satellites, the second-run check has an extra step: if the source
data hasn't changed, the second load should insert exactly the
"ghost row" set (parents that appeared for the first time in the
source), and zero rows if the source itself hasn't gained new parents.

## Handling Late-Arriving Source Data

Late-arriving rows (records whose "real" timestamp is older than
current load) are handled naturally:
- The hub/link only cares about first-seen; a late arrival still
  inserts if the business key is new.
- The satellite loads a row with `load_dts = current_run_started_at`,
  not the source's back-dated timestamp. Downstream reporting sees
  the row appear at ingestion time, which is the correct semantic —
  "we became aware of this on X" is what auditing cares about, not
  "the source said it happened on Y".

If downstream reports need to reason about "source event time" too,
store it as a *descriptive column* in the satellite alongside the
attributes. Do not use it for `load_dts`.

## Handling Source Corrections / Re-issues

If a source system emits a "corrected" row (same business key,
different descriptive attributes), the satellite handles it
correctly: the corrected hashdiff differs from the previous
hashdiff, and a new row appears. Downstream queries taking `MAX(load_dts)`
see the correction.

If the correction restores an *earlier* value (source flip-flops),
the satellite records both flips — this is what you want. History is
the entire sequence of what we observed.

**Do not** try to "reconcile" or "clean up" corrections in the raw
vault. That belongs in the business vault or information mart.

## Handling Source Deletions

Raw vault never deletes. When a business key disappears from source,
options:

1. **Ignore the disappearance.** The hub row stays; the satellite's
   most recent row stands. Downstream consumers assume "no news is
   good news".
2. **Status-tracking satellite** (`sts_customer`) — inserts a `'DELETED'`
   row on the load when the key stopped being present. Downstream
   consumers can filter it out.
3. **Effectivity satellite** on a link — if the deletion applies to a
   relationship (customer's account manager stopped being assigned),
   the effectivity satellite closes the interval.

Choose based on what downstream needs to know. Deletion detection
adds compute (a full anti-join against the previous snapshot every
load) so opt in per-hub, not blanket.

## Common Loading Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| `incremental_strategy='merge'` on a hub/link/sat | Existing rows update, violating insert-only | Force `strategy='append'` + anti-join |
| Using `CURRENT_TIMESTAMP()` instead of `{{ run_started_at }}` | Rows in one logical load get different timestamps | Always `{{ run_started_at }}` |
| Materialized as `table` instead of `incremental` | Full reload every run wipes `load_dts` accuracy and history | `materialized='incremental'` |
| Anti-join column mismatch (`USING (customer_hk)` when target column is `customer_hash_key`) | Silent full-append every load — vault grows without bound | Match column names exactly, or specify explicitly |
| Missing `WHERE bk IS NOT NULL` filter | Ghost rows with polluted `load_dts` | Filter NULLs before hashing |
| Satellite compares hashdiff to any row instead of the *latest* | Second-latest wins → row inserts when nothing changed, or doesn't when it did | `QUALIFY ROW_NUMBER() ... ORDER BY load_dts DESC = 1` |
| Loading sat before its hub | FK integrity briefly broken; downstream reads fail | dbt DAG ordering via `ref()` |
| Full-refresh on a raw vault table | Complete history loss; not recoverable | Never `--full-refresh` a raw vault table. If you must restructure, load into a *new* table and swap. |
| Not verifying idempotency | Silent double-inserts you find months later | Run every new load pattern twice back-to-back and check second-run row count is 0 |
