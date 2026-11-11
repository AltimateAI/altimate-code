# Zero Keys, Ghost Records, and Special Hash Keys

The book's complete "special hash key" scheme, beyond the simple
ghost row. There are (at least) three distinct classes of special
keys, each with a specific purpose. Getting these right avoids the
NULL-key trap in downstream marts and makes error handling explicit
instead of implicit.

## The Three Special Hash Key Classes

### 1. Zero Key (Unknown)

**Purpose:** stand-in for "we don't know the value" — the source
didn't provide a business key on a row that needed one, or a
foreign key was NULL and we need the mart's `LEFT JOIN` to resolve.

**Hash value:** the hash of a fixed unknown sentinel — commonly
`'0'` or `'^^'` (AutomateDV) or `'-1'`.

```sql
{{ dv_hash_function() }}('^^') AS zero_key    -- Snowflake: MD5_BINARY('^^')
```

**Hub row:** exactly one per hub, with `bk = '^^'`, load once at
project setup:

```sql
INSERT INTO hub_customer (customer_hk, customer_bk, load_dts, record_source)
SELECT
    MD5_BINARY('^^'),
    '^^',
    '1900-01-01'::TIMESTAMP,
    'SYSTEM.ZERO_KEY';
```

**Satellite baseline:** one row per satellite with `parent_hk = MD5_BINARY('^^')`,
`hashdiff = MD5_BINARY('^^')`, all descriptive columns NULL:

```sql
INSERT INTO sat_customer_details (customer_hk, load_dts, hashdiff, record_source,
                                   first_name, last_name, email, ...)
SELECT
    MD5_BINARY('^^'),
    '1900-01-01'::TIMESTAMP,
    MD5_BINARY('^^'),
    'SYSTEM.ZERO_KEY',
    NULL, NULL, NULL, ...;
```

### 2. Error Key

**Purpose:** distinct from unknown — the source *did* provide a
value, but it failed a hard-rule check (unparseable, out-of-range).
Rare in practice; use only when you need to distinguish "not given"
from "given but invalid".

**Hash value:** hash of a distinct error sentinel — commonly `'##'`
or `'-2'`.

```sql
{{ dv_hash_function() }}('##') AS error_key
```

Route the row into both the hub (with `bk = '##'`) and the error mart
(see [metrics-and-error-vault.md](metrics-and-error-vault.md)). Most
projects skip this and use the zero key + error mart alone; add error
keys when downstream mart consumers need to visualize "known-bad"
distinctly.

### 3. System Key / Sentinel Rows for Special Concepts

**Purpose:** the business itself has "unknown", "all", "not
applicable" as valid values (common in dimensional reporting).

**Hash values:** hash of business-defined sentinels — `'ALL'`,
`'N/A'`, `'*'`.

Example — `hub_region` may have real regions plus `'ALL'` and `'N/A'`
sentinel hubs so that aggregate reports can pivot on region without
special-casing NULLs:

```sql
-- Load once at project setup
INSERT INTO hub_region VALUES
    (MD5_BINARY('^^'),  '^^',  '1900-01-01'::TIMESTAMP, 'SYSTEM.ZERO_KEY'),
    (MD5_BINARY('ALL'), 'ALL', '1900-01-01'::TIMESTAMP, 'SYSTEM.SENTINEL'),
    (MD5_BINARY('N/A'), 'N/A', '1900-01-01'::TIMESTAMP, 'SYSTEM.SENTINEL');
```

Use sparingly; each sentinel is a business decision and complicates
downstream reporting logic.

## The Zero Key in Link Loads

The zero key's most important use: replacing NULL foreign keys on a
link so `LEFT JOIN` from mart to hub always resolves.

**Wrong** (NULL preserved into link):
```sql
-- lnk_order_customer.sql — DON'T DO THIS
SELECT
    {{ dv_hash_bk(['order_id']) }}    AS order_hk,
    {{ dv_hash_bk(['customer_id']) }} AS customer_hk,   -- NULL customer_id → MD5('^^') by macro
    ...
FROM {{ ref('stg_ecommerce__orders__hashed') }}
WHERE order_id IS NOT NULL
      -- customer_id NULLs flow through, hashing to the zero-key hub row
```

