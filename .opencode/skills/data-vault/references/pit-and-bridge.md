# Point-in-Time (PIT) and Bridge Tables

PIT and bridge tables are the performance layer between the raw vault
and the information mart. They add no new information — everything in
them is computable from the raw vault — but they replace expensive
`MAX(load_dts) WHERE load_dts <= snapshot_dts` sub-queries with a
direct lookup.

Both are **derived, disposable, and rebuildable**. Drop and rebuild
freely. Unlike raw vault tables, they can be `materialized='table'`
and reload from scratch on schedule.

## When You Need a PIT Table

You need a PIT table for any hub or link whose satellites you query
frequently at a given `as-of` time. Symptoms:

- Information mart queries take minutes because they run one
  correlated sub-query per satellite: `SELECT ... FROM sat WHERE
  parent_hk = x AND load_dts = (SELECT MAX(load_dts) FROM sat WHERE
  parent_hk = x AND load_dts <= '2024-06-01')`.
- Multi-satellite joins in the mart involve `MAX(load_dts)` on each
  satellite, and the planner picks a bad plan.
- "As of yesterday" or "as of month-end" queries are common
  reporting needs.

You **don't** need a PIT table if the mart only ever wants "current
state" (latest row per parent per satellite) — that's a simpler
`QUALIFY ROW_NUMBER() = 1` query.

## Basic PIT Structure

One row per parent hash key per snapshot date. Columns:

| Column | Purpose |
|--------|---------|
| `<parent>_hk` | Parent hash key. |
| `snapshot_dts` | The as-of timestamp this row indexes. |
| `<sat_a>_load_dts` | The `load_dts` of the current-as-of-snapshot row in `sat_a`. |
| `<sat_b>_load_dts` | Same for `sat_b`. |
| ... | One column pair per satellite the PIT covers. |

Downstream marts join `PIT ON parent_hk` and then `sat_a ON
(parent_hk, load_dts) = (PIT.parent_hk, PIT.sat_a_load_dts)` —
a direct-index lookup, no `MAX(...)`.

## Daily PIT Template

```sql
-- models/business_vault/pit/pit_customer_daily.sql
{{ config(
    materialized='table',                       -- rebuildable from scratch
    tags=['business_vault', 'pit']
) }}

WITH date_spine AS (
    -- One row per snapshot date. Use dbt_utils.date_spine or a warehouse-native spine.
    {{ dbt_utils.date_spine(
        datepart="day",
        start_date="cast('2020-01-01' as date)",
        end_date="cast(current_date as date)"
    ) }}
),

hub_snapshots AS (
    -- Every hub × every snapshot date. Optionally filter to dates the parent existed.
    SELECT
        h.customer_hk,
        d.date_day::TIMESTAMP AS snapshot_dts
    FROM {{ ref('hub_customer') }} h
    CROSS JOIN date_spine d
    WHERE d.date_day >= h.load_dts::DATE   -- parent existed on or before this snapshot
),

sat_pointers AS (
    SELECT
        s.customer_hk,
        hs.snapshot_dts,

        -- For each satellite: the load_dts of the current-as-of-snapshot row.
        MAX(CASE WHEN s.source = 'sat_customer_details' AND s.load_dts <= hs.snapshot_dts
                 THEN s.load_dts END) AS sat_customer_details_load_dts,

        MAX(CASE WHEN s.source = 'sat_customer_address' AND s.load_dts <= hs.snapshot_dts
                 THEN s.load_dts END) AS sat_customer_address_load_dts

    FROM hub_snapshots hs
    LEFT JOIN (
        SELECT customer_hk, load_dts, 'sat_customer_details' AS source FROM {{ ref('sat_customer_details') }}
        UNION ALL
        SELECT customer_hk, load_dts, 'sat_customer_address'  AS source FROM {{ ref('sat_customer_address') }}
    ) s USING (customer_hk)
    GROUP BY s.customer_hk, hs.snapshot_dts
)

SELECT * FROM sat_pointers
```

Cleaner (and faster on Snowflake / BigQuery) — use `QUALIFY ROW_NUMBER`
per satellite:

