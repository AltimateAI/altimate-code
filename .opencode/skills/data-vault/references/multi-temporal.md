# Multi-Temporal (Bi-Temporal) Historization

Data Vault 2.0 satellites are already historized on `load_dts` —
"when did we see this version of the data". A **bi-temporal** or
**multi-temporal** satellite additionally tracks *when the business
event occurred* or *when the value became effective in the real
world*. This lets you answer both:

- **"What did we know about customer X on 2024-06-01?"** — technical
  time (`load_dts`).
- **"What was the address of customer X on 2024-06-01?"** —
  business/valid time (`applied_dts` / `valid_from` / `valid_to`).

The two axes are independent. A move that happened on 2024-04-01
but was reported to us on 2024-06-15 gives us:
- `load_dts = 2024-06-15` (when we learned)
- `applied_dts = 2024-04-01` (when the move happened)

Bi-temporal history is what production-grade DV 2.0 uses whenever
sources can back-date, correct, or reload.

## Terminology

Sources vary; pick a project-wide convention:

| Concept | Common column names |
|---------|---------------------|
| When we loaded the row | `load_dts`, `ldts`, `record_load_dts` |
| When the business event occurred | `applied_dts`, `business_dts`, `event_dts`, `valid_from`, `effective_from`, `source_ts` |
| When the business event ended | `valid_to`, `effective_to`, `end_dts` |
| When the source itself last modified the record | `source_updated_dts`, `source_updated_at` |

**Do not conflate.** The most damaging bug in bi-temporal design
is using one column where another is required — usually
`source_updated_at` masquerading as `load_dts`, or `applied_dts`
misinterpreted as a load event.

## The Bi-Temporal Satellite

Standard satellite adds `applied_dts` as a descriptive column (part
of the hashdiff? — usually no, see below):

```sql
-- models/raw_vault/satellites/sat_customer_address_bitemporal.sql
{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key=['customer_hk', 'load_dts'],
    tags=['raw_vault', 'satellite', 'bi_temporal']
) }}

WITH source_current AS (
    SELECT
        customer_id,
        address_line_1,
        city,
        postal_code,
        country_code,
        effective_date               AS applied_dts,      -- when the address became effective
        '{{ run_started_at }}'::TIMESTAMP AS load_dts,
        'crm.customer_addresses'     AS record_source
    FROM {{ ref('stg_crm__customer_addresses__hashed') }}
    WHERE customer_id IS NOT NULL
),

hashed AS (
    SELECT
        {{ dv_hash_bk(['customer_id']) }} AS customer_hk,
        -- Hashdiff includes applied_dts because a re-report of the same
        -- address with a different applied_dts IS a different fact.
        {{ dv_hashdiff([
            'address_line_1',
            'applied_dts',
            'city',
            'country_code',
            'postal_code'
        ]) }} AS hashdiff,
        load_dts,
        applied_dts,
        record_source,
        address_line_1,
        city,
        postal_code,
        country_code
    FROM source_current
),

{% if is_incremental() %}
latest_in_target AS (
    SELECT customer_hk, hashdiff AS latest_hashdiff
    FROM {{ this }}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_hk ORDER BY load_dts DESC) = 1
),
{% endif %}

to_load AS (
    SELECT h.*
    FROM hashed h
    {% if is_incremental() %}
    LEFT JOIN latest_in_target l USING (customer_hk)
    WHERE l.customer_hk IS NULL OR l.latest_hashdiff <> h.hashdiff
    {% endif %}
)

SELECT * FROM to_load
```

**Hashdiff includes `applied_dts`.** This is the key design choice:
- If a source resends the same address with the same `applied_dts`
  → no change, no new row.
- If a source resends the same address with a *different*
  `applied_dts` (say, "actually it was effective a month earlier") →
  new hashdiff, new row. That correction is preserved.

## Querying Bi-Temporally

