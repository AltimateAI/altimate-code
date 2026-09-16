# Multi-Tenancy

For SaaS-B2B and any DV that serves multiple customers/orgs/tenants
in one vault, tenant isolation is a modeling decision, not a mart
concern. Bolting it on later means either rehashing every row in
every hub (see [scale-and-ops.md](scale-and-ops.md)) or accepting
that tenant-A's data will leak into tenant-B's queries. Neither
outcome is recoverable cheaply.

**When to load this reference:** the vault will hold data belonging
to more than one tenant, customer, org, workspace, or account, and
those tenants must not see each other's data. Skip for single-tenant
internal analytics.

---

## Ask the User First — Tenancy Model

Before writing any tenant-scoped code, get answers to:

1. **What defines a tenant?** A `tenant_id` column? A schema per
   customer? A separate account? A hierarchical org (parent tenant
   with child sub-tenants)? The choice affects hash-key composition
   and RLS strategy.
2. **Are business keys globally unique or tenant-scoped?** Tenant A's
   `customer_id=C-100` and Tenant B's `customer_id=C-100` — are they
   the same real-world customer or different customers who happen to
   share an ID? The overwhelmingly common answer for SaaS is
   *different*. If wrong, you conflate customers across tenants and
   the vault is unfixable.
3. **Can data cross tenants?** Is there ever a legitimate case where
   Tenant A's data joins to Tenant B's — a marketplace fact, a
   partnership relation, a shared reference tenant? Rare but
   consequential; the same-as-link pattern is *forbidden* across
   tenants without an explicit cross-tenant relationship model.
4. **What's the tenant lifecycle?** How is a new tenant onboarded?
   Offboarded? Suspended? Merged into another tenant? Split? Each
   is a real event; the vault design must handle them.
5. **What's the tenant deletion SLA?** Some contracts require
   30-day tenant-data deletion on offboarding. That interacts
   directly with the erasure patterns in
   [governance-and-compliance.md](governance-and-compliance.md).
6. **Which access model?** Shared warehouse with RLS? Separate
   schemas per tenant? Separate warehouses per tenant? Each has
   very different cost, complexity, and blast-radius properties.
7. **Are tenants themselves data subjects?** Under GDPR, a corporate
   tenant is not a data subject; the *individuals inside the tenant*
   are. This affects erasure scoping.

**Do not proceed without answers.** Tenant-model mistakes are the
single most expensive class of DV bug because retrofitting requires
rehashing every hub, link, and satellite.

---

## The Core Rule — Tenant-Scoped Hash Keys

The moment two tenants share a business key namespace, `customer_hk`
must include `tenant_id` as part of the hash input:

```sql
-- Wrong for multi-tenant — Tenant-A's C-100 and Tenant-B's C-100 collide
{{ dv_hash_bk(['customer_id']) }}

-- Right for multi-tenant — customer_hk is tenant-scoped
{{ dv_hash_bk(['tenant_id', 'customer_id']) }}
```

**Every hub, link, satellite, and reference table** in a multi-tenant
vault includes `tenant_id` in its identity where the concept is
tenant-scoped. The macro layer makes this uniform:

```sql
{% macro dv_tenant_hash_bk(columns) %}
    {#- Tenant-scoped hash — enforces tenant_id as the first hash part. #}
    {%- set parts = ['tenant_id'] + columns -%}
    {{ dv_hash_bk(parts) }}
{% endmacro %}
```

Call `dv_tenant_hash_bk` everywhere in a multi-tenant project. Never
call the plain `dv_hash_bk` directly for tenant-scoped concepts — a
single mistake fragments the hub.

### Not Every Concept Is Tenant-Scoped

Reference data (country codes, currency codes, product catalog if it's
shared across tenants) is tenant-*independent*. Use plain `dv_hash_bk`.

Rule of thumb:
- **Tenant-scoped:** `hub_customer`, `hub_order`, `hub_user`,
  `hub_workspace`, anything the tenant creates or owns.
- **Tenant-independent:** `ref_country`, `ref_currency`, `ref_calendar`,
  `hub_product` (if catalog is shared), `hub_data_center` (infrastructure).

**Ask the user per hub.** A "product" hub might be tenant-scoped in
a SaaS-marketplace or tenant-independent in a shared-catalog SaaS.

---

## Tenant Column on Every Row

Even with tenant-scoped hash keys, store `tenant_id` as a **first-class
column** on every hub/link/satellite row. Two reasons:

1. **RLS policies** filter on `tenant_id`, not on hash. Without the
   column, no way to attach a row-level-security predicate.
2. **Debugging.** "Which tenant does this row belong to?" is asked
   every day. Answering via reverse-hashing is impossible.

