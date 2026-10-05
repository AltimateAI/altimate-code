# Satellite Patterns

Satellites are where DV 2.0's historization discipline lives. Every
correctness property — auditability, re-runnability, change detection
— depends on insert-only + hashdiff working together.

**Hard rules only in raw-vault satellites.** Descriptive columns are
loaded as-they-arrive: no coalescing between candidate values, no
filtering, no deriving new columns from existing ones. Those are
soft rules and belong in a computed (business-vault) satellite or
information mart. See [hard-vs-soft-rules.md](hard-vs-soft-rules.md).

## The Standard Satellite

One row per parent hash key per *change*. A new row inserts only when
the hashdiff over the descriptive columns differs from the most
recent row for that parent.

```sql
-- models/raw_vault/satellites/sat_customer_details.sql
{{ config(
    materialized='incremental',
    unique_key=['customer_hk', 'load_dts'],
    on_schema_change='fail',
    tags=['raw_vault', 'satellite']
) }}

WITH source_current AS (
    SELECT
        customer_id,
        first_name,
        last_name,
        email,
        phone,
        address_line_1,
        address_line_2,
        city,
        postal_code,
        country_code,
        '{{ run_started_at }}'::TIMESTAMP AS load_dts,
        'crm.customers'                   AS record_source
    FROM {{ ref('stg_crm__customers') }}
    WHERE customer_id IS NOT NULL
),

hashed AS (
    SELECT
        {{ dv_hash_bk(['customer_id']) }} AS customer_hk,

        -- Hashdiff over descriptive columns, alphabetized inside dv_hashdiff.
        {{ dv_hashdiff([
            'address_line_1',
            'address_line_2',
            'city',
            'country_code',
            'email',
            'first_name',
            'last_name',
            'phone',
            'postal_code'
        ]) }} AS hashdiff,

        load_dts,
        record_source,

        first_name,
        last_name,
        email,
        phone,
        address_line_1,
        address_line_2,
        city,
        postal_code,
        country_code
    FROM source_current
    -- Source-side dedup: if the source feed contains multiple identical rows
    -- for the same business key in one batch, keep exactly one so the
    -- satellite PK (parent_hk, load_dts) stays unique. Without this, a
    -- duplicated source row breaks the satellite's uniqueness invariant.
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY {{ dv_hash_bk(['customer_id']) }}, load_dts,
                     {{ dv_hashdiff(['address_line_1', 'address_line_2', 'city',
                                     'country_code', 'email', 'first_name',
                                     'last_name', 'phone', 'postal_code']) }}
        ORDER BY record_source
    ) = 1
),

{% if is_incremental() %}
latest_in_target AS (
    -- Newest hashdiff we already have for each parent.
    SELECT customer_hk, hashdiff AS latest_hashdiff
    FROM {{ this }}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_hk ORDER BY load_dts DESC) = 1
),
{% endif %}

to_load AS (
    SELECT h.*
    FROM hashed h
    {% if is_incremental() %}
    LEFT JOIN latest_in_target l ON h.customer_hk = l.customer_hk
    WHERE l.customer_hk IS NULL                  -- new parent
       OR l.latest_hashdiff <> h.hashdiff        -- payload changed
    {% endif %}
)

SELECT * FROM to_load
```

### Why every step is required

- **`WHERE customer_id IS NOT NULL`** — no orphan satellite rows.
- **`dv_hash_bk` + `dv_hashdiff` macros**, never inline — normalization
  must be identical to the hub.
- **Alphabetized column list inside `dv_hashdiff`** — deterministic
  hashdiff regardless of `SELECT` order.
- **`latest_in_target` CTE with `QUALIFY ROW_NUMBER() = 1`** — the
  correct definition of "current row" is *the newest load_dts*, not
  the newest source `updated_at`.
- **`LEFT JOIN ... WHERE l.hashdiff IS NULL OR ... <> h.hashdiff`** —
  loads the row when either it's a new parent (never seen) or the
  payload changed. This is the change-detection primitive.