The `dv_hash_bk` macro's NULL-coalesce means every NULL customer_id
becomes `MD5_BINARY('^^')` in the link. This works — the link row
resolves to the zero-key hub row — but it silently hides a data
quality signal.

**Better** (explicit routing):
```sql
WITH source AS (
    SELECT
        order_id,
        customer_id,
        CASE WHEN customer_id IS NULL THEN TRUE ELSE FALSE END AS customer_id_missing
    FROM {{ ref('stg_ecommerce__orders__hashed') }}
    WHERE order_id IS NOT NULL
),

with_zero_routing AS (
    SELECT
        order_id,
        COALESCE(customer_id, '^^') AS customer_id_resolved,
        customer_id_missing
    FROM source
),

hashed AS (
    SELECT
        {{ dv_hash_bk(['order_id', 'customer_id_resolved']) }} AS lnk_order_customer_hk,
        {{ dv_hash_bk(['order_id']) }}                         AS order_hk,
        {{ dv_hash_bk(['customer_id_resolved']) }}             AS customer_hk,
        customer_id_missing,      -- flag preserved for downstream / error mart
        '{{ run_started_at }}'::TIMESTAMP AS load_dts,
        'ecommerce.orders'                AS record_source
    FROM with_zero_routing
)

SELECT * FROM hashed
```

Then a status satellite off the link records `customer_id_missing`
so downstream can see the pattern. Alternatively, log the row to
the error mart in parallel.

## Ghost Rows — Load-Once Setup

Both hubs and satellites need "the ghost" seeded. A dedicated
`run-operation` macro handles this idempotently:

```jinja
{# macros/seed_ghost_rows.sql #}
{% macro seed_ghost_rows() %}
    {% set hubs_with_ghost = [
        ('hub_customer', 'customer_hk', 'customer_bk'),
        ('hub_order',    'order_hk',    'order_bk'),
        ('hub_product',  'product_hk',  'product_bk'),
    ] %}

    {% for (hub, hk_col, bk_col) in hubs_with_ghost %}
        INSERT INTO {{ ref(hub) }} ({{ hk_col }}, {{ bk_col }}, load_dts, record_source)
        SELECT
            {{ dv_hash_function() }}('^^'),
            '^^',
            '1900-01-01'::TIMESTAMP,
            'SYSTEM.ZERO_KEY'
        WHERE NOT EXISTS (
            SELECT 1 FROM {{ ref(hub) }}
            WHERE {{ hk_col }} = {{ dv_hash_function() }}('^^')
        );
    {% endfor %}
{% endmacro %}
```

Call once after `dbt seed` / `dbt run` on hub tables:

```bash
altimate-dbt run-operation seed_ghost_rows
```

Similar macro for satellite baseline rows. Run after every satellite
is created; the `WHERE NOT EXISTS` makes it safe to re-run.

## Mart Consumption Pattern

Once the ghost is in place, marts use `LEFT JOIN` + `COALESCE` on the
hash key:

```sql
-- dim_customer via mart
SELECT
    f.order_hk,
    -- Coalesce NULL customer_hk to the zero-key hash so LEFT JOIN
    -- to the customer dim always lands on the "unknown" dim row.
    COALESCE(f.customer_hk, {{ dv_hash_function() }}('^^')) AS customer_hk,
    d.first_name,
    d.last_name
FROM {{ ref('fct_orders') }} f
LEFT JOIN {{ ref('dim_customer') }} d
    ON COALESCE(f.customer_hk, {{ dv_hash_function() }}('^^')) = d.customer_hk
```

If the link loader already routed NULLs to the zero key, the
`COALESCE` on the mart side is redundant — cheap safety belt.

## Do Not Delete or Update Ghost Rows

Once seeded, ghosts are immutable:
- Never `DELETE` them (breaks downstream `LEFT JOIN` resolution).
- Never `UPDATE` their descriptive columns (breaks the baseline
  hashdiff invariant).