```sql
-- Alternative form: per-satellite as-of via QUALIFY, then join.
WITH snapshots AS (
    SELECT h.customer_hk, d.date_day::TIMESTAMP AS snapshot_dts
    FROM {{ ref('hub_customer') }} h
    CROSS JOIN date_spine d
    WHERE d.date_day >= h.load_dts::DATE
),
sat_details_asof AS (
    SELECT s.customer_hk, sn.snapshot_dts, s.load_dts AS sat_customer_details_load_dts
    FROM snapshots sn
    JOIN {{ ref('sat_customer_details') }} s USING (customer_hk)
    WHERE s.load_dts <= sn.snapshot_dts
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY sn.customer_hk, sn.snapshot_dts
        ORDER BY s.load_dts DESC
    ) = 1
),
sat_address_asof AS (
    SELECT s.customer_hk, sn.snapshot_dts, s.load_dts AS sat_customer_address_load_dts
    FROM snapshots sn
    JOIN {{ ref('sat_customer_address') }} s USING (customer_hk)
    WHERE s.load_dts <= sn.snapshot_dts
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY sn.customer_hk, sn.snapshot_dts
        ORDER BY s.load_dts DESC
    ) = 1
)

SELECT
    sn.customer_hk,
    sn.snapshot_dts,
    d.sat_customer_details_load_dts,
    a.sat_customer_address_load_dts
FROM snapshots sn
LEFT JOIN sat_details_asof d USING (customer_hk, snapshot_dts)
LEFT JOIN sat_address_asof a USING (customer_hk, snapshot_dts)
```

## Using a PIT from an Information Mart

```sql
-- models/information_marts/dim_customer.sql
SELECT
    pit.customer_hk,
    pit.snapshot_dts,
    d.first_name,
    d.last_name,
    d.email,
    a.address_line_1,
    a.city,
    a.postal_code
FROM {{ ref('pit_customer_daily') }} pit
LEFT JOIN {{ ref('sat_customer_details') }} d
    ON pit.customer_hk = d.customer_hk
   AND pit.sat_customer_details_load_dts = d.load_dts
LEFT JOIN {{ ref('sat_customer_address') }} a
    ON pit.customer_hk = a.customer_hk
   AND pit.sat_customer_address_load_dts = a.load_dts
WHERE pit.snapshot_dts = '2024-06-01'::TIMESTAMP
```

Two direct joins, no `MAX(...)`. Downstream this is ~10-100× faster
than repeatedly correlating on `load_dts` per satellite.

## Point-in-Time Cadence Choices

| Cadence | Use when | Trade-off |
|---------|----------|-----------|
| Daily | Most reporting; day-grain is fine | Manageable size; daily rebuild cost |
| Hourly | Ops dashboards, latency-sensitive marts | 24× the rows; consider incremental PIT builds |
| End-of-month | Monthly compliance / financial close | Smallest PIT; only useful for month-end reports |
| Continuous | Rare — approximates "always current" | Approaches the cost of not having a PIT |

Most projects have a daily PIT for the primary hubs and end-of-month
PITs for the ones that feed financial reporting.

## Snapshot Date Filtering — Ghost Row Interaction

If a hub has a ghost row (business key `'^^'`), the PIT should include
it — downstream `LEFT JOIN`s from facts to `dim_customer` land on the
ghost row when the customer is unknown, which is what you want.

If a hub had no data at snapshot date (satellite hadn't been loaded
yet), the `LEFT JOIN` from the mart returns NULLs. Handle with
`COALESCE` in the mart:
```sql
COALESCE(d.first_name, 'UNKNOWN') AS first_name
```

## Bridge Tables

A **bridge table** pre-computes multi-hop joins across the vault so
mart queries don't have to walk hub → link → hub → link → hub every
time.

Common use case: a fact wants to join to *all* the dimensional
attributes of a `hub_customer` reachable via `lnk_customer_account
→ hub_account → lnk_account_region → hub_region → sat_region_details`.
Instead of five joins in the mart, one bridge holds the pre-computed
paths.

### Bridge Structure

Bridges are per-scenario, not templated. Design each one for the
mart query it's serving. Columns typically include:

- One hash key per hub in the path.
- Optionally: the descriptive attributes commonly filtered on
  (e.g., `region_name` from `sat_region_details`).
- `snapshot_dts` if the bridge is point-in-time.

