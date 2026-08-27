# Data Vault 2.0 Patterns

Detailed modeling and DDL patterns for teams choosing Pattern D (Data Vault 2.0) in `topology-patterns.md`. This reference is only loaded when the user selects `data-vault-2` in the topology question.

## Layer Responsibilities

```
RAW ──► RAW_VAULT ──► BUSINESS_VAULT ──► INFO_MARTS ──► BI / consumers
 │         │              │                 │
 │         │              │                 └─ Dimensional / OBT views. Consumption-optimized.
 │         │              │                    Denormalized. May include masking policies.
 │         │              └─ Computed satellites, PIT tables, bridges. Business rules applied.
 │         │                 Read-only by consumers; write access to BUSINESS_VAULT_BUILDER role.
 │         └─ Hubs, Links, Satellites. Insert-only. Direct 1:1 with source systems.
 │            Never mutated after load. Retained for audit.
 └─ Raw ingestion. Same as other topologies. Loader roles write here.
```

## Hub Pattern

One row per unique business key. Immutable once inserted.

```sql
CREATE TABLE RAW_VAULT.HUBS.HUB_CUSTOMER (
  HK_CUSTOMER      VARCHAR(32)   NOT NULL,   -- MD5(business_key)
  BK_CUSTOMER_ID   VARCHAR       NOT NULL,   -- the natural business key
  LOAD_DATE        TIMESTAMP_LTZ NOT NULL,
  RECORD_SOURCE    VARCHAR       NOT NULL,   -- e.g. 'salesforce.contacts'
  CONSTRAINT PK_HUB_CUSTOMER PRIMARY KEY (HK_CUSTOMER)
)
CLUSTER BY (HK_CUSTOMER);
```

**Load pattern** (insert-only, dedupe by hash key):

```sql
INSERT INTO RAW_VAULT.HUBS.HUB_CUSTOMER
SELECT
  MD5(customer_id)                    AS HK_CUSTOMER,
  customer_id                         AS BK_CUSTOMER_ID,
  CURRENT_TIMESTAMP()                 AS LOAD_DATE,
  'salesforce.contacts'               AS RECORD_SOURCE
FROM RAW.SALESFORCE.CONTACTS src
WHERE NOT EXISTS (
  SELECT 1 FROM RAW_VAULT.HUBS.HUB_CUSTOMER h
  WHERE h.HK_CUSTOMER = MD5(src.customer_id)
);
```

## Link Pattern

Associates two or more hubs. Insert-only.

```sql
CREATE TABLE RAW_VAULT.LINKS.LINK_CUSTOMER_ORDER (
  HK_LINK          VARCHAR(32)   NOT NULL,   -- MD5(HK_CUSTOMER || '|' || HK_ORDER)
  HK_CUSTOMER      VARCHAR(32)   NOT NULL,
  HK_ORDER         VARCHAR(32)   NOT NULL,
  LOAD_DATE        TIMESTAMP_LTZ NOT NULL,
  RECORD_SOURCE    VARCHAR       NOT NULL,
  CONSTRAINT PK_LINK_CUSTOMER_ORDER PRIMARY KEY (HK_LINK)
)
CLUSTER BY (HK_CUSTOMER, HK_ORDER);
```

## Satellite Pattern

Descriptive attributes with hash-diff for change detection. Multiple satellites per hub allowed (split by source system or update cadence).

```sql
CREATE TABLE RAW_VAULT.SATELLITES.SAT_CUSTOMER_DETAILS (
  HK_CUSTOMER      VARCHAR(32)   NOT NULL,
  LOAD_DATE        TIMESTAMP_LTZ NOT NULL,
  HASHDIFF         VARCHAR(32)   NOT NULL,   -- MD5(concat of all attribute cols)
  FIRST_NAME       VARCHAR,
  LAST_NAME        VARCHAR,
  EMAIL            VARCHAR,
  PHONE            VARCHAR,
  RECORD_SOURCE    VARCHAR       NOT NULL,
  CONSTRAINT PK_SAT_CUSTOMER_DETAILS PRIMARY KEY (HK_CUSTOMER, LOAD_DATE)
)
CLUSTER BY (HK_CUSTOMER);
```

**Load pattern** — only insert when HASHDIFF changed:

```sql
INSERT INTO RAW_VAULT.SATELLITES.SAT_CUSTOMER_DETAILS
WITH src AS (
  SELECT
    MD5(customer_id)                                    AS HK_CUSTOMER,
    CURRENT_TIMESTAMP()                                 AS LOAD_DATE,
    MD5(CONCAT_WS('|', first_name, last_name, email, phone))
                                                        AS HASHDIFF,
    first_name, last_name, email, phone,
    'salesforce.contacts'                               AS RECORD_SOURCE
  FROM RAW.SALESFORCE.CONTACTS
),
latest AS (
  SELECT HK_CUSTOMER, HASHDIFF
  FROM RAW_VAULT.SATELLITES.SAT_CUSTOMER_DETAILS
  QUALIFY ROW_NUMBER() OVER (PARTITION BY HK_CUSTOMER ORDER BY LOAD_DATE DESC) = 1
)
SELECT src.*
FROM src
LEFT JOIN latest ON src.HK_CUSTOMER = latest.HK_CUSTOMER
WHERE latest.HASHDIFF IS NULL          -- first load
   OR latest.HASHDIFF <> src.HASHDIFF; -- attributes changed
```

## RBAC for Data Vault

Additional roles beyond the standard set:

