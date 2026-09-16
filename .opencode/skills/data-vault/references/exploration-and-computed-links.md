# Exploration Links, Computed Links, and Business-Vault Link Taxonomy

The [business-vault](business-vault.md) reference covers computed
satellites and computed hubs. This reference covers the complete
business-vault **link** taxonomy from the book — specific patterns
that give the business vault a stable vocabulary for cross-source
integration and analytical convenience.

## Business-Vault Link Types

The book identifies five distinct link patterns that live in the
business vault. Each solves a specific class of problem that the raw
vault can't solve without violating hard-rule discipline.

| Business-vault link | Purpose |
|---------------------|---------|
| **Exploration link** | Pre-computes multi-hop paths across raw vault for analytical query convenience |
| **Computed aggregation link** | Materializes a grouped-aggregation relationship (e.g., customer to their top-3 products) |
| **Computed same-as link** | Derives "these two business keys refer to the same entity" via a business rule |
| **Interface link (aka staged link)** | Bridges raw-vault hubs to reference data or external identifiers |
| **Business rule link** | Encodes a business-defined relationship not present in any source |

Each is insert-only, hashed, and historized with the standard DV
discipline. What makes them "business vault" is that the *content*
is derived, not sourced.

## Exploration Link

An exploration link **pre-computes multi-hop paths** so downstream
marts don't have to traverse hub → link → hub → link → hub every
time. Faster than doing the joins in the mart; cheaper than a full
bridge table when only the endpoints are needed.

**Example.** Customer → account → region path, pre-computed:

```sql
-- models/business_vault/computed_links/blnk_customer_region_exploration.sql
{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key='blnk_customer_region_hk',
    tags=['business_vault', 'computed_link', 'exploration']
) }}

WITH paths AS (
    SELECT DISTINCT
        lca.customer_hk,
        lar.region_hk
    FROM {{ ref('lnk_customer_account') }} lca
    JOIN {{ ref('lnk_account_region') }} lar USING (account_hk)
),

hashed AS (
    SELECT
        -- Compute a synthetic hash of the two endpoint hash keys
        {{ dv_hash_function() }}(customer_hk || '||' || region_hk) AS blnk_customer_region_hk,
        customer_hk,
        region_hk,
        '{{ run_started_at }}'::TIMESTAMP                          AS load_dts,
        'business_vault.customer_region_exploration'               AS record_source
    FROM paths
)

SELECT * FROM hashed
{% if is_incremental() %}
LEFT JOIN {{ this }} existing USING (blnk_customer_region_hk)
WHERE existing.blnk_customer_region_hk IS NULL
{% endif %}
```

Downstream mart:
```sql
-- Instead of 4-hop join through the raw vault:
SELECT c.customer_name, r.region_name
FROM {{ ref('sat_customer_pii') }} c
JOIN {{ ref('blnk_customer_region_exploration') }} blnk
    ON c.customer_hk = blnk.customer_hk
JOIN {{ ref('sat_region_details') }} r
    ON blnk.region_hk = r.region_hk
```

## Computed Aggregation Link

Materializes a **grouped or ranked** relationship — "customer's top-3
products by lifetime spend", "salesperson's most recent 5 accounts".
The relationship is derived, but the derivation is expensive
enough to justify pre-computing.

```sql
-- models/business_vault/computed_links/blnk_customer_top3_products.sql
{{ config(
    materialized='table',                       -- fully rebuilt on schedule
    tags=['business_vault', 'computed_link', 'aggregation']
) }}

WITH customer_product_spend AS (
    SELECT
        loc.customer_hk,
        lop.product_hk,
        SUM(pd.amount_cents) AS lifetime_spend_cents
    FROM {{ ref('lnk_order_customer') }} loc
    JOIN {{ ref('lnk_order_product') }} lop USING (order_hk)
    JOIN {{ ref('lnk_payment') }} lp        USING (order_hk)
    JOIN {{ ref('sat_payment_details') }} pd USING (lnk_payment_hk)
    GROUP BY loc.customer_hk, lop.product_hk
),

ranked AS (
    SELECT
        customer_hk,
        product_hk,
        lifetime_spend_cents,
        ROW_NUMBER() OVER (PARTITION BY customer_hk ORDER BY lifetime_spend_cents DESC, product_hk) AS rank
    FROM customer_product_spend
    QUALIFY rank <= 3
)

SELECT
    {{ dv_hash_function() }}(customer_hk || '||' || product_hk)  AS blnk_customer_top3_products_hk,
    customer_hk,
    product_hk,
    rank,
    lifetime_spend_cents,
    '{{ run_started_at }}'::TIMESTAMP                           AS load_dts,
    'business_vault.top3_products_derivation'                   AS record_source
FROM ranked
```

