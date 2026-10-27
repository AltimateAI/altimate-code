# Information Marts

Information marts are the consumption layer of Data Vault 2.0. They
sit on top of the raw vault + business vault + PIT/bridge tables
and produce the shapes that downstream consumers (BI tools, apps,
ML pipelines, exports) actually query.

The book classifies marts into distinct **archetypes** based on
consumer needs. Understanding the archetypes prevents the common
trap of "one mart per report" (which turns into hundreds of
near-duplicate models).

## The Mart Archetypes

| Archetype | Purpose | Shape |
|-----------|---------|-------|
| **Dimensional mart** | Kimball-style star schema for BI tools | `dim_*`, `fct_*` |
| **Aggregated mart** | Pre-computed metrics at specific grains | `agg_daily_revenue`, `agg_monthly_customer_stats` |
| **Flat / OBT mart** | Denormalized wide table for exploratory BI or ML | `obt_*` |
| **Exploration mart** | Ad-hoc query surface — thin views over PIT/bridge | `exp_*` (usually `view`) |
| **Error mart** | Load-time rejections (see [metrics-and-error-vault.md](metrics-and-error-vault.md)) | `err_*` |
| **Metrics mart** | Operational metrics on top of metrics vault | `mm_*` |
| **Application mart** | Purpose-built for a specific consuming app | `app_*` |

Most projects have all seven. The information mart layer is where
DV 2.0 stops being "the vault" and starts serving the business.

## Dimensional Mart (Star Schema)

The classic Kimball star schema built on top of the vault. `dim_*`
tables come from hubs + satellites (via PITs); `fct_*` tables come
from links + satellites (via PIT-bridges).

### Dimensional table pattern

```sql
-- models/information_marts/finance/dim_customer.sql
{{ config(materialized='table', tags=['information_mart', 'finance', 'dimension']) }}

WITH pit AS (
    SELECT * FROM {{ ref('pit_customer_daily') }}
    WHERE snapshot_dts = CURRENT_DATE
),

pii AS (
    SELECT customer_hk, load_dts, first_name, last_name, email
    FROM {{ ref('sat_customer_pii') }}
),

addr AS (
    SELECT customer_hk, load_dts, address_line_1, city, postal_code, country_code
    FROM {{ ref('sat_customer_address') }}
),

metrics AS (
    SELECT customer_hk, load_dts, lifetime_amount_cents, loyalty_tier
    FROM {{ ref('bsat_customer_lifetime_metrics') }}
),

hub AS (
    SELECT customer_hk, customer_bk FROM {{ ref('hub_customer') }}
)

SELECT
    h.customer_hk                                       AS customer_key,     -- surrogate for the mart
    h.customer_bk                                       AS customer_business_key,
    p.first_name,
    p.last_name,
    p.email,
    a.address_line_1,
    a.city,
    a.postal_code,
    a.country_code,
    COALESCE(m.lifetime_amount_cents, 0) / 100.0        AS lifetime_amount_usd,
    COALESCE(m.loyalty_tier, 'BRONZE')                  AS loyalty_tier,
    pit.snapshot_dts                                    AS as_of_date
FROM pit
JOIN hub h USING (customer_hk)
LEFT JOIN pii p
    ON pit.customer_hk = p.customer_hk
   AND pit.sat_customer_pii_load_dts = p.load_dts
LEFT JOIN addr a
    ON pit.customer_hk = a.customer_hk
   AND pit.sat_customer_address_load_dts = a.load_dts
LEFT JOIN metrics m
    ON pit.customer_hk = m.customer_hk
   AND pit.bsat_customer_lifetime_metrics_load_dts = m.load_dts
WHERE h.customer_bk <> '^^'                             -- exclude ghost row from user-facing dim
```

**Rules:**
- The mart uses the hash key as the surrogate — no re-surrogating.
- Every satellite is joined via the PIT to guarantee point-in-time
  consistency across satellites.
- Ghost row excluded from user-facing rows (but kept in the vault
  for FK resolution).
- `COALESCE` for defaults happens *here* in the mart (soft rule).

### Fact table pattern

```sql
-- models/information_marts/finance/fct_orders.sql
{{ config(materialized='table', tags=['information_mart', 'finance', 'fact']) }}

SELECT
    -- Fact PK
    loc.lnk_order_customer_hk                           AS order_key,
    -- Dim FKs
    loc.customer_hk                                     AS customer_key,
    lop.product_hk                                      AS product_key,
    -- Degenerate dimensions
    hos.order_bk                                        AS order_number,
    -- Measures
    sod.quantity,
    sod.unit_price_cents / 100.0                        AS unit_price_usd,
    sod.quantity * sod.unit_price_cents / 100.0         AS line_amount_usd,
    -- Timestamps
    sos.order_placed_at
FROM {{ ref('lnk_order_customer') }} loc
JOIN {{ ref('lnk_order_product') }} lop USING (order_hk)
JOIN {{ ref('sat_order_line_details') }} sod ON sod.lnk_order_line_hk = lop.lnk_order_line_hk
    AND sod.load_dts = (SELECT MAX(load_dts) FROM {{ ref('sat_order_line_details') }} WHERE lnk_order_line_hk = sod.lnk_order_line_hk)
JOIN {{ ref('sat_order_status') }} sos ON sos.order_hk = loc.order_hk
    AND sos.load_dts = (SELECT MAX(load_dts) FROM {{ ref('sat_order_status') }} WHERE order_hk = sos.order_hk)
JOIN {{ ref('hub_order') }} hos ON hos.order_hk = loc.order_hk
```

