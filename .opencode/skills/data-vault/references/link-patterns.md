# Link Patterns

A link is the unique combinations of business keys that participate
in a relationship. The hardest part of link modeling is **identifying
the relationship's grain** — which keys are part of the identity of
the relationship (drivers) and which are payload attributes that
belong in a satellite.

**Hard rules only.** A link load applies only hard rules — hash
computation, load metadata, NULL-driver-key filtering. If you find
yourself filtering rows on business criteria or coalescing between
candidate FK columns, that's a soft rule; move it to the mart or
business vault. See [hard-vs-soft-rules.md](hard-vs-soft-rules.md).

## The Standard Link

Connects two or more hubs. One row per unique combination of the
participating hash keys.

```sql
-- models/raw_vault/links/lnk_order_customer.sql
{{ config(
    materialized='incremental',
    unique_key='lnk_order_customer_hk',
    on_schema_change='fail',
    tags=['raw_vault', 'link']
) }}

WITH source_rows AS (
    SELECT
        order_id,
        customer_id,
        '{{ run_started_at }}'::TIMESTAMP   AS load_dts,
        'ecommerce.orders'                  AS record_source
    FROM {{ ref('stg_ecommerce__orders') }}
    WHERE order_id IS NOT NULL
      AND customer_id IS NOT NULL
),

hashed AS (
    SELECT
        -- Link hash: hash of ALL participating BKs, in canonical order.
        {{ dv_hash_bk(['order_id', 'customer_id']) }}   AS lnk_order_customer_hk,
        -- One hub hash per hub the link points at.
        {{ dv_hash_bk(['order_id']) }}                  AS order_hk,
        {{ dv_hash_bk(['customer_id']) }}               AS customer_hk,
        load_dts,
        record_source
    FROM source_rows
),

deduped AS (
    SELECT
        lnk_order_customer_hk,
        order_hk,
        customer_hk,
        load_dts,
        record_source
    FROM hashed
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY lnk_order_customer_hk
        ORDER BY load_dts, record_source
    ) = 1
)

SELECT * FROM deduped

{% if is_incremental() %}
LEFT JOIN {{ this }} existing USING (lnk_order_customer_hk)
WHERE existing.lnk_order_customer_hk IS NULL
{% endif %}
```

### Rules

- **The link hash is over every driver key**, in canonical order.
  Missing a driver key means the link can't distinguish two logically
  different relationships and silently deduplicates them.
- **Every hub the link points at has its own `_hk` column** computed
  from its own business key(s), using the same hash macro. These
  columns are what downstream joins use.
- **Descriptive columns go in a satellite off the link, not on the
  link.** If the "order line" carries a `quantity` and a `unit_price`,
  those belong in `sat_order_line_details`, not in the link itself.
- **Insert-only with an anti-join** — same shape as hubs.

## Identifying Driver Keys

The **driver key set** is the minimum set of business keys such that
adding any other key doesn't create a new distinct relationship.

Example — a purchase order:

```
Source row: order_id=100, customer_id=C7, salesperson_id=S3, warehouse_id=W1
```

Which keys are drivers of "an order"?

- `order_id` — yes, the order is *this* order.
- `customer_id` — yes, changing the customer means a different order.
- `salesperson_id` — depends. If the same order can be re-assigned
  to a different salesperson without changing what the order *is*,
  salesperson is a payload attribute, not a driver. Put it in an
  effectivity satellite or a status-tracking satellite.
- `warehouse_id` — depends. If shipping the same order from a
  different warehouse is a business event ("re-warehoused"), it's a
  driver of the fulfillment relationship (and probably belongs in a
  separate `LNK_ORDER_FULFILLMENT` link). If shipping from a different
  warehouse means it's a different order entirely, warehouse is a
  driver of `LNK_ORDER_*`. If it's just a payload, keep it in the
  satellite.

**Rule of thumb — the driver-key test.** For each candidate key, ask:
"If this value changed on the same source row, is that a new
relationship or a change to the existing one?" New relationship →
driver. Change to existing → payload (satellite).

Getting this wrong is the number-one source of silent bugs in link
tables. Under-specifying drivers → duplicate rows collapse into one
hash. Over-specifying drivers → every payload edit creates a new
"relationship" row, exploding the link.

## Transactional (Non-Historized) Link

A transactional link records a business event that has no history —
it happens once and doesn't change. Common examples: a payment, a
login, a shipment.

