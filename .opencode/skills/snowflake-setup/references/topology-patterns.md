# Database Topology Patterns

## Pattern A — Medallion (Bronze / Silver / Gold)

Best for: Teams using dbt, centralized data platform, single source of truth.

```
BRONZE (RAW)          — raw ingestion, one schema per source, never transformed
SILVER (TRANSFORM)    — dbt staging + intermediate, cleaned but not aggregated
GOLD (ANALYTICS)      — dbt marts, business-ready, consumed by BI and analysts
```

```sql
-- Database names
CREATE DATABASE BRONZE  COMMENT = 'Raw ingestion layer';
CREATE DATABASE SILVER  COMMENT = 'Cleaned and conformed data';
CREATE DATABASE GOLD    COMMENT = 'Business-ready marts';

-- Schema structure within BRONZE
CREATE SCHEMA BRONZE.SALESFORCE;
CREATE SCHEMA BRONZE.STRIPE;
CREATE SCHEMA BRONZE.POSTGRES_APP;

-- Schema structure within SILVER
CREATE SCHEMA SILVER.STAGING;
CREATE SCHEMA SILVER.INTERMEDIATE;

-- Schema structure within GOLD
CREATE SCHEMA GOLD.CORE;       -- shared dimensions (customers, products)
CREATE SCHEMA GOLD.FINANCE;    -- finance-domain marts
CREATE SCHEMA GOLD.MARKETING;  -- marketing-domain marts
```

**Naming convention in dbt:**
- `BRONZE` → `sources:` in `sources.yml`
- `SILVER.STAGING` → `stg_*` models
- `SILVER.INTERMEDIATE` → `int_*` models
- `GOLD.*` → `dim_*`, `fct_*`, `mart_*` models

## Pattern B — Functional (RAW / TRANSFORM / ANALYTICS)

Best for: Teams familiar with Kimball/Inmon, or already using this naming convention.

```
RAW         — same as BRONZE
TRANSFORM   — same as SILVER
ANALYTICS   — same as GOLD
```

Structurally identical to Medallion, just different database names. Pick one and be consistent across the org.

## Pattern C — Domain-per-Database (for large multi-team orgs)

Best for: Organizations where finance, marketing, and engineering each own their own data pipelines with separate access boundaries.

```
RAW                    — shared ingestion layer (all sources)
TRANSFORM              — shared transformation layer
ANALYTICS_FINANCE      — finance domain only
ANALYTICS_MARKETING    — marketing domain only
ANALYTICS_ENGINEERING  — engineering metrics
```

This gives domain teams autonomy to create schemas and tables in their own database without interfering with each other. RBAC maps cleanly: `FINANCE_ROLE` gets USAGE on `ANALYTICS_FINANCE`, not on `ANALYTICS_MARKETING`.

## Pattern D — Data Vault 2.0

Best for: Regulated industries (finance, healthcare, insurance), teams that need source-of-record auditability with insert-only history, or organizations conforming multiple systems into a single business ontology.

Data vault 2.0 introduces a distinct middle layer between raw ingestion and consumption-ready marts. See `data-vault-patterns.md` for full modeling patterns; the database layout is:

```
RAW                — raw ingestion, insert-only, per-source schemas (same as other topologies)
RAW_VAULT          — hubs, links, and satellites populated directly from RAW
BUSINESS_VAULT     — computed satellites, PIT tables, bridge tables (business logic layer)
INFO_MARTS         — dimensional / OBT views built for BI consumption
```

Schema conventions inside `RAW_VAULT`:
```sql
CREATE DATABASE RAW_VAULT      COMMENT = 'Data Vault 2.0 raw vault — insert-only';

CREATE SCHEMA RAW_VAULT.HUBS;         -- one row per unique business key
CREATE SCHEMA RAW_VAULT.LINKS;        -- associations between hubs
CREATE SCHEMA RAW_VAULT.SATELLITES;   -- descriptive attributes, hash-diffed
```