(A well-built PIT would replace the `MAX(load_dts)` subqueries with
direct joins.)

## Aggregated Mart

Pre-computed metrics at business-relevant grains — daily revenue
by region, monthly customer counts. Sits between the raw mart and
the BI tool for query performance.

```sql
-- models/information_marts/finance/agg_daily_revenue_by_region.sql
{{ config(materialized='table', tags=['information_mart', 'aggregated']) }}

SELECT
    DATE_TRUNC('day', f.order_placed_at)  AS revenue_date,
    r.region_name,
    COUNT(DISTINCT f.order_key)           AS order_count,
    SUM(f.line_amount_usd)                AS gross_revenue_usd,
    COUNT(DISTINCT f.customer_key)        AS unique_customers
FROM {{ ref('fct_orders') }} f
LEFT JOIN {{ ref('dim_customer') }} c ON f.customer_key = c.customer_key
LEFT JOIN {{ ref('ref_country') }} co ON c.country_code = co.country_code
LEFT JOIN {{ ref('ref_region') }} r   ON co.region = r.region_code
GROUP BY 1, 2
```

**Rebuild strategy:** typically `incremental` on `revenue_date` for
large facts, with `--full-refresh` when the underlying aggregation
logic changes.

## Flat / OBT Mart

One denormalized wide table combining a fact and its dimensions.
Best for exploratory BI (Tableau, Looker) and ML feature stores.

```sql
-- models/information_marts/exploration/obt_orders.sql
{{ config(materialized='table', tags=['information_mart', 'obt']) }}

SELECT
    f.*,
    c.first_name        AS customer_first_name,
    c.last_name         AS customer_last_name,
    c.email             AS customer_email,
    c.loyalty_tier      AS customer_loyalty_tier,
    c.country_code      AS customer_country,
    p.product_name,
    p.category          AS product_category,
    d.year, d.quarter, d.month_of_year, d.day_of_week, d.is_weekend
FROM {{ ref('fct_orders') }} f
LEFT JOIN {{ ref('dim_customer') }} c ON f.customer_key = c.customer_key
LEFT JOIN {{ ref('dim_product') }} p  ON f.product_key = p.product_key
LEFT JOIN {{ ref('ref_calendar') }} d ON DATE_TRUNC('day', f.order_placed_at) = d.date_day
```

## Exploration Mart (Virtualized)

Thin `view`s over PIT / bridge / satellites that let analysts query
the vault without knowing the vault's structure. Fast to add, no
storage cost.

```sql
-- models/information_marts/exploration/exp_customer_360.sql
{{ config(materialized='view', tags=['information_mart', 'exploration']) }}

SELECT
    h.customer_bk        AS customer_id,
    p.first_name,
    p.last_name,
    p.email,
    a.address_line_1,
    a.city,
    m.lifetime_amount_cents / 100.0    AS lifetime_amount_usd,
    m.loyalty_tier,
    -- Every reachable satellite for a customer joined in
    ...
FROM {{ ref('hub_customer') }} h
LEFT JOIN {{ ref('sat_customer_pii') }} p ON p.customer_hk = h.customer_hk
    AND p.load_dts = (SELECT MAX(load_dts) FROM {{ ref('sat_customer_pii') }} WHERE customer_hk = h.customer_hk)
...
```

Trade-off: virtualized marts are cheap to build but expensive to
query. Use for prototyping; promote to materialized (`table`) when
the query pattern stabilizes.

## Metrics Mart

Human-readable operational metrics on top of the metrics vault (see
[metrics-and-error-vault.md](metrics-and-error-vault.md)).

```sql
-- models/information_marts/ops/mm_recent_loads.sql
{{ config(materialized='view', tags=['information_mart', 'ops']) }}

SELECT
    hf.feed_bk               AS feed_name,
    hb.load_batch_bk         AS batch_id,
    s.load_dts               AS batch_dts,
    s.rows_read,
    s.rows_loaded_sat,
    s.rows_rejected,
    s.duration_seconds,
    CASE
        WHEN s.rows_rejected > 0.05 * s.rows_read THEN 'DEGRADED'
        WHEN s.duration_seconds > 300              THEN 'SLOW'
        ELSE 'HEALTHY'
    END AS load_health
FROM {{ ref('sat_lnk_load_batch_feed_metrics') }} s
JOIN {{ ref('lnk_load_batch_feed') }} l USING (lnk_load_batch_feed_hk)
JOIN {{ ref('hub_load_batch') }} hb USING (load_batch_hk)
JOIN {{ ref('hub_data_feed') }} hf  USING (feed_hk)
WHERE s.load_dts >= CURRENT_TIMESTAMP - INTERVAL '30 days'
QUALIFY ROW_NUMBER() OVER (PARTITION BY hf.feed_bk, hb.load_batch_bk ORDER BY s.load_dts DESC) = 1
```