```sql
-- models/raw_vault/links/lnk_payment.sql
{{ config(
    materialized='incremental',
    unique_key='lnk_payment_hk',
    on_schema_change='fail',
    tags=['raw_vault', 'link', 'transactional']
) }}

WITH source_rows AS (
    SELECT
        payment_id,
        order_id,
        customer_id,
        amount_cents,
        currency_code,
        paid_at,
        '{{ run_started_at }}'::TIMESTAMP   AS load_dts,
        'stripe.payments'                   AS record_source
    FROM {{ ref('stg_stripe__payments') }}
    WHERE payment_id IS NOT NULL
),

hashed AS (
    SELECT
        {{ dv_hash_bk(['payment_id']) }}                    AS lnk_payment_hk,
        {{ dv_hash_bk(['order_id']) }}                      AS order_hk,
        {{ dv_hash_bk(['customer_id']) }}                   AS customer_hk,
        payment_id                                          AS payment_bk,
        -- Transactional payload — allowed on a non-historized link
        -- because these attributes are part of the event's identity
        -- and by definition never change.
        amount_cents,
        currency_code,
        paid_at,
        load_dts,
        record_source
    FROM source_rows
)

SELECT * FROM hashed
{% if is_incremental() %}
LEFT JOIN {{ this }} existing USING (lnk_payment_hk)
WHERE existing.lnk_payment_hk IS NULL
{% endif %}
```

**Why the payload lives on the link, not in a satellite:** the event
is immutable. There is no "history" to track — the payment happened
with those exact values at that exact time. Adding a satellite would
create needless overhead. The transactional-link exception to the
"no payload on links" rule is *only* valid when the event truly never
changes.

If any of the payload columns could ever be corrected, re-issued, or
reversed, use a standard link with a satellite instead.

## Hierarchical Link

A link where two hash keys point at the *same* hub. Used to model
parent-child relationships within one business concept:

- Employee reports to another employee (manager).
- BOM part contains other BOM parts (assembly).
- Category is a sub-category of another category.

```sql
-- models/raw_vault/links/lnk_employee_manager.sql
{{ config(materialized='incremental', unique_key='lnk_employee_manager_hk', tags=['raw_vault', 'link']) }}

WITH source_rows AS (
    SELECT
        employee_id,
        manager_id,
        '{{ run_started_at }}'::TIMESTAMP   AS load_dts,
        'hr.employees'                      AS record_source
    FROM {{ ref('stg_hr__employees') }}
    WHERE employee_id IS NOT NULL
      AND manager_id IS NOT NULL     -- CEO has no manager; excluded from this link
),

hashed AS (
    SELECT
        {{ dv_hash_bk(['employee_id', 'manager_id']) }}  AS lnk_employee_manager_hk,
        {{ dv_hash_bk(['employee_id']) }}                AS employee_hk,
        {{ dv_hash_bk(['manager_id']) }}                 AS manager_hk,
        load_dts,
        record_source
    FROM source_rows
)

SELECT * FROM hashed
{% if is_incremental() %}
LEFT JOIN {{ this }} existing USING (lnk_employee_manager_hk)
WHERE existing.lnk_employee_manager_hk IS NULL
{% endif %}
```

**Both hash keys point at `hub_employee`**, but they're distinct
columns with role-specific names (`employee_hk`, `manager_hk`). Every
downstream query joins on the appropriate role.

**Manager changes.** When Alice's manager changes from Bob to Carol,
does that produce a new row in this link?

- If (Alice, Bob) and (Alice, Carol) are both valid relationships
  in history → yes, a new link row appears. Track "current manager"
  via an effectivity satellite (see [satellite-patterns.md](satellite-patterns.md)).
- If the source overwrites the manager on Alice's row → yes, a new
  link row appears on the next load. Old row stays. Effectivity
  satellite tells you which is current.

## Same-As Link (Deduplication Link)

Records that two business keys refer to the same real-world entity.
Both hash keys point at the same hub. Almost always paired with a
satellite carrying match confidence / method.

