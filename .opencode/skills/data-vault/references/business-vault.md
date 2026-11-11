# Business Vault

The business vault (BV) is where business rules live. It sits on top
of the raw vault, contains hubs / links / satellites that are
*computed* rather than sourced, and preserves the insert-only + hashdiff
discipline of the raw vault while allowing derivations, deduplications,
and transformations that would violate raw-vault rules.

**Soft rules live here.** The business vault is the first layer of
the stack where soft rules are allowed — coalescing between candidate
values, deriving segments / tiers / scores, deduplicating "logically
equivalent" records. Anything the [hard-vs-soft-rules](hard-vs-soft-rules.md)
reference classifies as a soft rule can appear in a BV object
(computed sat, computed hub, computed link) but never in the raw vault.

## Ask the User First — BV Scope Decisions

Before adding any business-vault object, confirm:

- **Who owns the business rule?** A specific team, a specific
  role (finance controller, marketing lead)? Business rules
  without a named owner drift into folklore.
- **Does the rule need historization?** "Customer's current tier"
  needs history if reports ever ask "what was the tier last
  quarter?". If not, the rule belongs in the mart, not the BV.
- **How often does the rule itself change?** A "customer segment
  = ..." rule that ships every sprint should not be a hashed BV
  satellite; that's mart-layer volatility.
- **Is there an MDM system already computing similar logic?**
  If yes, load [mdm-integration.md](mdm-integration.md); do not
  reinvent MDM's work inside the vault.
- **Does the rule create identity (matches customer records)?
  Or just categorize existing identity?** Identity-creating rules
  are same-as / computed-hub territory; categorization is
  computed-satellite territory.

## When to Use a Business Vault vs. Going Straight to Information Mart

Two valid patterns:

**Pattern A — Raw Vault → Information Mart directly.** Business rules
applied at the mart layer, mart is `table` or `view`, rebuilt as
needed. Simplest.

**Pattern B — Raw Vault → Business Vault → Information Mart.** Business
rules applied in the BV, historized like the raw vault. Marts read
from the BV.

Prefer **A** unless one of these is true:

- **Multiple marts consume the same business-rule output.** E.g., the
  "loyalty tier" computation feeds three different marts. Compute
  once in the BV, read three times from marts.
- **The business rule itself needs to be historized.** E.g., "customer
  segment" is derived, but you need to answer "what segment was this
  customer on 2024-06-01?" The BV computed satellite gives you that
  history; the mart alone doesn't.
- **The business rule is expensive.** Complex ML scores, external API
  lookups, heavy joins. Cache the result in a BV satellite; marts
  join to it.

If none of those apply, skip the BV and put the logic in the mart.
Business vaults have a real maintenance cost.

## Business Vault Structure Types

### Computed Satellite

A satellite whose descriptive columns are *derived* from other vault
tables, not sourced. Same insert-only + hashdiff discipline.