```sql
-- hub_customer.sql
SELECT
    {{ dv_tenant_hash_bk(['customer_id']) }} AS customer_hk,
    tenant_id                                AS tenant_id,
    customer_id                              AS customer_bk,
    '{{ run_started_at }}'::TIMESTAMP        AS load_dts,
    'crm.customers'                          AS record_source
FROM {{ ref('stg_crm__customers__hashed') }}
WHERE customer_id IS NOT NULL
  AND tenant_id IS NOT NULL
```

Note the NULL filter on `tenant_id`. A row with no tenant is a bug —
route it to the error mart, do not silently drop.

---

## Row-Level Security Policies

Every warehouse has RLS. Enforce `tenant_id`-based filtering as an
enforced policy attached to every tenant-scoped table.

### Snowflake

```sql
CREATE OR REPLACE ROW ACCESS POLICY tenant_isolation
    AS (tenant_id VARCHAR) RETURNS BOOLEAN ->
    tenant_id = CURRENT_ACCOUNT_TENANT_TAG()   -- or from a session var
       OR IS_ROLE_IN_SESSION('CROSS_TENANT_ADMIN');

ALTER TABLE raw_vault.hub_customer
    ADD ROW ACCESS POLICY tenant_isolation ON (tenant_id);
```

`CURRENT_ACCOUNT_TENANT_TAG()` is a session variable your app layer
sets on connect. The `CROSS_TENANT_ADMIN` role is the escape hatch
for platform engineering; grants to it must be audited.

### BigQuery — Row-Level Security via Policy Tags

```sql
CREATE ROW ACCESS POLICY tenant_isolation
    ON `project.raw_vault.hub_customer`
    GRANT TO ('user:app-service-account@example.iam.gserviceaccount.com')
    FILTER USING (tenant_id = SESSION_USER());
```

Combined with column-level access via Policy Tags for PII (see
[governance-and-compliance.md](governance-and-compliance.md)).

### Databricks — Row Filter + Dynamic View

```sql
CREATE OR REPLACE FUNCTION tenant_filter(tenant_id STRING)
RETURN CASE WHEN is_account_group_member('cross_tenant_admin') THEN TRUE
            ELSE tenant_id = current_user_tenant() END;

ALTER TABLE raw_vault.hub_customer
    SET ROW FILTER tenant_filter ON (tenant_id);
```

### Redshift / Postgres — RLS Native

Both support native `CREATE POLICY` with `USING (tenant_id = ...)`.
See [redshift-specific.md](redshift-specific.md) and
[postgres-specific.md](postgres-specific.md).

### MS Fabric — RLS via SQL Analytics Endpoint

`CREATE SECURITY POLICY` in Fabric Warehouse; Direct Lake honors the
policy for Power BI consumers.

---

## Cross-Tenant Same-As Links — Prohibited by Default

The same-as link pattern (deduplicating logically-equivalent business
keys) is safe within a tenant. Across tenants, it's usually forbidden
by contract — Tenant A's customer being linked to Tenant B's customer
is a data leak.

**Rule:** unless the business explicitly authorizes cross-tenant
linkage (e.g., a cross-tenant marketplace or a "customer 360" that
consolidates data with subject consent), same-as links must have a
constraint:

```sql
-- lnk_same_as_customer.sql
SELECT ...
FROM matches
WHERE master_tenant_id = duplicate_tenant_id;   -- explicit intra-tenant only
```

Add a CI test that fails if any same-as link row has different
tenant IDs on its two sides.

### Cross-Tenant Relationships That Are Legitimate

For genuinely cross-tenant relationships (a marketplace transaction
between buyer-tenant and seller-tenant), model them as a specific
`lnk_marketplace_transaction` link that hashes over both tenant IDs
and both business keys, with explicit contractual documentation.
Don't reuse the same-as pattern.

---

## Tenant Lifecycle Events

Tenants have their own hub. Their lifecycle events (onboarded,
suspended, offboarded, merged, split) drive vault design.

### hub_tenant

```sql
-- Independent of any specific tenant's data — this is the meta-hub.
SELECT
    {{ dv_hash_bk(['tenant_id']) }} AS tenant_hk,
    tenant_id                       AS tenant_bk,
    load_dts,
    record_source
FROM {{ ref('stg_platform__tenants') }}
WHERE tenant_id IS NOT NULL
```

### sat_tenant_status

Records lifecycle transitions. Status enum: `ACTIVE`, `SUSPENDED`,
`OFFBOARDING`, `OFFBOARDED`, `MERGED`, `SPLIT`.

- `SUSPENDED`: tenant queries return no rows (RLS refuses); vault
  still loads their data.
- `OFFBOARDING`: countdown started per contractual SLA (30/60 days
  typical). Erasure pipeline scheduled.
- `OFFBOARDED`: all tenant PII erased per erasure strategy;
  business-audit satellite retained for legal retention.
- `MERGED`: same-as link at the tenant hub level connecting the
  merged pair.