Table naming inside those schemas:
```
HUBS.HUB_CUSTOMER              -- HK_CUSTOMER, BK_CUSTOMER_ID, LOAD_DATE, RECORD_SOURCE
LINKS.LINK_CUSTOMER_ORDER      -- HK_LINK, HK_CUSTOMER, HK_ORDER, LOAD_DATE, RECORD_SOURCE
SATELLITES.SAT_CUSTOMER_DTLS   -- HK_CUSTOMER, LOAD_DATE, HASHDIFF, <attrs>, RECORD_SOURCE
```

**Why this shape matters:**
- **Insert-only** — history is preserved by construction; audit-friendly
- **Hash keys** (`HK_*` = MD5 or SHA256 of business keys) — decouple loads from foreign keys; parallel loads become safe
- **HASHDIFF on satellites** — skip unchanged rows on load; storage efficiency at scale
- **RECORD_SOURCE column everywhere** — every row traceable to its origin system

**Trade-offs vs Medallion/Functional:**
- Storage is higher (append-only satellites, hash key overhead) — plan larger LOADING_WH monitor budgets
- Query complexity is higher — INFO_MARTS layer is mandatory, not optional, to keep BI usable
- Onboarding is steeper — team should have DV2 experience or budget training time
- Tooling: requires a dbt vault package (`AutomateDV`, `dbtvault`, or hand-rolled macros)

## Environment Promotion with Zero-Copy Clones

```sql
-- Create dev environment as instant zero-copy clones of prod
CREATE DATABASE RAW_DEV CLONE RAW;
CREATE DATABASE TRANSFORM_DEV CLONE TRANSFORM;
CREATE DATABASE ANALYTICS_DEV CLONE ANALYTICS;

-- Grant dev roles access to dev databases
GRANT USAGE ON DATABASE RAW_DEV       TO ROLE DATA_PLATFORM_ADMIN;
GRANT USAGE ON DATABASE TRANSFORM_DEV TO ROLE DATA_PLATFORM_ADMIN;
GRANT USAGE ON DATABASE ANALYTICS_DEV TO ROLE DATA_PLATFORM_ADMIN;
GRANT ALL ON DATABASE ANALYTICS_DEV   TO ROLE TRANSFORM_ROLE;  -- dbt CI can write here

-- In dbt profiles.yml — switch database by target
# dev target
dev:
  type: snowflake
  database: ANALYTICS_DEV
  schema: "{{ target.schema }}"

# prod target
prod:
  type: snowflake
  database: ANALYTICS
  schema: "{{ target.schema }}"
```

Zero-copy clones are instantaneous and cost only the storage delta from the clone point — a full prod clone for dev is essentially free.

## Warehouse Sizing Guide

| Workload | Size | Concurrent queries | When to scale up |
|----------|------|-------------------|-----------------|
| Dev / exploration | XS | 1–2 | Almost never needed |
| Data loading (Snowpipe / COPY) | XS–S | 2–4 | Files > 1 GB, parallel loads |
| dbt transformations (small models) | S | 2–4 | Build times > 10 min |
| dbt transformations (large models, complex joins) | M–L | 4–8 | Build times > 20 min |
| BI dashboard queries (Tableau, Looker) | M | 4–8 | Dashboard load time > 10s |
| Ad-hoc analyst queries | M | 4–8 | Significant queue wait time |
| Large batch / ML feature engineering | L–XL | 8–16 | Query runtime > 30 min |

**Rule of thumb:** Start at XS or S. Watch `QUERY_HISTORY` for `QUEUED_OVERLOAD_TIME > 0` — that's your signal to size up, not gut feel.

## Multi-Cluster Warehouse (for BI concurrency)

Only needed when many concurrent users hit the same warehouse. Set up after you've confirmed queuing is the bottleneck, not query size.

```sql
CREATE WAREHOUSE BI_WH
  WAREHOUSE_SIZE = 'MEDIUM'
  MIN_CLUSTER_COUNT = 1
  MAX_CLUSTER_COUNT = 3              -- add clusters when queue builds
  SCALING_POLICY = 'ECONOMY'        -- spin up only when actually needed
  AUTO_SUSPEND = 300
  AUTO_RESUME = TRUE;
```

`ECONOMY` scaling waits until a cluster is fully loaded before spinning up another. Use `STANDARD` if you need near-zero queue wait for executive dashboards.
