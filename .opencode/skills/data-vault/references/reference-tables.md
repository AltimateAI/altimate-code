# Reference Tables

Reference data — code lookups (country codes, currency codes, ISO
statuses), taxonomies, calendar tables — appears in every warehouse
but doesn't fit neatly into the hub/link/sat pattern. The book
defines a specific class of DV 2.0 structures for it.

## Why Reference Data Is Different

Reference data has three properties that make the standard hub /
sat pattern awkward:

1. **The "business key" is often the display value.** `US`, `CA`,
   `USD` — there's no separate surrogate; the code *is* what the
   business uses.
2. **Values are stable over long timespans.** A country code
   changes maybe once a decade.
3. **Referenced from everywhere.** Almost every fact and dimension
   in the mart wants to display the country name, currency symbol,
   status label.

Applying the full DV 2.0 discipline (hash key, sat, historization,
insert-only) to a static 250-row country table is over-engineering.
Skipping it entirely (using a raw source table directly from marts)
breaks the vault's discipline. The book's answer: **reference
tables** as a distinct third-class structure.

## The Three Reference Table Patterns

### 1. No-History Reference Table (most common)

A simple lookup table with the current values. Loaded via `MERGE` or
`INSERT OVERWRITE` — the exception to the "no updates in the vault"
rule, allowed because reference data is not historized.

```sql
-- models/raw_vault/reference/ref_country.sql
{{ config(
    materialized='table',                       -- full-refresh table
    tags=['raw_vault', 'reference', 'no_history']
) }}

SELECT
    country_code                                  AS country_code,      -- BK acts as PK; no hash needed
    country_name,
    iso_alpha_3,
    numeric_code,
    region,
    subregion,
    '{{ run_started_at }}'::TIMESTAMP             AS load_dts,
    'iso.country_codes'                           AS record_source
FROM {{ ref('stg_reference__iso_countries') }}
```

**Naming:** `ref_<concept>` (some shops use `r_<concept>`).
**PK:** the business key column directly (no `_hk` needed).
**Materialization:** `table` — rebuild on every load.

No hash key because there's no need for one — reference data is
small, doesn't need parallel loading, and downstream joins are on
the code itself.

**Downstream usage:**
```sql
-- In a mart:
SELECT f.*, r.country_name, r.region
FROM {{ ref('fct_orders') }} f
LEFT JOIN {{ ref('ref_country') }} r
    ON f.ship_country_code = r.country_code
```

### 2. Historized Reference Table (rare)

When reference data *does* change and history matters (currency
exchange rates by day, tax rates by jurisdiction and effective
date), use a hashed + historized reference structure that looks
like a hub + sat but is loaded together:

```sql
-- models/raw_vault/reference/ref_currency_rate.sql
{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key=['currency_pair_hk', 'load_dts'],
    tags=['raw_vault', 'reference', 'historized']
) }}

WITH source AS (
    SELECT
        from_currency,
        to_currency,
        rate,
        effective_date,
        '{{ run_started_at }}'::TIMESTAMP AS load_dts,
        'reference.exchange_rates'        AS record_source
    FROM {{ ref('stg_reference__currency_rates__hashed') }}
),

hashed AS (
    SELECT
        {{ dv_hash_bk(['from_currency', 'to_currency', 'effective_date']) }} AS currency_pair_hk,
        {{ dv_hashdiff(['rate']) }}                                          AS hashdiff,
        from_currency,
        to_currency,
        effective_date,
        rate,
        load_dts,
        record_source
    FROM source
),

{% if is_incremental() %}
latest_in_target AS (
    SELECT currency_pair_hk, hashdiff AS latest_hashdiff
    FROM {{ this }}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY currency_pair_hk ORDER BY load_dts DESC) = 1
),
{% endif %}

to_load AS (
    SELECT h.*
    FROM hashed h
    {% if is_incremental() %}
    LEFT JOIN latest_in_target l USING (currency_pair_hk)
    WHERE l.currency_pair_hk IS NULL OR l.latest_hashdiff <> h.hashdiff
    {% endif %}
)

SELECT * FROM to_load
```

**Naming:** `ref_<concept>` still.
**Includes:** hash key, hashdiff, load metadata, insert-only.
**Materialization:** `incremental`.

Historized reference is essentially "a hub + sat but the reference
concept is small and self-contained".

### 3. Code Hub + Sat (when references are truly first-class)

For reference concepts that are large, connected to other business
concepts via links, or actively described (e.g., "product category"
where categories have their own hierarchy and attributes), model as
a normal hub + sat:

```sql
hub_product_category
sat_product_category_details
lnk_product_category_hierarchy    -- self-referencing for parent-of
sat_lnk_product_category_hierarchy_effectivity
```

Not "reference tables" in the strict sense; they're just hubs
about a smallish domain concept.

## Decision Table — Which Pattern?

