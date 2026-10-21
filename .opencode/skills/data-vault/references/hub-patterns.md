# Hub Patterns

A hub is the simplest DV structure and the one most often gotten
wrong through convenience shortcuts. Every mistake here reverberates
into every link and satellite that references the hub.

**Hard rules only.** A hub load applies only hard rules — hash
computation, load metadata, NULL-business-key filtering.
Business-driven filters (`WHERE is_active = TRUE`, `WHERE
region = 'US'`) are soft rules and belong in a mart or business
vault, not in the hub. See [hard-vs-soft-rules.md](hard-vs-soft-rules.md).

## The Standard Hub

```sql
-- models/raw_vault/hubs/hub_customer.sql
{{ config(
    materialized='incremental',
    unique_key='customer_hk',
    on_schema_change='fail',
    tags=['raw_vault', 'hub']
) }}

WITH sources_unioned AS (
    -- One SELECT per source system that mentions customer.
    -- Every source that touches the business key contributes.
    SELECT
        customer_id                             AS customer_bk,
        '{{ run_started_at }}'::TIMESTAMP       AS load_dts,
        'crm.customers'                         AS record_source
    FROM {{ ref('stg_crm__customers') }}
    WHERE customer_id IS NOT NULL

    UNION ALL

    SELECT
        cust_no                                 AS customer_bk,
        '{{ run_started_at }}'::TIMESTAMP       AS load_dts,
        'erp.customer_master'                   AS record_source
    FROM {{ ref('stg_erp__customer_master') }}
    WHERE cust_no IS NOT NULL
),

hashed AS (
    SELECT
        {{ dv_hash_bk(['customer_bk']) }}       AS customer_hk,
        customer_bk,
        load_dts,
        record_source
    FROM sources_unioned
),

deduped AS (
    -- Pick the earliest load_dts + earliest record_source for each key.
    -- Deterministic: same input → same row.
    SELECT
        customer_hk,
        customer_bk,
        load_dts,
        record_source
    FROM hashed
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY customer_hk
        ORDER BY load_dts, record_source
    ) = 1
)

SELECT * FROM deduped

{% if is_incremental() %}
WHERE customer_hk NOT IN (SELECT customer_hk FROM {{ this }})
{% endif %}
```

### Why every step is required

- **`UNION ALL` of every source**, not just one. A hub is the union
  of every source's view of the business key. If the ERP has customer
  `C-123` but the CRM doesn't, the hub still contains `C-123`.
- **`WHERE customer_id IS NOT NULL`** on each source. NULL business
  keys cannot become a hub row. Filter them here, or you get a hub
  row whose `customer_hk` is `MD5('^^')` — the ghost row — polluted
  with the ingestion time.
- **`{{ dv_hash_bk(['customer_bk']) }}`**, not raw MD5 inline. This
  guarantees the same normalization is used everywhere in the project.
- **`QUALIFY ROW_NUMBER() ... = 1`** deduplicates deterministically.
  If the CRM and ERP both mention customer `C-123`, we only insert
  one hub row, and the tiebreak (`ORDER BY load_dts, record_source`)
  is stable across re-runs.
- **`WHERE customer_hk NOT IN (SELECT ...)`** filters out already-loaded
  hash keys. This is what makes the load insert-only. See the
  performance caveats below for large hubs.

## Incremental Filter — Performance Variations

`WHERE customer_hk NOT IN (SELECT customer_hk FROM {{ this }})` is
correct but scans the entire hub every load. For hubs over a few
tens of millions of rows, use one of these instead:

**Anti-join:**
```sql
FROM deduped d
LEFT JOIN {{ this }} t USING (customer_hk)
WHERE t.customer_hk IS NULL
```
Cheaper than `NOT IN` on most engines because the optimizer can
hash-anti-join.

**Snowflake / BigQuery — `EXCEPT`:**
```sql
SELECT customer_hk, customer_bk, load_dts, record_source FROM deduped
EXCEPT
SELECT customer_hk, customer_bk, load_dts, record_source FROM {{ this }}
```
Only works when all columns match exactly — brittle when `load_dts`
or `record_source` might differ. Prefer anti-join.

**Watermarking (only for append-heavy sources with a source ingest
timestamp):** filter the input by `WHERE ingest_ts > (SELECT MAX(...) FROM {{ this }})`.
Requires the source itself to be strictly append-only in ingest order.
Rarely applicable to hubs — hubs union many sources, and each has
its own timeline. Prefer the anti-join.

## Multi-Part Business Key

A composite business key is treated as one key when hashing, but
stored as one column per part.

```sql
-- Business key: (store_id, sku)
SELECT
    {{ dv_hash_bk(['store_id', 'sku']) }}   AS inventory_item_hk,
    store_id                                AS store_id_bk,
    sku                                     AS sku_bk,
    '{{ run_started_at }}'::TIMESTAMP       AS load_dts,
    'wms.inventory'                         AS record_source
FROM {{ ref('stg_wms__inventory') }}
WHERE store_id IS NOT NULL AND sku IS NOT NULL
```