## Multi-Active Satellite

A satellite where the parent hash key can have *multiple concurrent*
rows at the same load_dts — used for one-to-many attributes that
don't have their own business key. Examples: a customer's multiple
phone numbers, a product's multiple tags, a person's multiple
citizenships.

The primary key is `(parent_hk, load_dts, sub_sequence)`. Every load
inserts *all* current sub-sequences for a parent when *any* sub-
sequence changes (the parent is the change unit, not each sub-row).

```sql
-- models/raw_vault/satellites/sat_customer_phones_multi.sql
{{ config(
    materialized='incremental',
    unique_key=['customer_hk', 'load_dts', 'sub_sequence'],
    on_schema_change='fail',
    tags=['raw_vault', 'satellite', 'multi_active']
) }}

WITH source_phones AS (
    SELECT
        customer_id,
        phone_number,
        phone_type,
        '{{ run_started_at }}'::TIMESTAMP AS load_dts,
        'crm.customer_phones'             AS record_source
    FROM {{ ref('stg_crm__customer_phones') }}
    WHERE customer_id IS NOT NULL
      AND phone_number IS NOT NULL
),

sequenced AS (
    SELECT
        customer_id,
        phone_number,
        phone_type,
        load_dts,
        record_source,
        -- sub_sequence: deterministic ordering within a parent.
        -- Sort by every column so re-loads produce identical sequences.
        ROW_NUMBER() OVER (
            PARTITION BY customer_id
            ORDER BY phone_type, phone_number
        ) AS sub_sequence
    FROM source_phones
),

hashed AS (
    SELECT
        {{ dv_hash_bk(['customer_id']) }} AS customer_hk,
        sub_sequence,

        -- Parent-level hashdiff: hash over the CONCATENATED SET of all
        -- sub-rows for the parent. Any change to any sub-row changes
        -- the parent's hashdiff.
        {{ dv_hash_function() }}(
            LISTAGG(
                COALESCE(NULLIF(UPPER(TRIM(CAST(phone_number AS VARCHAR))), ''), '^^') || '||' ||
                COALESCE(NULLIF(UPPER(TRIM(CAST(phone_type   AS VARCHAR))), ''), '^^'),
                '::'
            ) WITHIN GROUP (ORDER BY sub_sequence)
              OVER (PARTITION BY customer_id)
        ) AS hashdiff,

        load_dts,
        record_source,
        phone_number,
        phone_type
    FROM sequenced
),

{% if is_incremental() %}
latest_in_target AS (
    SELECT customer_hk, hashdiff AS latest_hashdiff
    FROM {{ this }}
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY customer_hk
        ORDER BY load_dts DESC, sub_sequence
    ) = 1
),
{% endif %}

to_load AS (
    SELECT h.*
    FROM hashed h
    {% if is_incremental() %}
    LEFT JOIN latest_in_target l ON h.customer_hk = l.customer_hk
    WHERE l.customer_hk IS NULL
       OR l.latest_hashdiff <> h.hashdiff
    {% endif %}
)

SELECT * FROM to_load
```

**The parent's hashdiff is computed over the *concatenation* of all
sub-rows.** Any change to any sub-row changes the parent hashdiff and
inserts the entire new set. The old set stays in the satellite,
identified by its earlier `load_dts`.

**Dialect note:** LISTAGG syntax varies. Snowflake, Oracle, and
Redshift support `LISTAGG(...) WITHIN GROUP (ORDER BY ...)`.
BigQuery: `STRING_AGG(... ORDER BY ...)`. PostgreSQL:
`STRING_AGG(..., '::' ORDER BY ...)`. Databricks: `concat_ws('::',
collect_list(...))` — but `collect_list` isn't order-preserving, so
sort within a subquery first.

## Effectivity Satellite