```sql
-- models/business_vault/bridges/bridge_customer_region_daily.sql
{{ config(materialized='table', tags=['business_vault', 'bridge']) }}

WITH date_spine AS (
    {{ dbt_utils.date_spine(
        datepart="day",
        start_date="cast('2020-01-01' as date)",
        end_date="cast(current_date as date)"
    ) }}
),

paths AS (
    SELECT
        lca.customer_hk,
        lar.region_hk,
        d.date_day::TIMESTAMP AS snapshot_dts
    FROM {{ ref('lnk_customer_account') }} lca
    JOIN {{ ref('lnk_account_region') }} lar USING (account_hk)
    CROSS JOIN date_spine d
    WHERE d.date_day >= GREATEST(lca.load_dts::DATE, lar.load_dts::DATE)
),

region_details AS (
    SELECT customer_hk, region_hk, snapshot_dts, sd.region_name, sd.region_code
    FROM paths p
    LEFT JOIN {{ ref('sat_region_details') }} sd
        ON p.region_hk = sd.region_hk
       AND sd.load_dts <= p.snapshot_dts
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY customer_hk, region_hk, snapshot_dts
        ORDER BY sd.load_dts DESC
    ) = 1
)

SELECT * FROM region_details
```

### PIT-Bridge Hybrid

Most production bridges are *point-in-time bridges* — a bridge PLUS
PIT semantics in one table. The example above is a PIT-bridge because
it has `snapshot_dts` and points at the correct satellite version.

### When Not to Build a Bridge

- The mart query is fast enough without one.
- The path involves fewer than three hub → link → hub hops.
- Volumes are small (< a few million rows in the fact).

Bridges have a maintenance cost — every change to the underlying
raw-vault structure requires a bridge rebuild, and every new mart
scenario tempts you to build a new bridge. Pay this cost only where
the query performance return justifies it.

## Rebuild vs. Incremental for PIT / Bridge

Both PITs and bridges are **derived tables**. Preferred build mode:

- **Small to medium** (up to a few 100M rows): `materialized='table'`,
  full rebuild every run. Simple, guaranteed correct.
- **Large** (billions of rows): `materialized='incremental'` on
  `snapshot_dts` — only new snapshot dates rebuild. Backfills require
  `--full-refresh`.

Never bother with `merge` — the correct row for a given
`(parent_hk, snapshot_dts)` is fully determined by the raw vault, so
overwriting is fine.

```jinja
{{ config(
    materialized='incremental',
    incremental_strategy='delete+insert',
    unique_key=['customer_hk', 'snapshot_dts'],
    tags=['business_vault', 'pit']
) }}

-- ... same SQL as above but:
{% if is_incremental() %}
WHERE snapshot_dts > (SELECT MAX(snapshot_dts) FROM {{ this }})
{% endif %}
```

`delete+insert` is fine here because the PIT is *not* raw vault —
it's a derived, disposable snapshot index. The insert-only rule
applies only to raw vault.

## AutomateDV Macros

AutomateDV provides `automate_dv.pit` for daily PITs. If AutomateDV
is already in the project, prefer:

```sql
{{ automate_dv.pit(
    src_pk="customer_hk",
    as_of_dates_table=ref('as_of_date'),
    satellites={
        'sat_customer_details': {
            'pk': 'customer_hk',
            'ldts': 'load_dts'
        },
        'sat_customer_address': {
            'pk': 'customer_hk',
            'ldts': 'load_dts'
        }
    },
    src_ldts="load_dts",
    source_model="hub_customer"
) }}
```

## Common PIT / Bridge Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| PIT built once, never refreshed | Grows stale; "as of today" queries return outdated rows | Schedule daily rebuild or incremental append |
| Snapshot dates before parent's `load_dts` | PIT row exists but `sat_*_load_dts` is NULL → mart returns empty rows | Filter `WHERE snapshot_dts >= parent.load_dts` |
| Using `INNER JOIN` from mart to satellite | Rows where satellite hasn't been loaded yet disappear | `LEFT JOIN` + `COALESCE` for defaults |
| Bridge that duplicates raw vault information (adds descriptive cols) | Every raw-vault change requires bridge rebuild | Keep bridge narrow: hash keys + snapshot_dts only; join to sats for attributes |
| PIT that snapshots too many satellites | PIT explodes; loses its performance advantage | One PIT per mart query pattern, not one PIT per hub |
| Materialized as `view` | Every mart query re-runs the PIT SQL → performance lost | `table` (small) or `incremental` (large) |
| Missing snapshot_dts index / cluster key | Mart filters `WHERE snapshot_dts = 'x'` do full scans | Cluster / partition by `snapshot_dts` |