**The order of parts inside `dv_hash_bk` is the canonical order for
this hub, everywhere it's referenced.** Document it in the hub's
`_models.yml`. If a link references the same composite key, it must
pass the parts in the same order:

```sql
-- In lnk_inventory_reorder:
{{ dv_hash_bk(['store_id', 'sku']) }} AS inventory_item_hk
-- NOT dv_hash_bk(['sku', 'store_id']) — that's a different hash.
```

## Hub From One Source Only

The single-source case is a special case of the multi-source
pattern — just one `SELECT` in the union:

```sql
{{ config(materialized='incremental', unique_key='order_hk', tags=['raw_vault', 'hub']) }}

WITH source_rows AS (
    SELECT
        order_id                             AS order_bk,
        '{{ run_started_at }}'::TIMESTAMP    AS load_dts,
        'ecommerce.orders'                   AS record_source
    FROM {{ ref('stg_ecommerce__orders') }}
    WHERE order_id IS NOT NULL
),

hashed AS (
    SELECT
        {{ dv_hash_bk(['order_bk']) }} AS order_hk,
        order_bk,
        load_dts,
        record_source
    FROM source_rows
),

deduped AS (
    SELECT order_hk, order_bk, load_dts, record_source
    FROM hashed
    QUALIFY ROW_NUMBER() OVER (PARTITION BY order_hk ORDER BY load_dts) = 1
)

SELECT * FROM deduped
{% if is_incremental() %}
LEFT JOIN {{ this }} existing USING (order_hk)
WHERE existing.order_hk IS NULL
{% endif %}
```

Keep the same shape even for single-source hubs — the day a second
source lands you don't want to restructure the model.

## Ghost Row — Load Once at Project Setup

Every hub needs exactly one ghost row so that downstream `LEFT JOIN`s
from links resolve. Load it with a `run-operation` or a manual
`INSERT`, once, at project setup:

```sql
-- operations/insert_ghost_rows.sql, called via `dbt run-operation`
{% macro insert_ghost_row_customer() %}
    INSERT INTO {{ ref('hub_customer') }}
        (customer_hk, customer_bk, load_dts, record_source)
    SELECT
        {{ dv_hash_function() }}('^^'),
        '^^',
        '1900-01-01'::TIMESTAMP,
        'SYSTEM'
    WHERE NOT EXISTS (
        SELECT 1 FROM {{ ref('hub_customer') }}
        WHERE customer_hk = {{ dv_hash_function() }}('^^')
    );
{% endmacro %}
```

Do not include the ghost in the hub's main SELECT — that would make
the model non-idempotent (a re-hashed ghost across normalization
changes would collide with the real one).

## Tests — the Assertions Every Hub Must Pass

```yaml
# _models.yml (companion to hub_customer.sql)
version: 2

models:
  - name: hub_customer
    description: |
      Hub for customer business concept. Insert-only. One row per
      normalized business key. Loaded from CRM and ERP.
    columns:
      - name: customer_hk
        description: Hash of the normalized customer_bk (MD5_BINARY on Snowflake / unhex(md5) on Databricks / MD5 BYTES on BigQuery — see hashing-and-keys.md). Primary key.
        tests:
          - not_null
          - unique
      - name: customer_bk
        description: The customer business key (customer_id in CRM, cust_no in ERP).
        tests:
          - not_null
          - unique
      - name: load_dts
        description: Timestamp when this business key was first loaded into the hub.
        tests:
          - not_null
      - name: record_source
        description: Source feed the business key was first seen in.
        tests:
          - not_null
```

## Common Hub Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Selecting from a fact / order source only | Customers who exist in the master but haven't ordered are missing from the hub | UNION every source that mentions the key |
| Not deduplicating | Two rows per business key on first load | `QUALIFY ROW_NUMBER() ... = 1` |
| Using source `updated_at` as `load_dts` | Vault history reflects source's history, not ingestion | Use `run_started_at` / `CURRENT_TIMESTAMP()` |
| Skipping `NULL` filter on business key | Every NULL row becomes a "ghost duplicate" | `WHERE bk IS NOT NULL` per source |
| Non-deterministic dedup tiebreak | Different `record_source` picked across runs | `ORDER BY load_dts, record_source` — no volatile columns |
| Inline `MD5(...)` instead of `dv_hash_bk` macro | Normalization drifts between hubs and links | Always use the macro |
| Materialized as `table` | Full reload on every run destroys `load_dts` accuracy | `incremental` + insert-only |
| `merge` strategy | Updates existing rows, violating insert-only | `incremental_strategy='append'` (or the anti-join pattern above) |
| One hub per source | Fragmented view of one business concept across N tables | One hub per business concept, union of sources |
| Hub with a satellite-like column | Descriptive attributes belong in satellites | Move to `sat_customer_details` |