### lnk_tenant_merged / lnk_tenant_hierarchy

If tenants can merge or nest, model those as vault links. Documentation
of merge event goes in a satellite off the link.

**Ask the user:** *"Can tenants be renamed? Merged? Split? Do you
have a system-of-record for tenant events, or is that something
we're building fresh?"*

---

## Per-Tenant Retention

Some contracts require different retention per tenant tier (Gold
tenants retained 7 years, Free tenants retained 90 days).
Retention is a compliance-vault concern, not a raw-vault concern —
you don't delete data from the raw vault based on tenant tier.

Instead:
- Metadata table `compliance.tenant_retention_policy` (retention
  days per tenant).
- Scheduled purge job that reads the policy and applies the
  purge macro (see [governance-and-compliance.md](governance-and-compliance.md))
  to tenants that exceeded their retention window.
- Insert-only audit trail of every purge action.

**Ask the user:** *"Do all tenants share the same retention, or is
retention tier-dependent? If tier-dependent, where does the tier
live — in the tenant hub? In a business-vault satellite? In an
external system?"*

---

## Tenant-Isolated Ingestion

Even with tenant_id on every row, if ingestion is via a single
CDC pipeline, a bug in the source can cross-contaminate tenants
before the vault ever sees the row.

Two defense layers:

**Layer 1 — landing-table check.** Before loading into vault
staging, assert that `tenant_id` matches an expected value or set.
For per-tenant Kafka topics, the topic name should map to the
tenant; if a message's payload `tenant_id` disagrees, quarantine.

**Layer 2 — hub load-time check.** Any hub row whose `tenant_id`
isn't in `hub_tenant` gets routed to the error mart, not loaded.

```sql
-- hub_customer.sql (add)
INNER JOIN {{ ref('hub_tenant') }} t
    ON hashed.tenant_id = t.tenant_bk
```

---

## Multi-Tenant Marts

Marts either:

**Pattern A — one mart, RLS-filtered.** Single `dim_customer` mart;
every query filters to the caller's tenant via RLS. Simplest;
most enterprises use this.

**Pattern B — per-tenant materialized marts.** One mart schema
per tenant. Higher isolation; costlier storage; needed when
tenants have wildly different mart shapes or where compliance
requires physical separation.

**Pattern C — hybrid.** Shared marts for common analytics; dedicated
per-tenant marts for tenants that pay for advanced analytics.

Default to **A** unless there's a specific reason otherwise.

---

## Testing Multi-Tenancy

Every multi-tenant project needs at least these tests:

```yaml
tests:
  # No tenant_id NULL in any tenant-scoped table
  - not_null:
      column_name: tenant_id
      config:
        severity: error

  # Cross-tenant same-as link prohibited
  - assert_no_cross_tenant_same_as:
      link_model: lnk_same_as_customer

  # Every tenant_id in hub_customer exists in hub_tenant
  - relationships:
      to: ref('hub_tenant')
      field: tenant_bk
      column_name: tenant_id
```

Add a **synthetic tenant-isolation test** that simulates a query as
Tenant A and asserts zero Tenant B rows return.

---

## Common Multi-Tenancy Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Global `customer_hk = MD5(customer_id)` in multi-tenant vault | Tenants collide; unfixable retroactively | `dv_tenant_hash_bk` always; document choice explicitly |
| `tenant_id` in the hash but not as a column | Can't attach RLS policies | Always store both |
| Same-as links spanning tenants | Data leak; possible contract breach | Constrain to intra-tenant; CI test to enforce |
| Retention set at raw-vault level | Can't differentiate tiers | Retention is a compliance-layer concern |
| Missing tenant lifecycle model | Merges/splits become manual data-plumbing projects | hub_tenant + sat_tenant_status from day 1 |
| RLS enforced only at mart layer | Vault engineers see all tenants → insider risk | RLS on the vault tables themselves |
| Assuming tenant_id is stable | Tenant renames/merges break hash keys | Introduce a stable `tenant_hk` from a hub_tenant, reference that from other hubs' hashes |
| One shared reference table with tenant-specific overrides | Overrides leak across tenants | Global ref_ tables tenant-independent; tenant-specific ref lives in a `sat_tenant_settings` |
| No error routing for NULL tenant_id | Rows silently dropped or default to a "ghost tenant" | Explicit rejection into error mart with a code like `tenant_id_missing` |
| Cross-tenant admin role used casually | Insider-risk / audit hole | Role grants require ticket + expire; every use is audited |
| Marts built without knowing which pattern (A/B/C) | Ad-hoc marts miss RLS or overspend on per-tenant storage | Choose the pattern deliberately with the user |
| Assuming tenant is always a corporate customer | Sometimes tenants are internal orgs, individuals, or projects | Ask what defines a tenant before modeling |