**Note on dialect:** the examples below use Snowflake-style
`MD5_BINARY(...)` and `QUALIFY`. On Databricks use
`unhex(md5(...))`, on BigQuery `MD5(...)` returning BYTES, on
Postgres `decode(md5(...), 'hex')`; `QUALIFY` works on Snowflake /
BigQuery / Databricks / DuckDB but not on Postgres or Redshift
(rewrite as a CTE with `ROW_NUMBER()` filter). See
[hashing-and-keys.md](hashing-and-keys.md) for the dialect matrix.

### Snapshot query — "as of technical time X"

```sql
-- What did we know about customer X's address as of 2024-06-15?
SELECT *
FROM sat_customer_address_bitemporal
WHERE customer_hk = MD5_BINARY('...')     -- dialect-adapt per note above
  AND load_dts <= '2024-06-15'::TIMESTAMP
QUALIFY ROW_NUMBER() OVER (ORDER BY load_dts DESC) = 1;
```

### Business-time query — "what was true on business date X, as of latest knowledge"

```sql
-- What is the address of customer X on business date 2024-06-01, using
-- our latest knowledge?
SELECT *
FROM sat_customer_address_bitemporal
WHERE customer_hk = MD5_BINARY('...')
  AND applied_dts <= '2024-06-01'::DATE
QUALIFY ROW_NUMBER() OVER (ORDER BY applied_dts DESC, load_dts DESC) = 1;
```

### Full bi-temporal query — "what was true on business date X, based on knowledge as of technical time Y"

```sql
-- What was customer X's address on 2024-06-01, using knowledge we had
-- as of 2024-06-15 (before the correction that arrived on 2024-06-20)?
SELECT *
FROM sat_customer_address_bitemporal
WHERE customer_hk = MD5_BINARY('...')
  AND load_dts <= '2024-06-15'::TIMESTAMP    -- knowledge cutoff
  AND applied_dts <= '2024-06-01'::DATE       -- business date
QUALIFY ROW_NUMBER() OVER (ORDER BY applied_dts DESC, load_dts DESC) = 1;
```

This is the query pattern the bi-temporal satellite enables.
Regulatory reporting ("what did we file at the time?") and back-testing
("what would our model have predicted using only the data we had?")
depend on it.

## Effective-Interval Bi-Temporal Satellite

Alternative form: store `valid_from` / `valid_to` explicitly, so
each row represents an interval of business time. Common when the
source pre-computes effective ranges (regulatory data, contract
data).

```sql
-- Alternative shape:
customer_hk           BINARY(16),
load_dts              TIMESTAMP,
hashdiff              BINARY(16),
record_source         VARCHAR,
valid_from            DATE,
valid_to              DATE,          -- often '9999-12-31' for open-ended
address_line_1        VARCHAR,
city                  VARCHAR,
...
```

The hashdiff must include *both* `valid_from` and `valid_to`. When
a correction arrives that shrinks or extends an interval, a new row
inserts.

**Advantage:** query is simpler (just filter on interval).
**Disadvantage:** every "correction" of an interval creates a new
row with slightly different `valid_from`/`valid_to`; history bloats
faster.

## Handling Retroactive Corrections

Bi-temporal design handles the classic "source resent a corrected
version of a past event" case cleanly:

**Timeline:**
1. 2024-06-01 — Customer moves; source reports it correctly.
   - Vault: `load_dts=2024-06-01, applied_dts=2024-06-01, address=NEW`
2. 2024-06-15 — Source reports "actually, they moved on 2024-04-01,
   not 2024-06-01."
   - Vault: `load_dts=2024-06-15, applied_dts=2024-04-01, address=NEW`
   - Both rows preserved. Neither overwrites the other.

Queries pick the "best" row based on both times:
- "What did we know on 2024-06-10?" → the 2024-06-01 row.
- "What do we know now about the address on 2024-05-01?" → the
  2024-06-15 row (retrocorrected).