**Materialized as `table`** because the derivation is a snapshot —
recomputed on schedule. Not historized (each rebuild replaces
previous). If you need history ("who was in the top-3 as of Q1
2024?"), add a snapshot date to the primary key and switch to
`incremental`.

## Computed Same-As Link

The raw-vault [same-as link](link-patterns.md) records deduplication
decisions from an MDM source. The **computed** same-as link derives
those decisions from a business rule you apply on top of the raw
vault.

```sql
-- models/business_vault/computed_links/blnk_computed_same_as_customer.sql
-- Business rule: two customer records with matching email + last_name
-- are the same person.
{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key='blnk_computed_same_as_customer_hk',
    tags=['business_vault', 'computed_link', 'same_as']
) }}

WITH latest_pii AS (
    SELECT customer_hk, email, last_name
    FROM {{ ref('sat_customer_pii') }}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_hk ORDER BY load_dts DESC) = 1
),

matches AS (
    SELECT
        a.customer_hk       AS master_customer_hk,
        b.customer_hk       AS duplicate_customer_hk,
        'email+last_name'   AS match_method,
        'HIGH'              AS confidence
    FROM latest_pii a
    JOIN latest_pii b
        ON a.email = b.email
       AND a.last_name = b.last_name
       AND a.customer_hk < b.customer_hk       -- avoid self-match and duplicate pairs
    WHERE a.email IS NOT NULL AND a.last_name IS NOT NULL
),

hashed AS (
    SELECT
        {{ dv_hash_function() }}(master_customer_hk || '||' || duplicate_customer_hk)
            AS blnk_computed_same_as_customer_hk,
        master_customer_hk,
        duplicate_customer_hk,
        match_method,
        confidence,
        '{{ run_started_at }}'::TIMESTAMP AS load_dts,
        'business_vault.same_as_email_lastname' AS record_source
    FROM matches
)

SELECT * FROM hashed
{% if is_incremental() %}
LEFT JOIN {{ this }} existing USING (blnk_computed_same_as_customer_hk)
WHERE existing.blnk_computed_same_as_customer_hk IS NULL
{% endif %}
```

**Match method and confidence are payload on the link** — allowed
here because these attributes are part of the derived relationship's
identity (the derivation rule always produces these values for a
given pair).

If confidence changes over time (say, ML score refreshes), pull it
into a satellite off the link instead.

## Interface Link (Staged Link)

An interface link **bridges vault hubs to reference data or external
identifiers** without polluting the raw vault. Example: mapping
`hub_customer` to an external CRM ID that appeared *after* the vault
was built.

```sql
-- models/business_vault/computed_links/blnk_customer_external_crm.sql
{{ config(materialized='incremental', incremental_strategy='append',
         unique_key='blnk_customer_external_crm_hk',
         tags=['business_vault', 'interface_link']) }}

SELECT
    {{ dv_hash_function() }}(customer_hk || '||' || external_crm_id)
                                      AS blnk_customer_external_crm_hk,
    customer_hk,
    external_crm_id,
    '{{ run_started_at }}'::TIMESTAMP AS load_dts,
    'external.hubspot_mapping'        AS record_source
FROM {{ ref('stg_hubspot__customer_map__hashed') }}
```

Used when you can't add the external ID to `hub_customer` because
the mapping came later or is provisional. The interface link acts
as an "attached identifier" for downstream consumers.

## Business Rule Link

Encodes a relationship **the business defines but no source records**.
Example: `blnk_customer_recommended_products` — a business rule
that says "customers in segment X should be recommended products in
category Y". The rule produces (customer_hk, product_hk) pairs that
don't exist as observations in any source.

```sql
-- models/business_vault/computed_links/blnk_customer_recommended_products.sql
{{ config(materialized='table', tags=['business_vault', 'business_rule_link']) }}

WITH customer_segments AS (
    SELECT customer_hk, segment
    FROM {{ ref('bsat_customer_segment') }}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_hk ORDER BY load_dts DESC) = 1
),

products_by_category AS (
    SELECT product_hk, category
    FROM {{ ref('sat_product_catalog') }}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY product_hk ORDER BY load_dts DESC) = 1
),

segment_category_map AS (
    -- The business rule: which segments get which categories
    SELECT 'PREMIUM'   AS segment, 'LUXURY'    AS category UNION ALL
    SELECT 'PREMIUM',                'PREMIUM' UNION ALL
    SELECT 'STANDARD',               'CORE'    UNION ALL
    SELECT 'BUDGET',                 'CORE'    UNION ALL
    SELECT 'BUDGET',                 'BASIC'
),

recommendations AS (
    SELECT
        c.customer_hk,
        p.product_hk,
        c.segment,
        p.category
    FROM customer_segments c
    JOIN segment_category_map m ON c.segment = m.segment
    JOIN products_by_category p ON p.category = m.category
)

SELECT
    {{ dv_hash_function() }}(customer_hk || '||' || product_hk)
                                      AS blnk_customer_recommended_products_hk,
    customer_hk,
    product_hk,
    segment,
    category,
    '{{ run_started_at }}'::TIMESTAMP AS load_dts,
    'business_vault.segment_category_rule' AS record_source
FROM recommendations
```

If the rule table itself changes, historize it (business vault
sat off the rule structure) or rebuild the link. Business rule links
are typically `table` materializations because they're pure
derivations.

## Naming and Tagging Convention

| Structure | Prefix | Tag |
|-----------|--------|-----|
| Exploration link | `blnk_..._exploration` | `computed_link`, `exploration` |
| Computed aggregation link | `blnk_..._aggregation` or `blnk_..._top_N` | `computed_link`, `aggregation` |
| Computed same-as link | `blnk_computed_same_as_...` | `computed_link`, `same_as` |
| Interface link | `blnk_..._external_...` or `blnk_..._interface` | `interface_link` |
| Business rule link | `blnk_..._rule` or descriptive name | `business_rule_link` |

The `blnk_` prefix distinguishes business-vault links from raw-vault
`lnk_` links. Every business-vault link's `record_source` starts
with `business_vault.` for traceability.

## When to Use Which

| Need | Structure |
|------|-----------|
| "This 4-hop join is slow, cache the endpoints" | Exploration link |
| "Show me each customer's top-N products" | Computed aggregation link |
| "Deduplicate customer records via a matching rule" | Computed same-as link |
| "Map our vault keys to a partner system's IDs" | Interface link |
| "Business-defined relationship not in source (recommendations, quotas, allocations)" | Business rule link |
| "Same as above but the relationship's payload needs history" | Business rule link + satellite off it |

## Common Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Putting exploration links in the raw vault | Raw vault picks up business-vault-derived relationships; loses re-buildability from source | Business vault only |
| Missing the `business_vault.` prefix in `record_source` | Downstream can't distinguish derived from sourced rows | Enforce prefix convention |
| Computed aggregation link recomputed inconsistently (e.g., every load appends a top-3 snapshot without dedup) | Explosive growth of the link | Fully rebuild as `table` unless you need history |
| Same-as link (raw and computed) not consulted by marts | Deduplication rules are ignored; reports double-count | Marts always join through the same-as links |
| Business rule link with hardcoded rule table in SQL | Rule change requires code deploy | Rule table as a `dbt seed` or a reference table |
| Interface link where the external ID actually belongs on the hub | Missed opportunity to make the external ID a first-class BK | Add to hub if it's a stable business key; interface link only for provisional mappings |