Tracks when a link relationship is effective vs. ended. Two dates:
`effective_from` and `effective_to`. Enables temporal queries like
"who was the account manager for customer X on 2024-06-01?"

```sql
-- models/raw_vault/satellites/eff_customer_account_manager.sql
-- Effectivity for the link lnk_customer_account_manager.
{{ config(
    materialized='incremental',
    unique_key=['lnk_customer_account_manager_hk', 'load_dts'],
    on_schema_change='fail',
    tags=['raw_vault', 'satellite', 'effectivity']
) }}

WITH source_current AS (
    -- The source's current view of "who is the AM for this customer".
    SELECT
        customer_id,
        account_manager_id,
        assigned_at,
        '{{ run_started_at }}'::TIMESTAMP AS load_dts,
        'crm.assignments'                 AS record_source
    FROM {{ ref('stg_crm__assignments') }}
    WHERE assignment_status = 'ACTIVE'    -- (business-vault filter — often lifted here for effectivity)
),

hashed AS (
    SELECT
        {{ dv_hash_bk(['customer_id', 'account_manager_id']) }} AS lnk_customer_account_manager_hk,
        {{ dv_hash_bk(['customer_id']) }}                       AS customer_hk,
        {{ dv_hash_bk(['account_manager_id']) }}                AS account_manager_hk,

        assigned_at                                             AS effective_from,
        CAST('9999-12-31' AS DATE)                              AS effective_to,   -- open interval
        load_dts,
        record_source
    FROM source_current
),

-- Two events populate an effectivity satellite:
--   1. New link relationship observed → open interval (effective_from, 9999-12-31)
--   2. Previously-observed relationship no longer in source → close previous interval
-- Standard AutomateDV effectivity_sat macro does this in two passes; hand-rolled below:

open_intervals AS (
    SELECT h.*
    FROM hashed h
    {% if is_incremental() %}
    LEFT JOIN {{ this }} existing
      ON h.lnk_customer_account_manager_hk = existing.lnk_customer_account_manager_hk
     AND existing.effective_to = CAST('9999-12-31' AS DATE)
    WHERE existing.lnk_customer_account_manager_hk IS NULL
    {% endif %}
),

{% if is_incremental() %}
close_intervals AS (
    -- Any currently-open interval whose relationship is no longer in the source
    -- gets a new row with effective_to = load_dts (closing the interval).
    SELECT
        existing.lnk_customer_account_manager_hk,
        existing.customer_hk,
        existing.account_manager_hk,
        existing.effective_from,
        '{{ run_started_at }}'::TIMESTAMP    AS effective_to,
        '{{ run_started_at }}'::TIMESTAMP    AS load_dts,
        'system.effectivity_close'           AS record_source
    FROM {{ this }} existing
    LEFT JOIN hashed h USING (lnk_customer_account_manager_hk)
    WHERE existing.effective_to = CAST('9999-12-31' AS DATE)
      AND h.lnk_customer_account_manager_hk IS NULL
),
{% endif %}

combined AS (
    SELECT * FROM open_intervals
    {% if is_incremental() %}
    UNION ALL
    SELECT * FROM close_intervals
    {% endif %}
)

SELECT * FROM combined
```

**Effectivity is one of the few places raw vault "updates" rows —
except it doesn't update, it inserts a new row that supersedes the
old.** Downstream queries always take the row with the latest
`load_dts` per link hash key.

**Prefer AutomateDV's `automate_dv.eff_sat` macro** over hand-rolling
this — the two-pass logic (opens + closes) is finicky and the macro
gets it right.

## Status-Tracking Satellite

Records whether a business key exists in the current source snapshot.
Detects source deletions without violating the raw-vault insert-only
rule.