```sql
-- models/business_vault/computed_satellites/bsat_customer_lifetime_metrics.sql
-- Business-vault satellite: computes lifetime metrics from raw vault.
{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key=['customer_hk', 'load_dts'],
    tags=['business_vault', 'computed_satellite']
) }}

WITH customer_orders AS (
    SELECT
        lc.customer_hk,
        COUNT(DISTINCT lc.order_hk)         AS lifetime_order_count,
        SUM(pd.amount_cents)                AS lifetime_amount_cents,
        MIN(sos.load_dts)                   AS first_order_dts,
        MAX(sos.load_dts)                   AS most_recent_order_dts
    FROM {{ ref('lnk_order_customer') }} lc
    LEFT JOIN {{ ref('sat_order_status') }} sos USING (order_hk)
    LEFT JOIN {{ ref('lnk_payment') }} lp USING (order_hk)
    LEFT JOIN {{ ref('sat_payment_details') }} pd USING (lnk_payment_hk)
    WHERE sos.status = 'PAID'
    GROUP BY lc.customer_hk
),

with_tier AS (
    SELECT
        customer_hk,
        lifetime_order_count,
        lifetime_amount_cents,
        first_order_dts,
        most_recent_order_dts,
        CASE
            WHEN lifetime_amount_cents >= 1000000 THEN 'PLATINUM'
            WHEN lifetime_amount_cents >= 500000  THEN 'GOLD'
            WHEN lifetime_amount_cents >= 100000  THEN 'SILVER'
            ELSE 'BRONZE'
        END AS loyalty_tier
    FROM customer_orders
),

hashed AS (
    SELECT
        customer_hk,
        {{ dv_hashdiff([
            'first_order_dts',
            'lifetime_amount_cents',
            'lifetime_order_count',
            'loyalty_tier',
            'most_recent_order_dts'
        ]) }}                                AS hashdiff,
        '{{ run_started_at }}'::TIMESTAMP    AS load_dts,
        'business_vault.customer_lifetime'   AS record_source,
        lifetime_order_count,
        lifetime_amount_cents,
        first_order_dts,
        most_recent_order_dts,
        loyalty_tier
    FROM with_tier
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

**Record source is `'business_vault.<derivation_name>'`** — makes it
traceable to the derivation that produced it, not to a source system.

### Computed Hub (rare)

A hub whose business key is *derived* from raw vault, not sourced.
Example: a "customer household" concept where multiple customer hash
keys collapse into one household key computed from address matching.

```sql
-- models/business_vault/computed_hubs/bhub_household.sql
{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key='household_hk',
    tags=['business_vault', 'computed_hub']
) }}

WITH households AS (
    -- Derived key: hash of the joint (postal_code, last_name) for adults in a household.
    SELECT
        {{ dv_hash_bk(['postal_code', 'last_name']) }}  AS household_hk,
        postal_code || '|' || last_name                 AS household_bk
    FROM {{ ref('sat_customer_pii') }} p
    JOIN {{ ref('sat_customer_address') }} a USING (customer_hk)
    GROUP BY postal_code, last_name
)

SELECT
    household_hk,
    household_bk,
    '{{ run_started_at }}'::TIMESTAMP   AS load_dts,
    'business_vault.household_derivation' AS record_source
FROM households
{% if is_incremental() %}
LEFT JOIN {{ this }} existing USING (household_hk)
WHERE existing.household_hk IS NULL
{% endif %}
```

Then a computed link `blnk_customer_household` connects each
customer to their derived household. This is heavy — most projects
don't need computed hubs. Add one only when downstream repeatedly
groups customers into the derived concept and the concept has enough
of its own attributes to warrant a hub.

### Computed Link

A link whose relationship is computed from raw-vault content, not
observed in source. Example: `blnk_customer_referrer` — inferred
from campaign-tracking data across multiple raw-vault tables.

Same shape as a raw-vault link, with `record_source` = a business
derivation name.

## Business Rules — Where They Go

| Rule type | Where |
|-----------|------|
| Normalize a name / address / email into a canonical form | Business vault: computed satellite |
| Deduplicate two customer records into one | Business vault: same-as link + computed hub for the "master" concept, or handle in information mart |
| Compute a derived metric (LTV, churn score) | Business vault: computed satellite |
| Filter out test data | Information mart (raw vault must keep the test data — audit) |
| Apply a currency conversion | Depends: if the conversion is historical and stable → BV; if it's real-time → mart |
| Categorize a free-text field | Business vault: computed satellite |
| Join multiple sources into one canonical entity | Business vault: computed satellite + same-as link |
| Restrict rows to a specific audience (compliance-visible only) | Information mart (never remove rows in the vault) |

**The dividing line:** does the transformation need to be historized
for downstream consumers to reason about "what was the derived value
on date X"? If yes, BV. If no, mart.

## Naming Conventions

Prefixes vary by shop; common patterns:

| Structure | Prefix | Example |
|-----------|--------|---------|
| Business vault hub | `bhub_` / `bh_` | `bhub_household` |
| Business vault link | `blnk_` / `bl_` | `blnk_customer_household` |
| Business vault satellite | `bsat_` / `bs_` | `bsat_customer_lifetime_metrics` |

Match whatever convention the project uses. If none is established,
the `b`-prefixed variants make it obvious at a glance that the model
is computed.

## Information Marts on Top of Business Vault

Information marts are the consumption layer — dimensions, facts,
OBT tables, or flat exports for BI / ML / apps. They read from PIT
+ bridge + satellites (raw or computed) and produce the shapes
downstream consumers actually query.

Same rules as any other mart (see `dbt-develop`'s layer-patterns
reference): `dim_`, `fct_`, `obt_` prefixes; `table` materialization;
business-friendly column names; NULL-defaulting on missing values.

The key architectural fact: marts *never* apply insert-only or
historization discipline. They are re-buildable snapshots on top of
the vault. If the mart is wrong, you rebuild it; you don't try to
patch history.

```sql
-- models/information_marts/finance/dim_customer.sql
{{ config(materialized='table', tags=['information_mart', 'finance']) }}

