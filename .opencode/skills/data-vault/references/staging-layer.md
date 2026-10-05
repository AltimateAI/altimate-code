# Staging Layer for Data Vault 2.0

The staging layer is where source data first lands in the warehouse
and where hashes, load metadata, and hard-rule transformations get
applied. It is *not* the raw vault. Getting the staging layer's
discipline right is what makes raw-vault loads simple and correct.

The book (Linstedt & Olschimke, "Building a Scalable Data Warehouse
with Data Vault 2.0") is very specific about what staging must do
and — more importantly — what it must not do.

## What the Staging Layer Is For

1. **Land source data unchanged.** Every source column, every source
   row, exactly as received. No filtering, no dedup, no business logic.
2. **Compute vault-ready columns.** Hash keys, hashdiffs, load
   metadata (`load_dts`, `record_source`, `load_batch_id`).
3. **Apply hard rules only** (see [hard-vs-soft-rules.md](hard-vs-soft-rules.md)).
   Type casting, character-set conversion, string trimming for
   hashing — nothing that discards information.
4. **Provide a stable input contract** to the raw vault. Every hub /
   link / sat load reads from staging, not from source directly.

## What the Staging Layer Is *Not* For

- **Not for deduplication of "logically equivalent" rows.** That's a
  soft rule; belongs in business vault or mart.
- **Not for filtering out "bad" data.** If a row fails a quality
  check, it flows into the vault *and* into the error mart — never
  disappears.
- **Not for renaming columns to business-friendly names.** Staging
  preserves source column names (with an added prefix if the source
  had reserved-word conflicts).
- **Not for joining sources.** Every source table gets its own staging
  model. Joins happen in the link tables of the raw vault.
- **Not for reference-data enrichment.** Adding "region_name" from a
  lookup table happens in the mart, not staging.

## The Two-Stage Staging Pattern

The book prescribes a two-stage staging layer:

1. **Stage 1 — physical staging** (persistent or transient landing
   zone). Source data lands here, one row per source row, source
   columns preserved.
2. **Stage 2 — hashed / prepared staging** (dbt `view` or transient
   table). Adds hash keys, hashdiffs, load metadata. This is what
   raw-vault models read.

In dbt terms, Stage 1 is typically your `stg_<source>__<table>.sql`
mirror, and Stage 2 is a hashed variant — either produced by the
AutomateDV `stage` macro or hand-written.

```
raw source                   →  stg_crm__customers            →  stg_crm__customers__hashed  →  hub_customer
(Snowflake table)                (dbt view, source mirror)        (dbt view, hashes added)       sat_customer_details
```

## Stage 1 Template — Physical Staging

```sql
-- models/staging/crm/stg_crm__customers.sql
{{ config(materialized='view', tags=['staging', 'source_mirror']) }}

WITH source AS (
    SELECT * FROM {{ source('crm', 'customers') }}
),

typed AS (
    -- Hard rules only: type casting, trimming for storage sanity.
    -- NO filters, NO dedup, NO business logic.
    SELECT
        CAST(customer_id AS VARCHAR)              AS customer_id,
        CAST(email       AS VARCHAR)              AS email,
        CAST(first_name  AS VARCHAR)              AS first_name,
        CAST(last_name   AS VARCHAR)              AS last_name,
        CAST(phone       AS VARCHAR)              AS phone,
        CAST(created_at  AS TIMESTAMP_NTZ(6))     AS created_at,
        CAST(updated_at  AS TIMESTAMP_NTZ(6))     AS updated_at,
        CAST(is_test     AS BOOLEAN)              AS is_test
    FROM source
)

SELECT * FROM typed
```

## Stage 2 Template — Hashed Staging

```sql
-- models/staging/crm/stg_crm__customers__hashed.sql
{{ config(materialized='view', tags=['staging', 'hashed']) }}

WITH source AS (
    SELECT * FROM {{ ref('stg_crm__customers') }}
),

with_metadata AS (
    SELECT
        *,
        '{{ run_started_at }}'::TIMESTAMP        AS load_dts,
        'crm.customers'                          AS record_source,
        '{{ invocation_id }}'                    AS load_batch_id
    FROM source
),

with_hashes AS (
    SELECT
        with_metadata.*,

        -- Hub hash key
        {{ dv_hash_bk(['customer_id']) }}        AS customer_hk,

        -- Business key preserved for the hub
        customer_id                              AS customer_bk,

        -- Hashdiff for sat_customer_details (alphabetized inside macro)
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
        ]) }}                                    AS customer_details_hashdiff
    FROM with_metadata
)

SELECT * FROM with_hashes
```

Now every raw-vault model reads from `stg_crm__customers__hashed`
and does *not* re-compute hashes. Single source of truth for
normalization.

## Load Batch ID — The Fourth Piece of Metadata

The book recommends a **load batch ID** on every vault row in addition
to `load_dts` and `record_source`. Purpose: correlate every row
inserted in one run to a single audit event.

```sql
'{{ invocation_id }}' AS load_batch_id
```

`invocation_id` is a Jinja variable dbt populates once per run — a
UUID that's the same across every model in that run. Use it to:
- Trace every row inserted in a specific run.
- Support "how many rows were loaded on 2024-06-15 by which feed?"
  queries (join to metrics vault — see [metrics-and-error-vault.md](metrics-and-error-vault.md)).
- Correlate vault rows to error-mart rejections from the same batch.

If not using dbt, generate a UUID at load-orchestrator level and
pass it into each model as a var (`--vars '{"load_batch_id": "..."}'`).

## Applied Timestamp vs. Load Timestamp

For sources that carry their own "when did this happen in the
business" timestamp (payment.paid_at, order.placed_at), the book
distinguishes:

- **`load_dts`** — when *we* ingested. Vault primary metadata.
- **`applied_dts`** (or `business_dts`, `event_dts`, `source_ts`) —
  when the *business event* actually occurred. Descriptive column on
  the satellite; never used as vault metadata.

Store both. `load_dts` runs the vault; `applied_dts` runs the
downstream temporal analysis. Confusing them (using `applied_dts` as
`load_dts`) is the most common cause of "our vault history is
missing rows" bugs.

See [multi-temporal.md](multi-temporal.md) for the full bi-temporal
pattern when the source can retroactively correct events.

## Staging Column Naming

- **Source-preserving.** Keep source column names as-is; do not
  rename to business-friendly forms. Renaming happens in the mart.
- **Prefixes on hashes and metadata.** `<entity>_hk`, `<sat>_hashdiff`,
  `load_dts`, `record_source`, `load_batch_id`.
- **Uppercase (Snowflake convention) or lowercase — consistent
  project-wide.** See [snowflake-specific.md](snowflake-specific.md).

## Multi-Source Staging for the Same Hub

When two source systems both feed `hub_customer`, each has its own
staging model, both compute the *same* `customer_hk` using the *same*
`dv_hash_bk` macro. The hub `UNION ALL`s them.

```sql
-- stg_erp__customer_master__hashed.sql
{{ dv_hash_bk(['cust_no']) }} AS customer_hk    -- ERP uses 'cust_no'
cust_no                       AS customer_bk

-- stg_crm__customers__hashed.sql
{{ dv_hash_bk(['customer_id']) }} AS customer_hk -- CRM uses 'customer_id'
customer_id                       AS customer_bk
```

Two things must be true:
1. The two sources' business keys must actually reference the same
   real-world entity (or the hub fragments).
2. The values must be normalizable to the same string. If CRM uses
   `C-00123` and ERP uses `123`, they're not the same key —
   pre-normalize in staging (`LPAD` + prefix) *before* hashing.

## Persistent vs. Transient Staging

**Persistent staging** — Stage 1 kept as a table, retained for weeks
or months. Pros: re-load raw vault from staging without re-reading
source; audit "what did the source send us on date X". Cons: storage
cost, especially with high-volume sources.

**Transient staging** — Stage 1 as a dbt `view` (recomputed on every
run). Pros: cheap. Cons: source disappears → staging disappears →
raw vault can't be recovered from the staged snapshot.

Book recommends persistent staging for critical / regulated feeds
and transient for the rest. In dbt:

```yaml
# dbt_project.yml
models:
  my_project:
    staging:
      regulated_feeds:
        +materialized: incremental
        +incremental_strategy: append
      other_feeds:
        +materialized: view
```

Persistent-staging tables carry their own `load_batch_id` + `load_dts`
and are insert-only (same discipline as raw vault).

## Common Staging Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Filtering "bad" rows in staging | Rows disappear from vault; audit trail broken; can't answer "what did source send" | Never filter in staging; route bad rows to error mart in parallel |
| Renaming columns to business names | Downstream refactors ripple through staging | Preserve source names; rename in mart |
| Joining sources in staging | Joins belong in link tables of the raw vault | One staging model per source table |
| Computing hashes in the hub/link model instead of staging | Hashes drift when the raw-vault model is edited independently | Compute hashes once in Stage 2 hashed staging |
| Using `updated_at` from source as `load_dts` | Vault history collapses to source history | `run_started_at` always; source timestamps become descriptive `applied_dts` |
| Missing `load_batch_id` | Can't correlate rows to specific loads for troubleshooting | Add `invocation_id` on every staging row |
| Persistent staging with `merge` strategy | Overwrites history in the landing zone | Persistent staging is insert-only, like the vault |
| Skipping Stage 2 (hashed) layer | Every raw-vault model re-computes hashes; drift is inevitable | Always the two-stage pattern |