```sql
-- models/raw_vault/links/lnk_same_as_customer.sql
-- Two customer keys that the MDM system asserts are the same person.
{{ config(materialized='incremental', unique_key='lnk_same_as_customer_hk', tags=['raw_vault', 'link']) }}

WITH source_rows AS (
    SELECT
        surviving_customer_id                AS master_customer_id,
        duplicate_customer_id                AS duplicate_customer_id,
        '{{ run_started_at }}'::TIMESTAMP    AS load_dts,
        'mdm.merge_decisions'                AS record_source
    FROM {{ ref('stg_mdm__merge_decisions') }}
),

hashed AS (
    SELECT
        {{ dv_hash_bk(['master_customer_id', 'duplicate_customer_id']) }}  AS lnk_same_as_customer_hk,
        {{ dv_hash_bk(['master_customer_id']) }}                           AS master_customer_hk,
        {{ dv_hash_bk(['duplicate_customer_id']) }}                        AS duplicate_customer_hk,
        load_dts,
        record_source
    FROM source_rows
)

SELECT * FROM hashed
{% if is_incremental() %}
LEFT JOIN {{ this }} existing USING (lnk_same_as_customer_hk)
WHERE existing.lnk_same_as_customer_hk IS NULL
{% endif %}
```

The same-as link **does not** delete the duplicate customer from
`hub_customer`. Both business keys remain in the hub. Downstream
information marts consult the same-as link to collapse them for
reporting — the raw vault stays byte-for-byte true to source.

## Multi-Way Link (3+ Hubs)

The pattern extends to any number of hubs. Order all key parts in a
documented canonical order.

```sql
-- lnk_order_line: connects order + product + warehouse
{{ dv_hash_bk(['order_id', 'line_number', 'product_id', 'warehouse_id']) }} AS lnk_order_line_hk,
{{ dv_hash_bk(['order_id']) }}                                             AS order_hk,
{{ dv_hash_bk(['product_id']) }}                                           AS product_hk,
{{ dv_hash_bk(['warehouse_id']) }}                                         AS warehouse_hk,
-- line_number has no hub — it's a dependent-child key that is part
-- of the link's identity but has no independent business meaning.
line_number                                                                AS line_number,
```

The order (`order_id`, `line_number`, `product_id`, `warehouse_id`) is
the canonical order for this link. Document it in `_models.yml` so
downstream models compute the same hash.

**Dependent-child keys** (like `line_number` above) are keys that
have no hub of their own but are part of the link's grain. They're
included in the link's hash and stored as columns on the link, but
they don't get their own `_hk`.

## Tests — Assertions Every Link Must Pass

```yaml
# _models.yml
models:
  - name: lnk_order_customer
    description: Links orders to their placing customer. One row per (order, customer) combination.
    columns:
      - name: lnk_order_customer_hk
        description: Hash of concatenated (order_id, customer_id) BKs — dialect-specific per hashing-and-keys.md. Primary key.
        tests:
          - not_null
          - unique
      - name: order_hk
        description: FK to hub_order.
        tests:
          - not_null
          - relationships:
              to: ref('hub_order')
              field: order_hk
      - name: customer_hk
        description: FK to hub_customer.
        tests:
          - not_null
          - relationships:
              to: ref('hub_customer')
              field: customer_hk
      - name: load_dts
        tests: [not_null]
      - name: record_source
        tests: [not_null]
```

## Common Link Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Missing driver key in hash | Distinct relationships collapse into one row | Include every driver in `dv_hash_bk` |
| Payload column on a standard link (e.g. `quantity`) | Payload lost when it changes; link becomes semi-mutable | Move to a satellite on the link |
| Payload on link but link is genuinely transactional | *Not a mistake* — allowed for non-historized links | Confirm the event is immutable |
| Different hash column order in link vs. hub | Hash keys don't match; joins silently miss | Both call `dv_hash_bk` with the same canonical order |
| Loading a link before its hubs | Referential integrity briefly violated; downstream jobs read broken FKs | Order runs: hubs → links → satellites (dbt DAG handles this if refs are correct) |
| Using `merge` strategy | Updates existing rows, violates insert-only | Anti-join pattern |
| Not deduplicating multiple source occurrences | Same (order, customer) combination inserted twice | `QUALIFY ROW_NUMBER() = 1` |
| Filtering out NULLs after hashing | The `MD5('^^')` ghost row gets loaded as if it were real | Filter NULLs *before* hashing |
| Splitting one relationship across two links | Fragmented view; downstream must union | One link per business relationship; add sats for variation |
| Skipping the link altogether and putting FKs on the hub | Hub picks up a grain it shouldn't have | Every relationship gets its own link table |