WITH latest_pii AS (
    SELECT customer_hk, first_name, last_name, email
    FROM {{ ref('sat_customer_pii') }}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_hk ORDER BY load_dts DESC) = 1
),
latest_addr AS (
    SELECT customer_hk, address_line_1, city, postal_code, country_code
    FROM {{ ref('sat_customer_address') }}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_hk ORDER BY load_dts DESC) = 1
),
latest_metrics AS (
    SELECT customer_hk, lifetime_amount_cents, loyalty_tier, most_recent_order_dts
    FROM {{ ref('bsat_customer_lifetime_metrics') }}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_hk ORDER BY load_dts DESC) = 1
)

SELECT
    h.customer_hk                                       AS customer_key,
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
    m.most_recent_order_dts
FROM {{ ref('hub_customer') }} h
LEFT JOIN latest_pii p     USING (customer_hk)
LEFT JOIN latest_addr a    USING (customer_hk)
LEFT JOIN latest_metrics m USING (customer_hk)
WHERE h.customer_bk <> '^^'    -- exclude ghost row from the mart
```

For as-of queries, join to the PIT instead:

```sql
SELECT
    pit.customer_hk,
    pit.snapshot_dts,
    p.first_name,
    p.last_name,
    ...
FROM {{ ref('pit_customer_daily') }} pit
LEFT JOIN {{ ref('sat_customer_pii') }} p
    ON pit.customer_hk = p.customer_hk
   AND pit.sat_customer_pii_load_dts = p.load_dts
LEFT JOIN {{ ref('bsat_customer_lifetime_metrics') }} m
    ON pit.customer_hk = m.customer_hk
   AND pit.bsat_customer_lifetime_metrics_load_dts = m.load_dts
```

## Common Business Vault Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Applying business rules in the raw vault | Vault no longer re-buildable byte-for-byte from source | Move to BV or mart |
| Business vault without historization | Loses the point of putting the rule in BV vs. mart | Insert-only + hashdiff, same as raw vault |
| Every derivation gets a BV table | Explodes model count; unused derivations rot | Add BV only when multiple marts need it or history is required |
| BV computed satellite reads from information mart | Circular dependency; DAG breaks | BV only reads from raw vault and other BV objects |
| BV `record_source` masquerades as a source-system name | Downstream can't tell derived from sourced | Use `'business_vault.<derivation>'` prefix |
| BV rewrites its input rather than layering | Loses raw-vault history; audit weakens | BV is *additive*; the raw vault still holds unmodified truth |
| Filtering `is_test = TRUE` rows in the BV | Compliance queries can't find them | Filter in the mart, not in BV — vault keeps everything |