## Application Mart

Purpose-built for a single consuming application (embedded analytics,
a partner API, a Reverse ETL pipeline). Shape driven by the consumer.

```sql
-- models/information_marts/app/app_partner_export.sql
{{ config(materialized='table', tags=['information_mart', 'application']) }}

SELECT
    hub.customer_bk                          AS partner_customer_id,
    pii.first_name || ' ' || pii.last_name   AS full_name,
    pii.email,
    LOWER(addr.country_code)                 AS country,
    metrics.loyalty_tier
FROM {{ ref('hub_customer') }} hub
LEFT JOIN ... -- as above
WHERE hub.customer_bk <> '^^'
  AND EXISTS (SELECT 1 FROM {{ ref('lnk_customer_partner') }} lcp
              WHERE lcp.customer_hk = hub.customer_hk AND lcp.partner_id = 'PARTNER_A')
```

Application marts often have consumer-specific naming (`partner_customer_id`
not `customer_bk`), embedded business rules, and denormalized shapes
for direct API consumption.

## Virtualization vs. Materialization

For every mart, choose:

- **`view`** — cheap to build, expensive to query. Best for:
  - Prototypes / new marts still being validated.
  - Low-query-volume exploration marts.
  - Simple pass-throughs from PIT with minimal transformation.
- **`table`** — one-time build cost, cheap to query. Best for:
  - Production dimensional/fact marts.
  - Marts queried by BI tools continuously.
  - Marts with expensive aggregations.
- **`incremental`** — best of both when the mart is large and only
  new data changes. Requires an incremental key (usually a date).

Book recommends starting with `view` for new marts (fast to iterate),
promoting to `table` when the query pattern is stable, and
promoting to `incremental` when the size makes full rebuild
expensive.

## Naming and Layering

```
models/information_marts/
├── finance/
│   ├── dim_customer.sql
│   ├── dim_product.sql
│   ├── fct_orders.sql
│   ├── fct_payments.sql
│   └── agg_daily_revenue_by_region.sql
├── operations/
│   └── mm_recent_loads.sql
├── exploration/
│   ├── obt_orders.sql
│   └── exp_customer_360.sql
├── error/
│   └── err_load_rejections.sql
└── app/
    └── app_partner_export.sql
```

**Organize by consumer domain, not by table type.** `finance/` holds
all finance-facing marts regardless of whether they're `dim`, `fct`,
or `agg`.

## Mart-Level Business Rules

Every soft rule that didn't need business-vault historization lives
in the mart:

- Filtering out `is_test = TRUE` customers.
- Coalescing default values for display.
- Applying currency conversions with a chosen rate.
- Filtering rows by permission / audience.
- Formatting for display.

If the mart's query gets long and repetitive, refactor common
transformations into `intermediate/` models — but never let the
intermediate flow back into the raw vault.

## Common Information Mart Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| One mart per report | Hundreds of near-duplicate models; changes ripple everywhere | Mart per business area; reports built on marts, not vice versa |
| Marts reading raw sources directly | Vault discipline broken; mart bypasses hard-rule checks | Mart only reads from vault (raw + business + PIT/bridge/ref) |
| No PIT — every mart re-computes `MAX(load_dts)` | Slow BI queries | Build a PIT per commonly-queried hub |
| Ghost row visible in user-facing dim | User sees a customer named "^^" | Mart filters `WHERE h.<entity>_bk <> '^^'` |
| Materializing every mart as `table` | Slow initial builds; wasted storage on exploratory marts | Choose `view` / `table` / `incremental` per mart based on usage |
| Materializing every mart as `view` | BI queries slow; each query redoes vault-scale joins | Promote to `table` once query pattern stabilizes |
| Re-surrogating (`ROW_NUMBER()` to create surrogate keys in the mart) | Loss of stable key across mart rebuilds; downstream joins break | Use the hash key from the vault as the mart's surrogate |
| Aggregation mart's grain not documented | Downstream misuses; wrong totals | `_models.yml` explicitly states the grain |
| Soft rules leaked back into vault via mart-influenced staging changes | Vault contaminated | Mart consumes vault; vault never reads from mart |
| Missing `record_source` traceability in mart rows | Can't answer "where did this come from" from a user report | Include a `data_lineage` column or expose vault hash keys in the mart |