```
VAULT_LOADER_ROLE
  ├─ INSERT on RAW_VAULT.HUBS.*, RAW_VAULT.LINKS.*, RAW_VAULT.SATELLITES.*
  ├─ SELECT on RAW.*
  └─ USAGE on LOADING_WH

BUSINESS_VAULT_BUILDER_ROLE
  ├─ SELECT on RAW_VAULT.*
  ├─ ALL on BUSINESS_VAULT.*
  └─ USAGE on TRANSFORM_WH

MART_BUILDER_ROLE
  ├─ SELECT on RAW_VAULT.*, BUSINESS_VAULT.*
  ├─ ALL on INFO_MARTS.*
  └─ USAGE on TRANSFORM_WH

ANALYST_ROLE (consumers)
  ├─ SELECT on INFO_MARTS.*    -- default consumers see only marts
  └─ SELECT on BUSINESS_VAULT.* (opt-in; power users only)
  -- Note: no direct access to RAW_VAULT.* for consumers; forces mart usage
```

**Insert-only enforcement**: revoke UPDATE and DELETE on RAW_VAULT explicitly, even if the loader role wouldn't normally have them, as a defense-in-depth measure:

```sql
REVOKE UPDATE, DELETE ON ALL TABLES IN SCHEMA RAW_VAULT.HUBS FROM ROLE VAULT_LOADER_ROLE;
REVOKE UPDATE, DELETE ON ALL TABLES IN SCHEMA RAW_VAULT.LINKS FROM ROLE VAULT_LOADER_ROLE;
REVOKE UPDATE, DELETE ON ALL TABLES IN SCHEMA RAW_VAULT.SATELLITES FROM ROLE VAULT_LOADER_ROLE;
```

## Governance for Data Vault

**PII placement decision.** In DV2 you have three options for where to apply masking:

1. **RAW_VAULT satellites** — mask at the earliest possible layer; auditors see masked values in the vault; strict interpretation of least-privilege
2. **BUSINESS_VAULT / INFO_MARTS only** — RAW_VAULT stays plaintext for compliance / breach-response needs; access to RAW_VAULT is heavily restricted to auditors + platform admins only
3. **Column-level in RAW_VAULT + row-access in INFO_MARTS** — hybrid: mask sensitive attributes at load, restrict rows at consumption

Recommended default: **option 2** for regulated industries (finance, healthcare) where full source fidelity is a compliance requirement; **option 1** for other use cases. The skill asks the user which they want.

## dbt Package Recommendation

Two mature packages generate DV2 boilerplate:

- **AutomateDV** (formerly dbtvault) — active, supports Snowflake/BigQuery/Databricks, extensive macros
- **dbtvault** (original) — largely superseded by AutomateDV; use only if already deployed

The skill emits stub `dbt_project.yml`, `packages.yml`, and one example hub/link/satellite model per source. It does NOT auto-generate a full vault schema — that requires source analysis the skill doesn't have.

Example `packages.yml`:
```yaml
packages:
  - package: Datavault-UK/automate_dv
    version: 0.11.0
```

Example hub model (`models/raw_vault/hubs/hub_customer.sql`):
```sql
{{- config(materialized='incremental', unique_key='hk_customer', on_schema_change='fail') -}}

{{- automate_dv.hub(
    src_pk="hk_customer",
    src_nk="bk_customer_id",
    src_ldts="load_date",
    src_source="record_source",
    source_model="stg_customers"
) -}}
```

## Cost Profile

DV2 storage and compute are meaningfully higher than Medallion/Functional. Adjust warehouse budgets:

| Warehouse | Medallion baseline | DV2 adjustment |
|-----------|-------------------|----------------|
| LOADING_WH | 10–25 credits/month | 25–50 (satellite hash-diff compute) |
| TRANSFORM_WH | 50–150 | 100–300 (vault + mart layers) |
| ANALYTICS_WH | 75–200 | 75–200 (same — INFO_MARTS presents pre-computed views) |
| Storage | baseline | +30–50% (append-only satellites) |

## Ingestion Pattern Differences

- **Snowpipe / Task+COPY into RAW** — unchanged (same as any topology)
- **RAW → RAW_VAULT** — done by dbt (or Snowflake tasks) using the hub/link/satellite patterns above; run frequently (hourly for hot data, nightly for reference data)
- **RAW_VAULT → BUSINESS_VAULT** — dbt models; often run once per day
- **BUSINESS_VAULT → INFO_MARTS** — dbt models; may materialize as tables (nightly) or views (real-time)

## Common Data Vault Mistakes

### Mistake 1: Using natural keys as primary keys
**Symptom:** Loads become dependent on foreign key relationships; parallel loads deadlock.
**Fix:** Always use hash keys (`HK_*`); hash keys let hubs, links, and satellites load independently.

### Mistake 2: Skipping HASHDIFF on satellites
**Symptom:** Satellites grow linearly with load frequency instead of change frequency; storage explodes.
**Fix:** Always compute and store HASHDIFF; only insert when HASHDIFF differs from the latest row for that hash key.

### Mistake 3: Consumers querying RAW_VAULT directly
**Symptom:** BI tools crash on 5-way joins across hubs/links/satellites; analysts write incorrect queries.
**Fix:** Route all consumption through INFO_MARTS (dimensional or one-big-table views). RAW_VAULT is a modeling layer, not a query layer.

### Mistake 4: Mixing insert-only and mutable in RAW_VAULT
**Symptom:** Audit trail broken; row counts don't reconcile against source systems.
**Fix:** Enforce insert-only via REVOKE UPDATE / DELETE on the loader role. Even reference-data changes go through a new satellite record with a new LOAD_DATE.

### Mistake 5: Hashing without a delimiter
**Symptom:** `MD5(first_name || last_name)` collisions — "John|Doe" and "JohnD|oe" produce the same hash.
**Fix:** Always use a delimiter (`|`, `~`, or `\x1f`) in `CONCAT_WS` when building hash inputs.
