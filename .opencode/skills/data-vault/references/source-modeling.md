# Source Modeling — From Tables to Hubs, Links, and Satellites

Data Vault 2.0 designs *from the business*, not from source tables.
The source's PK is rarely the right business key; the source's foreign
keys are rarely the right link grain. This guide is the step-by-step
procedure to go from a source system to a correct raw vault design.

## Ask the User First — Business-Key Decisions

Before proceeding, get explicit answers on these load-bearing
questions. Assuming any of them is what produces a fragmented,
retroactively-expensive vault:

- **What is the business-facing key for each concept?** Not the
  source PK — the identifier the business uses. Salespeople say
  "order 42-A", not "orders.id = 8734921".
- **Would that key survive a source-system migration?** If you
  replatformed the CRM tomorrow, would `customer_id` come with
  the customer, or would every customer get a new one?
- **Is a candidate key ever reused / recycled?** Some systems
  reissue IDs when accounts close.
- **For composite keys, what's the canonical part order?**
  Document once, apply everywhere.
- **Are keys tenant-scoped?** In multi-tenant vaults, keys are
  usually scoped by `tenant_id` (see [multi-tenancy.md](multi-tenancy.md)).

**Don't guess.** A misidentified business key propagates through
every hub/link/sat and is retroactively expensive to fix.

## The Six-Step Procedure

For each source system:

1. **Enumerate the source tables** and read every one.
2. **Identify business concepts** — the entities the business talks
   about. These become hubs.
3. **Identify business keys per concept** — the identifiers the
   business actually uses. These are what get hashed.
4. **Identify relationships between concepts** — every unique combination
   becomes a link. Identify each link's driver keys.
5. **Group descriptive attributes by change cadence** — attributes that
   change together become one satellite; attributes that change on
   different cadences become separate satellites.
6. **Cross-check with other source systems** — hubs are per-concept, not
   per-source. Union sources into the same hub / link where they
   describe the same real-world entity or relationship.

Below, each step in detail with a worked example.

## Worked Example — E-Commerce CRM + Orders

Source system: an operational database with these tables:

```
customers            (customer_id PK, email, first_name, last_name,
                      phone, created_at, updated_at, is_test)
customer_addresses   (address_id PK, customer_id FK, address_line_1,
                      city, postal_code, country_code, is_primary, valid_from, valid_to)
customer_phones      (phone_id PK, customer_id FK, phone_number, phone_type)
orders               (order_id PK, customer_id FK, order_date, order_status,
                      salesperson_id FK, warehouse_id FK, total_cents, updated_at)
order_lines          (order_id FK, line_number PK-part, product_id FK,
                      quantity, unit_price_cents)
products             (product_id PK, sku, product_name, category, list_price_cents, updated_at)
salespersons         (salesperson_id PK, employee_email, first_name, last_name)
warehouses           (warehouse_id PK, warehouse_code, city, country_code)
payments             (payment_id PK, order_id FK, amount_cents, currency, paid_at, method)
```

### Step 1 — Read the sources

For each table, understand:
- What one row represents.
- Which columns are truly unique (source PKs are candidates, but not
  automatic answers — sometimes the "PK" is a surrogate that hides a
  natural key).
- Which columns change vs. stay stable.
- Which columns look like descriptive attributes vs. keys.

**Ask the business, not the source's `INFORMATION_SCHEMA`:**
- "How do you identify a customer when you talk about one?"
- "Is `customer_id` durable, or does it change if we migrate?"
- "Does one customer ever have multiple `customer_id`s?"

The source PK is often a surrogate that the business doesn't use.
Watch for a natural key like `email` or `external_id` that would
survive a system migration.

### Step 2 — Business concepts → hubs

For the e-commerce example, the business talks about:

- Customers → **`hub_customer`**
- Orders → **`hub_order`**
- Products → **`hub_product`**
- Salespersons → **`hub_salesperson`**
- Warehouses → **`hub_warehouse`**
- Payments → **`hub_payment`** *(or* transactional link — see below)*
- Addresses — **?** Addresses might be a hub if the business talks
  about addresses independently ("what other customers ship to this
  address?"). If addresses are only ever descriptive of a customer,
  they're a satellite off `hub_customer` instead.

**Do not create a hub for every source table.** Some source tables
are pure satellite content (`customer_addresses`, `customer_phones`),
some are link content (`order_lines`), and some are transactional
links (`payments`).

### Step 3 — Business keys per concept

For each hub, what's the *business key*? Not the surrogate; the
identifier the business uses.

| Hub | Candidate | Business key | Reasoning |
|-----|-----------|--------------|-----------|
| `hub_customer` | `customer_id` (surrogate) OR `email` (natural) | **`customer_id`** if durable, else `email` | Check: if we replatformed tomorrow, which one would survive? Usually the surrogate — but confirm with the business. |
| `hub_order` | `order_id` (surrogate) OR `order_number` (business-facing) | **`order_number`** | The business quotes this on invoices; it's what a customer would call to reference. |
| `hub_product` | `product_id` (surrogate) OR `sku` (natural) | **`sku`** | SKUs are cross-system; they'd survive a product-catalog migration. |
| `hub_salesperson` | `salesperson_id` OR `employee_email` | **`employee_email`** | Salespeople are humans; employee-email is durable across HR system changes. |
| `hub_warehouse` | `warehouse_id` OR `warehouse_code` | **`warehouse_code`** | Warehouse codes are printed on labels; they survive DB migrations. |
| `hub_payment` | `payment_id` (surrogate) OR `stripe_charge_id` (external) | **`stripe_charge_id`** | The external ID survives our system; the internal one wouldn't. |

**Do not use the source surrogate as the business key** unless you've
confirmed the business also uses it. That's the most common mistake
and it makes cross-source integration impossible.

### Step 4 — Relationships → links

Every relationship between two or more hubs becomes a link. Look at
foreign keys in the source, but also look at *implicit* relationships
the business talks about.

From `orders` and `order_lines`:

| Relationship | Link | Driver keys | Payload attrs |
|--------------|------|-------------|---------------|
| Order placed by customer | `lnk_order_customer` | `order_number, customer_id` | none |
| Order fulfilled from warehouse | `lnk_order_warehouse` | `order_number, warehouse_code` | none *(if warehouse can change without being a new order)* |
| Order taken by salesperson | `lnk_order_salesperson` | `order_number, employee_email` | none *(same test)* |
| Order line references product | `lnk_order_line` | `order_number, line_number, sku` | `line_number` is a dependent-child key |
| Payment for order | `lnk_payment_order` OR `lnk_payment` (transactional) | `stripe_charge_id, order_number` | See below |

**Driver-key test** applied to `lnk_order_warehouse`:

"If the warehouse changes on an order, is it a new order or a change
to the existing order?"
- If the business considers "re-warehoused" a distinct event → the
  warehouse is a driver; the change produces a new link row.
- If the warehouse is just an attribute of *this* order's fulfillment
  → warehouse belongs in an effectivity satellite on `lnk_order_customer`
  (or an ordinary satellite if we don't need history), not in the
  link's hash.

Answer depends on the business. Ask before deciding.

**Transactional vs. standard link for payments.** A payment happens
once and doesn't change. Options:
- **Transactional link `lnk_payment`** — hash on `stripe_charge_id`
  alone, payload columns (`amount_cents`, `currency`, `paid_at`,
  `method`) live on the link.
- **Standard link `lnk_payment_order`** + **satellite `sat_payment_details`** —
  hash on `stripe_charge_id`, satellite holds the payload.

Both are valid. Use transactional-link when you're confident the
event's attributes are immutable. Use standard link + satellite
when there's any chance of correction / reversal / edit.

### Step 5 — Descriptive attributes → satellites, split by cadence

For each hub and link, group descriptive attributes by how often they
change together.

For `hub_customer`:

| Column | Change frequency | Satellite |
|--------|------------------|-----------|
| `first_name`, `last_name` | Very rare | `sat_customer_pii` |
| `email` | Rare | `sat_customer_pii` |
| `phone_number` | Rare, but multiple per customer | *Multi-active* `sat_customer_phones_multi` |
| Address (line_1, city, postal_code, country_code) | Occasionally | `sat_customer_address` |
| `is_test` flag | Never (once set) | `sat_customer_pii` — or drop entirely if never queried |
| `updated_at` (from source) | Every load | **Do not historize.** This is source noise. |

For `hub_product`:

| Column | Change frequency | Satellite |
|--------|------------------|-----------|
| `product_name` | Very rare | `sat_product_catalog` |
| `category` | Rare | `sat_product_catalog` |
| `list_price_cents` | Regularly (pricing changes) | `sat_product_pricing` |

Splitting `list_price_cents` into its own satellite means the pricing
history is queryable at load-time-of-price-change granularity, not
"whenever we happened to load the catalog".

For `lnk_order_line`:

| Column | Change frequency | Satellite |
|--------|------------------|-----------|
| `quantity` | Sometimes (mid-flight edits) | `sat_order_line_details` |
| `unit_price_cents` | Sometimes | `sat_order_line_details` |

For `lnk_order_customer` (which has no payload of its own):

| Attribute | Historized how? |
|-----------|-----------------|
| Order status | `sat_order_status` on `lnk_order_customer` (or on `hub_order` — either works; convention is to attach status to the link if it's about *this order for this customer*, or to the hub if it's about the order regardless of customer) |
| Salesperson (if not a driver key) | Effectivity satellite `eff_order_salesperson` on `lnk_order_salesperson` |

### Step 6 — Cross-source hub integration

If a *second* source system (e.g., a Shopify export) also has
customers, the customers **land in the same `hub_customer`**, unioned
in. The business key must match — either both sources happen to use
the same identifier (unlikely) or the vault relies on a same-as link
to bridge:

- If both sources use the *same customer_id* → union directly in
  `hub_customer`.
- If they use *different* IDs but represent the same customers → each
  source has its own hub key (loaded separately or unified via a
  master-data mapping) and a `lnk_same_as_customer` records the
  master ↔ duplicate mapping.

**Never create `hub_customer_crm` and `hub_customer_shopify` as two
separate hubs on the same concept.** That's a source-shaped model, not
a business-shaped one. The whole point of DV is one hub per business
concept.

## Anti-Patterns

| Pattern | Why it's wrong |
|---------|----------------|
| One hub per source table | Fragments a single business concept across N tables; kills cross-source reporting |
| Using source PK as business key without checking | Surrogates rarely survive replatforms; when the source migrates, the vault's history becomes uninterpretable |
| Payload columns on the hub | Hub is a set of business keys; payload belongs in a satellite |
| Payload columns on a standard link | Link is a set of relationships; payload belongs in a satellite (or use transactional link for immutable events) |
| One giant satellite per hub | Fast-changing columns bloat storage; split by change cadence |
| Modeling a satellite where a hub belongs | If addresses are queried independently ("who else ships here?"), they need a hub |
| Not modeling relationships that don't appear in the source | The business often talks about relationships that are implicit (customer → territory). Add the link even if you'll load it manually or from a lookup source |
| Renaming a business key mid-vault | If `customer_id` is the BK and you rename it to `customer_number` in the next quarter, every hash changes. Rename via a same-as link and a new hub only |

## Checklist Before Writing Any Raw-Vault SQL

- [ ] Every source table read and mapped to (a hub / a link / a satellite / a driver key / a discard).
- [ ] Every business concept has exactly one hub.
- [ ] Every business key confirmed with the business (not just inferred from the source PK).
- [ ] Every relationship's driver keys explicitly listed and tested against the "does changing this create a new relationship?" question.
- [ ] Every descriptive attribute assigned to a satellite based on change cadence.
- [ ] Every source with a matching business concept unioned into the same hub / link.
- [ ] Naming convention picked (`hub_customer` vs. `H_CUSTOMER`) and applied consistently.
- [ ] Ghost-record loader written for each hub.
- [ ] `dv_hash_bk` / `dv_hashdiff` macros installed and configured for the warehouse dialect.

Only then start writing SQL.