| Reference concept has... | Use |
|---------------------------|-----|
| < a few thousand rows, stable, no history needed, referenced from marts only | No-history reference table |
| Changes matter (e.g., historical exchange rates, tax rates by date) | Historized reference table |
| Independent business meaning, hierarchies, links to other concepts | Full hub + sat (not really "reference") |
| Loaded from an external maintained list (ISO codes, Snowflake share) | No-history reference table + document the source |

## Common Reference Data Sources

| Reference | Source | Update cadence |
|-----------|--------|----------------|
| ISO country codes | ISO 3166-1 (static list) | Rare |
| ISO currency codes | ISO 4217 (static list) | Rare |
| Currency exchange rates | ECB, XE, OpenExchangeRates API | Daily |
| Time zones | IANA TZ database | Occasional |
| Postal codes | National postal services | Monthly-ish |
| Industry classifications | NAICS, SIC (government) | Every few years |
| Product categories | Internal MDM | Continuous |
| Calendar / date dimension | Generated | Once |

For static references, load once via `dbt seed` or a one-off ingestion
job; you don't need incremental logic. For API-sourced references,
schedule a daily refresh.

## Reference Tables from a Link's Perspective

A link that involves a reference concept has two options:

**Option A — hash the reference code as if it were a hub key.**
This works if you're OK with the reference "hub" being a virtual
concept:
```sql
-- lnk_customer_country
{{ dv_hash_bk(['customer_id', 'country_code']) }} AS lnk_customer_country_hk,
{{ dv_hash_bk(['customer_id']) }}                 AS customer_hk,
{{ dv_hash_bk(['country_code']) }}                AS country_hk,   -- computed but no hub_country exists
```

**Option B — store the reference code directly on the link, no
link at all.** Just a foreign-key column on the fact/dim in the mart:
```sql
-- fct_customer_activity (mart)
SELECT
    customer_hk,
    country_code                                -- direct FK to ref_country
FROM ...
```

**Option A** if the reference concept is queried like other hubs
(you want to `dbt run --select +country`). **Option B** if the
reference is purely a lookup with no further vault relevance —
skip the link, join in mart. Book prefers Option B for pure
lookup / display references.

## Calendar / Date Reference

Almost every project needs a calendar reference table for the
information mart layer (day-level granularity, week, month, quarter,
year, holiday flags, fiscal periods).

```sql
-- models/raw_vault/reference/ref_calendar.sql
{{ config(materialized='table', tags=['raw_vault', 'reference', 'calendar']) }}

WITH date_spine AS (
    {{ dbt_utils.date_spine(
        datepart="day",
        start_date="cast('2000-01-01' as date)",
        end_date="cast('2050-12-31' as date)"
    ) }}
)

SELECT
    date_day                                  AS date_key,
    date_day,
    EXTRACT(year FROM date_day)               AS year,
    EXTRACT(quarter FROM date_day)            AS quarter,
    EXTRACT(month FROM date_day)              AS month_of_year,
    TO_CHAR(date_day, 'MON')                  AS month_name_short,
    TO_CHAR(date_day, 'Month')                AS month_name,
    EXTRACT(week FROM date_day)               AS week_of_year,
    EXTRACT(dayofweek FROM date_day)          AS day_of_week,
    TO_CHAR(date_day, 'DY')                   AS day_name_short,
    CASE WHEN EXTRACT(dayofweek FROM date_day) IN (0, 6) THEN TRUE ELSE FALSE END
                                              AS is_weekend,
    -- Fiscal calendar
    CASE WHEN EXTRACT(month FROM date_day) >= 7 THEN EXTRACT(year FROM date_day) + 1
         ELSE EXTRACT(year FROM date_day) END AS fiscal_year,
    -- ... additional attributes as needed
    '{{ run_started_at }}'::TIMESTAMP         AS load_dts,
    'system.calendar_generation'              AS record_source
FROM date_spine
```

Rebuild only when the definition changes (e.g., add a new holiday
column). Otherwise refresh isn't needed.

## Common Reference-Table Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Full hub + sat for a static 250-row country list | Over-engineered; joins pointlessly through hash | No-history reference table |
| No-history reference table for data that actually changes (exchange rates) | Rate history unrecoverable | Historized reference or store rate as satellite of a `hub_currency_pair` |
| Mart joins directly to raw source instead of `ref_*` | Vault discipline broken; source rename breaks marts | Every mart lookup goes through a `ref_*` table |
| Reference table without `load_dts` / `record_source` | Can't audit "when did this list refresh" | Include load metadata even on no-history refs |
| Calendar generated inside every mart | Duplicate calendars diverge | One `ref_calendar` shared across all marts |
| Loading reference data via manual `INSERT` in a migration file | Not repeatable in dev environments | `dbt seed` or a proper model |
| `MERGE` on a historized reference table | History collapsed | Historized ref uses insert-only + hashdiff, like a satellite |
| Reference table for concept that should be a real hub (product categories with hierarchy + descriptions) | Loses the ability to link, historize richly | Use hub + sat when the concept has independent life |