```sql
-- models/raw_vault/satellites/sts_customer.sql
{{ config(
    materialized='incremental',
    unique_key=['customer_hk', 'load_dts'],
    on_schema_change='fail',
    tags=['raw_vault', 'satellite', 'status_tracking']
) }}

WITH current_source_keys AS (
    SELECT
        {{ dv_hash_bk(['customer_id']) }} AS customer_hk,
        'PRESENT'                         AS cdc_status,
        '{{ run_started_at }}'::TIMESTAMP AS load_dts,
        'crm.customers'                   AS record_source
    FROM {{ ref('stg_crm__customers') }}
    WHERE customer_id IS NOT NULL
),

{% if is_incremental() %}
previously_present AS (
    -- Every hash key whose latest status is 'PRESENT'.
    SELECT customer_hk
    FROM {{ this }}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_hk ORDER BY load_dts DESC) = 1
        AND cdc_status = 'PRESENT'
),

deletions AS (
    -- Present in target's latest snapshot, absent from current source → deleted.
    SELECT
        p.customer_hk,
        'DELETED'                         AS cdc_status,
        '{{ run_started_at }}'::TIMESTAMP AS load_dts,
        'system.deletion_detection'       AS record_source
    FROM previously_present p
    LEFT JOIN current_source_keys c USING (customer_hk)
    WHERE c.customer_hk IS NULL
),
{% endif %}

{% if is_incremental() %}
latest_status AS (
    SELECT customer_hk, cdc_status AS latest_status
    FROM {{ this }}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_hk ORDER BY load_dts DESC) = 1
),
{% endif %}

to_load AS (
    SELECT * FROM current_source_keys
    {% if is_incremental() %}
    WHERE customer_hk NOT IN (SELECT customer_hk FROM latest_status WHERE latest_status = 'PRESENT')
    {% endif %}

    {% if is_incremental() %}
    UNION ALL
    SELECT * FROM deletions
    {% endif %}
)

SELECT * FROM to_load
```

**The hub still keeps the deleted customer's row.** Raw vault never
deletes. The status-tracking satellite is the auditable answer to
"has this key disappeared from source?" without violating insert-only.

## Splitting Satellites — Classification First, Cadence Second

Two independent axes drive satellite splits: **classification level**
(who's allowed to see this?) and **change cadence** (how often does
this change?). For enterprise use, classification dominates —
mixed-classification satellites make RLS grants all-or-nothing and
turn erasure requests into a full-satellite rewrite. Within a
classification tier, then split by cadence.

### Axis 1 — Classification (see [governance-and-compliance.md](governance-and-compliance.md))

Common tiers:
- **Public** — visible to anyone with mart access.
- **Internal** — employees + partners.
- **Confidential** — business-sensitive (pricing, contract terms).
- **PII** — direct identifiers (name, email, phone).
- **PHI** — health-regulated (HIPAA).
- **Regulated financial** — SSN, bank account, card (PCI-DSS).

**Ask the user first:** *"What's your classification taxonomy? For
each column in the source, which tier does it fall in?"* Do not
infer from column names alone. Invoke the `pii-audit` companion
skill during Discover to get a first-pass classification, then
confirm with the user.

Example — `hub_customer` with tier-based satellites:

```
hub_customer
├── sat_customer_pii              ← name, email, phone, address (PII tier)
├── sat_customer_confidential     ← loyalty tier, LTV (confidential)
├── sat_customer_engagement       ← login counts, last-seen (internal)
└── sat_customer_public           ← join_year, tier_display (public)
```

Erasure = crypto-shred the per-subject key that unlocks
`sat_customer_pii`. The other satellites remain intact.

### Axis 2 — Cadence (within a tier)

Within a classification tier, split further when columns change at
very different rates.

**Wrong** — one satellite for everything:
```
sat_customer (customer_hk, load_dts, hashdiff, first_name, last_name,
              email, phone, address_line_1, ..., loyalty_tier,
              lifetime_value, last_login_at)
```
Problem: `last_login_at` changes daily. Every daily load appends a
new row for every customer, exploding the satellite. Meanwhile,
`first_name` changes essentially never but its history is
interleaved with the login noise.