Standard mono-temporal design can't distinguish. Bi-temporal
preserves both.

## Two Common Anti-Patterns

### Using `source_updated_at` as `load_dts`

**Wrong:**
```sql
CAST(source.updated_at AS TIMESTAMP) AS load_dts    -- WRONG
```

If the source can back-date `updated_at`, the vault's history
becomes non-monotonic — a load run today might insert a row with
`load_dts` older than yesterday's row. The whole "chain of what we
knew when" breaks.

**Right:**
```sql
'{{ run_started_at }}'::TIMESTAMP    AS load_dts,       -- ingestion time
CAST(source.updated_at AS TIMESTAMP) AS source_updated_dts  -- descriptive column
```

Both stored. `load_dts` drives the vault; `source_updated_dts` is a
descriptive attribute for downstream analysis.

### Missing `applied_dts` for mutable business events

**Wrong:** treating a bi-temporal source as if it were mono-temporal.
When the source has an `effective_date` or `event_date` and can send
corrections against it, and you don't store it, retroactive
corrections silently overwrite the earlier "current" answer for a
business date.

**Right:** always store the source's business timestamp as a
descriptive column, ideally as part of the hashdiff so corrections
trigger new satellite rows.

## Mart Consumption

Bi-temporal marts typically expose *both* dimensions:

```sql
-- dim_customer_address_bitemporal in the mart
SELECT
    customer_hk,
    address_line_1,
    city,
    load_dts        AS knowledge_dts,
    applied_dts     AS business_dts,
    LEAD(applied_dts) OVER (PARTITION BY customer_hk ORDER BY applied_dts, load_dts) AS applied_end_dts
FROM {{ ref('sat_customer_address_bitemporal') }}
```

Downstream BI can then filter by either axis.

For pure "current" queries (mono-temporal), a PIT table on
`(customer_hk, snapshot_dts)` where `snapshot_dts` is business time
gives the same answer with fewer joins.

## When to Skip Bi-Temporal

Bi-temporal has overhead: extra column, extra hashdiff component,
larger satellite, more complex queries. Skip it if:

- The source never back-dates or corrects historical events.
- Downstream doesn't need to reason about business time
  independent of load time.
- The source's "event date" is exactly the load time (typical for
  event streams from Kafka / event-sourced systems — the event
  timestamp IS effectively the ingest time).

Add it later if needed — new bi-temporal satellite alongside the
mono-temporal one, and downstream chooses.

## Common Multi-Temporal Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| `source_updated_at` used as `load_dts` | Non-monotonic vault history; retroactive back-dating breaks the audit chain | `load_dts` is always ingestion time; source timestamps become descriptive columns |
| `applied_dts` not in hashdiff | Retroactive corrections with new applied_dts are invisible | Include applied_dts in hashdiff so corrections trigger new rows |
| `valid_from` / `valid_to` computed inside dbt via `LEAD()` at query time | Query cost dominates on large satellites | Store closed intervals in an effectivity satellite instead |
| Bi-temporal satellite with `valid_to = NULL` in the current row | Mart queries filtering on `valid_to <= X` miss the current row | Use `'9999-12-31'` sentinel for open-ended intervals |
| Applying bi-temporal to every satellite | Storage / compute explosion; most cases don't need it | Reserve for satellites where sources can back-date or historical business-time queries matter |
| Both `applied_dts` and `load_dts` in the primary key | PK grain wrong; multiple rows per (parent, load) collide | PK is `(parent_hk, load_dts)`; `applied_dts` is descriptive |
| Confusing bi-temporal with effectivity satellite | Two different structures; effectivity satellite tracks link-relationship intervals, bi-temporal sat tracks payload-with-business-time | Use effectivity for links; bi-temporal for hub sats with retroactive events |
| Missing `applied_dts` documentation | Downstream doesn't know it exists; queries default to `load_dts` | `_models.yml` explicitly documents both temporal axes and when to use each |