- Never let a real load overwrite them (the `WHERE NOT EXISTS`
  guard in the seed macro prevents this).

If normalization ever changes (e.g., you migrate `'^^'` → `'-1'`),
delete the old ghost and seed the new one in a *controlled
migration* — one that recomputes every hash key in every table.
This is a project-restructuring event, not a routine one.

## Sentinel Hashes for Multi-Part Keys

For a composite business key `(store_id, sku)`, the zero-key version
is not `MD5_BINARY('^^')` — it's the hash of the *composite* sentinel:

```sql
{{ dv_hash_bk(['store_id', 'sku']) }}   -- normal
-- expands to: MD5_BINARY(COALESCE(...store_id...) || '||' || COALESCE(...sku...))

-- Zero-key composite:
{{ dv_hash_bk(["'^^'", "'^^'"]) }}
-- expands to: MD5_BINARY('^^' || '||' || '^^')
```

Seed the composite ghost the same way — one row per composite hub,
computed via the macro so it matches what NULL/NULL rows hash to.

## Special-Key Naming Convention

Document the sentinels in the project's `README` and enforce via a
shared macro:

```jinja
{% macro dv_special_keys() %}
    {% do return({
        'zero_key':    '^^',
        'error_key':   '##',
        'sentinel_all':'ALL',
        'sentinel_na': 'N/A'
    }) %}
{% endmacro %}
```

Then any test or seed that needs a sentinel calls the macro rather
than hardcoding. Changing the sentinel is a one-place edit (and a
big migration).

## dbt Tests for Special Keys

```yaml
# _models.yml
models:
  - name: hub_customer
    tests:
      # Zero key must be present
      - dbt_utils.expression_is_true:
          expression: "EXISTS (SELECT 1 FROM {{ ref('hub_customer') }} WHERE customer_bk = '^^')"

  - name: sat_customer_details
    tests:
      # Baseline satellite row for the zero key must be present
      - dbt_utils.expression_is_true:
          expression: >
            EXISTS (
              SELECT 1 FROM {{ ref('sat_customer_details') }}
              WHERE customer_hk = {{ dv_hash_function() }}('^^')
            )
```

Run these after every `dbt build` — a missing ghost is the sort of
bug that only shows up in production when a NULL FK breaks a mart.

## Common Special-Key Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| No ghost row loaded | Mart `LEFT JOIN` to dim returns NULL columns | Seed via run-operation, once, at project setup |
| Ghost loaded via normal source pipeline | Ghost picks up real `load_dts` / `record_source`; not distinguishable from real data | Use `run-operation` with fixed `record_source = 'SYSTEM.ZERO_KEY'` and `load_dts = '1900-01-01'` |
| Different sentinel in staging vs. hub | Sentinel drift: `'^^'` in one place, `'UNKNOWN'` in another → zero-key resolution misses | Central `dv_special_keys()` macro; one source of truth |
| Deleting ghost row after "cleanup" | Downstream mart breaks; NULLs no longer resolve | Never delete; add a test that fails if ghost is missing |
| NULL FK not routed to zero key | Link row has NULL hash; hub join misses; row invisible in mart | Coalesce NULL FKs to sentinel *before* hashing (or in the mart) |
| Zero key = literal all-zero bytes (`0x00000000...`) | Depending on hash function, may collide with a real hashed value | Use a hash of a printable sentinel like `'^^'`; the hash's collision resistance is your safety |
| Sentinel choice changed mid-project | Old rows have `MD5('^^')`, new have `MD5('-1')`; two "unknowns" coexist | Never change sentinels casually. If required, a project-wide re-hash + re-seed migration |
| Composite ghost seeded with wrong number of parts | Zero-key hash for (store_id, sku) doesn't match what NULL/NULL rows hash to | Seed via the same `dv_hash_bk` macro with sentinel parts |
| Ghost row appears in mart results ("customer named '^^'") | User-facing garbage | Mart filters `WHERE h.customer_bk <> '^^'` for user-visible queries; keeps ghost for FK resolution only |