**Right** — split by cadence:
```
sat_customer_pii            (rarely changes: name, email, phone)
sat_customer_address        (changes occasionally: address_*, postal_code)
sat_customer_engagement     (changes daily: last_login_at, session_count)
sat_customer_status         (changes rarely: loyalty_tier, is_active)
```

Each satellite is loaded independently, historized independently,
and consumed independently by information marts.

**Heuristic — the "would you refresh this hourly?" test.** If any
column in the satellite would justify hourly loads (session data,
metrics, current status), that column belongs in its own satellite.
The rest can load daily.

## Tests — Assertions Every Satellite Must Pass

```yaml
# _models.yml
models:
  - name: sat_customer_details
    description: |
      Descriptive attributes for customer. Insert-only, historized by
      hashdiff. New row inserts when any of first_name / last_name /
      email / phone / address_* changes.
    columns:
      - name: customer_hk
        description: FK to hub_customer. Composite PK with load_dts.
        tests:
          - not_null
          - relationships:
              to: ref('hub_customer')
              field: customer_hk
      - name: load_dts
        tests: [not_null]
      - name: hashdiff
        description: MD5_BINARY of the alphabetized descriptive attributes.
        tests: [not_null]
      - name: record_source
        tests: [not_null]

    tests:
      # Composite uniqueness on (parent_hk, load_dts).
      - dbt_utils.unique_combination_of_columns:
          combination_of_columns:
            - customer_hk
            - load_dts

      # No two consecutive rows for the same parent share a hashdiff.
      # If they do, the load is writing "nothing changed" rows.
      - assert_no_consecutive_matching_hashdiffs:
          parent_key: customer_hk
```

Custom test (put in `tests/`):

```sql
-- tests/assert_no_consecutive_matching_hashdiffs.sql
-- Generic test: fails if any satellite row has the same hashdiff as
-- the immediately-previous row for the same parent.
{% test assert_no_consecutive_matching_hashdiffs(model, parent_key) %}
    WITH ordered AS (
        SELECT
            {{ parent_key }} AS parent_hk,
            load_dts,
            hashdiff,
            LAG(hashdiff) OVER (
                PARTITION BY {{ parent_key }} ORDER BY load_dts
            ) AS prev_hashdiff
        FROM {{ model }}
    )
    SELECT * FROM ordered
    WHERE prev_hashdiff IS NOT NULL
      AND prev_hashdiff = hashdiff
{% endtest %}
```

## Common Satellite Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Using `merge` on `parent_hk` | History collapses to one row per parent | Insert-only, filter by hashdiff difference |
| Missing hashdiff comparison | Every load inserts a new row per parent, whether or not anything changed | `WHERE latest_hashdiff <> current_hashdiff OR latest_hashdiff IS NULL` |
| Hashing in `SELECT` order instead of alphabetized | Two runs with reordered SQL produce different hashdiffs | Always sort column list inside `dv_hashdiff` |
| Hashing including load metadata (`load_dts`, `record_source`) | Every load looks like a change | Hash *only* descriptive columns |
| Using source `updated_at` as `load_dts` | Reordering source rows breaks satellite history | Use `run_started_at` |
| One giant satellite | Churn from fast-changing columns bloats storage and dominates load time | Split by change cadence |
| Deleting rows in a satellite | No audit trail; history irreversibly lost | Never delete. Use status-tracking satellite to record disappearance |
| Comparing hashdiff against the wrong "latest" row | Missed changes, or every load double-inserts | `QUALIFY ROW_NUMBER() OVER (PARTITION BY parent_hk ORDER BY load_dts DESC) = 1` |
| Ignoring multi-active grain | Multi-value attributes lose values as they overwrite | Multi-active satellite with sub_sequence |
| Effectivity satellite that only opens, never closes | Historical "who was active when" queries return all rows as active forever | Two-pass load (opens + closes), or use `automate_dv.eff_sat` |
