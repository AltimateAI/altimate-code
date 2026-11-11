---
name: data-vault
applyPaths:
  - "dbt_project.yml"
  - "**/dbt_project.yml"
description: |
  REQUIRED before designing, generating, or modifying ANY Data Vault 2.0
  artifact (hub, link, satellite, reference table, PIT, bridge, business
  vault, information mart, metrics vault, error mart). Invoke this skill
  FIRST whenever a task mentions "data vault", "DV 2.0", "hub", "link",
  "satellite", "hashdiff", "hashkey", "raw vault", "business vault",
  "reference table", "PIT table", "bridge table", "record tracking",
  "status tracking", "effectivity satellite", "multi-active", "bi-temporal",
  "hard rules", "soft rules", "ghost record", "zero key", or asks to model
  a source into an insert-only historized store.

  Comprehensively covers the practices from Linstedt & Olschimke's
  "Building a Scalable Data Warehouse with Data Vault 2.0":
  hub / link / satellite modeling, hash-key + hashdiff discipline,
  hard-vs-soft rule separation, two-stage staging, ghost / zero / error
  keys, reference tables (no-history + historized), record-tracking and
  status-tracking satellites, effectivity satellites, multi-active
  satellites, bi-temporal historization, PIT + bridge, raw vault vs.
  business vault vs. information mart, computed / exploration / same-as /
  interface / rule links, metrics vault + error mart, real-time loading
  + virtualization, and Scrum-for-DW methodology.

  The default dbt / medallion skills work fine for Kimball, medallion, and
  OBT layouts, but they produce silently wrong Data Vault models. DV 2.0
  has strict grain, insert-only, hash-key, load-metadata, and hard/soft-rule
  rules that standard staging → mart patterns violate. Skipping this skill
  is the leading cause of:

  • Soft rules leaked into staging or raw vault (filters, coalesces,
    derivations that discard information and break auditability)
  • Hubs with duplicate business keys (missing DISTINCT on load, or joining
    before hashing)
  • Links whose grain is wrong (missing a driver key, or one hash key per
    partner instead of one composite hash)
  • Satellites that lose history (using MERGE on the business key instead
    of insert-only on hashdiff change)
  • Hash collisions from inconsistent business-key normalization (case,
    trim, NULL sentinel, delimiter)
  • Hashdiff false-negatives that skip real changes (columns hashed in
    unstable order, or trailing-NULL truncation)
  • Load date confusion (using source `updated_at` as `load_dts`, breaking
    audit and re-runnability, and preventing bi-temporal analysis)
  • Missing ghost / zero keys so mart LEFT JOINs return NULL columns
  • PIT/bridge tables that don't line up with satellite effectivity, so
    downstream marts see phantom rows on the boundary
  • No metrics vault or error mart, so silent load failures go undetected
  • Wrong package: reaching for `dbt_utils` macros when AutomateDV
    (formerly dbtvault) or datavault4dbt already provides the correct macro

  Do not start writing DV SQL until this skill is loaded. Powered by
  altimate-dbt and altimate-core.
---

# Data Vault 2.0 Modeling

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** bash (runs `altimate-dbt` commands), read, glob, write, edit, schema_search, dbt_profiles, sql_analyze, altimate_core_validate, altimate_core_column_lineage

## When to Use This Skill

**Use when the user wants to:**
- Design a Data Vault 2.0 model from a source system (identify hubs / links / satellites)
- Generate hub, link, satellite, effectivity satellite, multi-active satellite, record-tracking satellite, or status-tracking satellite SQL
- Build reference tables (no-history or historized) for lookup data
- Build Point-in-Time (PIT) or bridge tables on top of a raw vault
- Build a business vault (computed satellites, computed links, exploration links, business-rule links) on top of the raw vault
- Build information marts (dimensional, aggregated, OBT, exploration, application) on top of PIT / bridge tables
- Add a metrics vault + error mart for load observability and data-quality alerting
- Set up bi-temporal (business time + load time) historization for sources with retroactive corrections
- Set up a two-stage staging layer with hard-rule transformations and hashed-staging outputs
- Adopt real-time / near-real-time loading (Snowflake streams+tasks, dynamic tables, Databricks DLT)
- Virtualize marts (views over the vault) instead of materializing
- Migrate an existing Kimball or medallion model to Data Vault 2.0
- Adopt AutomateDV (formerly dbtvault) or datavault4dbt packages in a dbt project
- Implement DV 2.0 on Snowflake with streams + tasks, dynamic tables, or standard dbt runs
- Structure a DV 2.0 delivery in sprint-scoped, agile increments

**Do NOT use for:**
- Standard staging / intermediate / mart dbt work → use `dbt-develop`
- Bronze / silver / gold medallion layering → use `dbt-develop` medallion reference
- Kimball star schemas outside of a vault → use `dbt-develop`
- Adding tests to vault models → use `dbt-test` after this skill
- Debugging vault build failures → use `dbt-troubleshoot` after this skill

## The Non-Negotiable Rules of Data Vault 2.0

If you take away nothing else from this skill, take these seven rules.
Every downstream reference expands on them. Every pattern in this skill
is a consequence of them.

1. **Hubs are insert-only sets of unique business keys.** A hub has one
   row per business key, ever. Never update; never delete. If the
   business key already exists, do not re-insert it.
2. **Links are insert-only sets of unique key combinations.** A link has
   one row per unique combination of the business keys it relates. The
   link's grain is defined by the *set of hubs it connects*, plus any
   dependent-child keys (driver keys) that are part of the relationship's
   identity.
3. **Satellites are insert-only and historized by hashdiff.** A satellite
   inserts a new row *only when the hash of its descriptive columns
   changes*. Never update rows. Never delete rows. Historization comes
   from `load_dts` + `hashdiff`, not from a `valid_from` / `valid_to`
   pair on the same row.
4. **Every vault row carries three (or four) pieces of load metadata**:
   `load_dts` (when *we* loaded it), `record_source` (where it came
   from), `load_batch_id` (optional but strongly recommended — ties the
   row to a specific load event), and — for hubs / links — a hash key.
   Satellites also carry a `hashdiff`. These are computed at load time,
   not derived from source.
5. **Business keys are normalized before hashing.** Trim, uppercase (or
   lowercase — pick one and stick with it), replace NULL with a sentinel
   (typically `'^^'` or `'-1'`), concatenate with a stable delimiter
   (typically `'||'`), then hash. Every hub, link, and satellite that
   references the same business key must apply the *identical*
   normalization — otherwise the hash keys will not line up and joins
   will silently miss rows.
6. **Hard rules only in staging and raw vault; soft rules only in
   business vault or information mart.** Hard rules are reversible,
   information-preserving, and require no business judgment (type
   casting, hashing, load metadata). Soft rules discard information,
   require judgment, or embed business interpretation (filtering,
   coalescing between values, deduplicating "logically equivalent" rows,
   currency conversion, segmentation). Every transformation is one or
   the other; where it's allowed to live depends on which.
7. **Raw vault is source-shaped, not business-shaped.** The raw vault
   must be re-buildable from source, byte-for-byte, forever. This
   follows from rule 6 — no soft rules in raw vault means the vault is
   a source snapshot, not an interpretation.

Violating any of these produces a model that looks like Data Vault but
does not behave like one — no audit trail, no re-runnability, no history.

## Core Workflow: Detect → Probe → Ask → Model → Discover → Generate → Load → Validate

### 0. Detect — Ask Which Platform Before Anything Else

**Do not start writing SQL, or picking macros, or citing dialect
patterns, until you know what platform the customer is on.** Data
Vault 2.0's shape is universal but the concrete implementation
(hash function, storage type, incremental strategy, real-time
mechanism, orchestration) is warehouse- and tool-specific. Guessing
here produces code that compiles on one platform and fails silently
or expensively on another.

**Ask the user two questions**, in this order:

1. **Orchestration / transformation tool:**
   - **dbt** (Core or Cloud) — the assumed default; most references
     in this skill use dbt Jinja + `is_incremental()` patterns.
   - **Coalesce, Matillion, dbt-labs Fusion, or another
     transformation IDE** — the vault SQL patterns still apply, but
     macros / templating differ.
   - **Native SQL** orchestrated by Airflow / Dagster / Snowflake
     Tasks / Azure Data Factory / cron. See
     [references/native-sql-orchestration.md](references/native-sql-orchestration.md).
   - **A DV-specific automation tool** (WhereScape, VaultSpeed,
     Datavault Builder, biGENIUS) — they generate DV code
     directly; validate that its output matches the patterns in
     this skill, but don't hand-write against it.

2. **Warehouse / query engine:**
   - **Snowflake** → [references/snowflake-specific.md](references/snowflake-specific.md).
     Preferred hash: `MD5_BINARY(x)` → `BINARY(16)`. Real-time:
     streams + tasks or dynamic tables. Cost model:
     warehouse-time-based.
   - **Databricks (Lakehouse / Delta)** → [references/databricks-specific.md](references/databricks-specific.md).
     Preferred hash: `md5(x)` → `STRING` or `sha1(x)`. Real-time:
     Delta Live Tables + Structured Streaming. Cluster: `ZORDER BY`.
   - **Google BigQuery** → [references/bigquery-specific.md](references/bigquery-specific.md).
     Preferred hash: `MD5(x)` → `BYTES` (with `TO_HEX` when
     display needed). Real-time: streaming inserts + scheduled
     queries. Cluster: `CLUSTER BY`.
   - **Amazon Redshift** → [references/redshift-specific.md](references/redshift-specific.md).
     Preferred hash: `MD5(x)` → `VARCHAR(32)` (no binary type).
     Incremental strategy: delete+insert (limited MERGE). Cluster:
     `DISTKEY` + `SORTKEY`.
   - **Microsoft Fabric (Warehouse or Lakehouse)** → [references/ms-fabric-specific.md](references/ms-fabric-specific.md).
     Preferred hash: `HASHBYTES('MD5', x)` → `VARBINARY(16)`.
     Real-time: Fabric Data Pipelines + Direct Lake.
   - **PostgreSQL** → [references/postgres-specific.md](references/postgres-specific.md).
     Preferred hash: `MD5(x)` → `TEXT` or `decode(md5(x), 'hex')` →
     `BYTEA`. Suitable for small-to-medium DV (< ~1B rows).

**Ask, don't assume.** A user who says "we're on Snowflake" may be
using it via dbt Cloud or via Snowflake Tasks + native SQL —
different code, different reference file. Confirm both dimensions
before proceeding.

**If the user is on a combination not listed above** (e.g., Trino
over Iceberg, DuckDB for local dev + Snowflake in prod, a hybrid
lakehouse), pick the closest match, note the divergences, and flag
that the customer should validate the generated SQL against their
actual engine.

### 0.5 — Probe Enterprise Context

The default DV patterns cover single-team, single-tenant, low-
regulation projects. When any of the flags below apply, additional
references are required — do not silently omit them. Ask the user
directly:

1. **Regulated data / compliance regime?** "Does the data include
   PII, PHI, financial records, or is any regulatory regime (GDPR,
   CCPA, HIPAA, SOX, PCI-DSS, sectoral) in scope?" If yes, load
   [references/governance-and-compliance.md](references/governance-and-compliance.md).
2. **CDC / streaming source ingestion?** "Are sources coming from
   Debezium, GoldenGate, Fivetran/Airbyte CDC, Kafka, or paginated
   REST APIs?" If yes, load [references/cdc-and-streaming-sources.md](references/cdc-and-streaming-sources.md).
3. **Multi-tenant vault?** "Will this vault hold data for more
   than one customer/org/tenant that must be isolated from each
   other?" If yes, load [references/multi-tenancy.md](references/multi-tenancy.md).
4. **Shared hubs across multiple teams?** "Will hubs be referenced
   by more than one team's models, or are sources owned by teams
   outside the analytics org?" If yes, load [references/data-contracts-and-change-mgmt.md](references/data-contracts-and-change-mgmt.md).
5. **Existing MDM system?** "Do you have Informatica MDM, Reltio,
   Profisee, or another master-data platform emitting golden
   records the vault should consume?" If yes, load [references/mdm-integration.md](references/mdm-integration.md).
6. **Enterprise scale expected?** "Do you expect > 1B satellite
   rows total, > 50 feeds, or ops requirements like DR, cost
   attribution, freshness SLA dashboards?" If yes, load [references/scale-and-ops.md](references/scale-and-ops.md).

**Silence on any of these means "no"** — if the user genuinely
doesn't need a reference, don't burden the plan with it. But
default to asking. Assuming "no" and later discovering yes costs
significantly more than a 30-second question up front.

### Never Assume — Ask Before Making These Decisions

Even for non-enterprise projects, the following design decisions
are load-bearing and cannot be safely defaulted. Ask the user
explicitly before writing any code that depends on them:

**Hashing and identity (see [references/hashing-and-keys.md](references/hashing-and-keys.md))**
- Hash algorithm: MD5 / SHA-1 / SHA-256?
- Hash storage: binary or hex string?
- Business-key case: UPPER or LOWER project-wide?
- NULL sentinel: `'^^'`, `'-1'`, or something else?
- Delimiter: `'||'` or another?

**Business keys (see [references/source-modeling.md](references/source-modeling.md))**
- What is the *business*-facing key for each concept? (Not the
  source's surrogate PK; the identifier the business actually
  uses.)
- Are business keys stable across source-system migrations?
- For composite keys, what's the canonical part order?

**Grain and driver keys (see [references/link-patterns.md](references/link-patterns.md))**
- For each relationship, which keys are drivers (part of identity)
  vs. payload (belong in a satellite)?
- Is a given link transactional (immutable event) or standard
  (payload can change)?

**Satellite splits (see [references/satellite-patterns.md](references/satellite-patterns.md))**
- Which columns change at what cadence?
- What's the classification taxonomy? Which columns fall in which
  tier?
- Are any attributes multi-active (concurrent multiple values per
  parent)?

**Load semantics (see [references/loading-patterns.md](references/loading-patterns.md))**
- What's `load_dts` — the run's `run_started_at`, or something
  else?
- Is a `load_batch_id` needed for audit correlation?
- Are late-arriving records expected? If so, is bi-temporal
  historization required?

**Deletion and status (see [references/satellite-patterns.md](references/satellite-patterns.md))**
- Do sources emit deletion events? If so, are they hard deletes
  (rows removed) or soft (`is_deleted` flag)?
- Does the business need to detect deletion, or is "we stopped
  seeing this key" sufficient?

**Reference data (see [references/reference-tables.md](references/reference-tables.md))**
- Are lookup values (country codes, currency codes) tenant-
  independent or tenant-scoped?
- Do reference values ever change over time (historized) or are
  they no-history?

**Naming and layering**
- Uppercase (`HUB_CUSTOMER`) or lowercase (`hub_customer`) project-
  wide?
- Where do hubs / links / sats physically live — same schema, or
  segregated?
- Naming convention for business-vault objects (`bhub_` /
  `bsat_` / `blnk_`)?

**Delivery model (see [references/methodology-and-delivery.md](references/methodology-and-delivery.md))**
- What's the release cadence — every sprint, monthly, one-shot?
- Who owns the vault long-term — the analytics team, a platform
  team, or a consultant handoff?

**When in doubt, ask.** A wrong assumption on any of these
propagates through every hub/link/sat and is retroactively
expensive to fix (see [references/scale-and-ops.md](references/scale-and-ops.md)
for the rehashing playbook). A 30-second question is cheap.

### 1. Model — Identify Hubs, Links, and Satellites Before Writing SQL

Before writing any DV SQL, sit with the source and identify:

- **Every business key** in the source. A business key is what the
  business uses to identify a real-world thing (`order_number`,
  `customer_id`, `sku`, `email` — depending on the domain). Surrogate
  IDs from the source system are *not* business keys unless the business
  actually uses them to talk about the entity.
- **Every relationship** between business keys. Each unique combination
  becomes a link. A single source row often produces multiple links —
  an "order line" row typically feeds `LNK_ORDER_LINE_PRODUCT`,
  `LNK_ORDER_LINE_ORDER`, `LNK_ORDER_LINE_WAREHOUSE`, etc.
- **The grain of every descriptive attribute**. Attributes that change
  together at the same rate belong in the same satellite. Attributes
  that change on different cadences (e.g. billing address vs. loyalty
  tier) belong in separate satellites hanging off the same hub.
- **Driver keys.** For link tables, some keys are part of the
  relationship's identity (drivers) and some are payload. Only drivers
  belong in the link's hash key.

See [references/source-modeling.md](references/source-modeling.md) for
a step-by-step procedure with worked examples.

### 2. Discover — Understand the Data Before Writing

**Never write DV SQL without first querying the source.** DV models are
insert-only, so a wrong grain or wrong business key baked into a hub is
extraordinarily painful to fix — you'll be reloading history.

```bash
altimate-dbt info                                             # project name, adapter type
altimate-dbt columns-source --source <src> --table <tbl>      # source columns
altimate-dbt execute --query "SELECT * FROM {{ source('src','tbl') }}" --limit 20
altimate-dbt execute --query "SELECT COUNT(*), COUNT(DISTINCT <candidate_bk>) FROM {{ source('src','tbl') }}"
altimate-dbt column-values --source <src> --table <tbl> --column <candidate_bk>
```

Verify every one of these before writing SQL:

- **The business key is actually unique** (or intentionally versioned).
  If `SELECT COUNT(*), COUNT(DISTINCT bk) FROM source` returns different
  numbers, either the source has duplicates (dedupe on load) or your
  candidate key is not the real business key (find the real one).
- **The business key is never NULL** in rows you intend to load. A
  hub cannot have a NULL business key; if the source has them, either
  filter them out or use a "ghost" / "unknown" hub row with a fixed
  sentinel key.
- **Descriptive attributes have a stable cadence.** Query a few
  business keys' history in the source and look at which columns
  change together. That tells you how to split satellites.
- **Foreign relationships hold.** If you're modelling
  `LNK_ORDER_CUSTOMER`, every `customer_id` on an order should
  correspond to a row in the customer source, or you'll load link
  rows that dangle.

Use `schema_search` to find related tables in large warehouses that may
be candidates for hubs on the same business key from a different source
system — a hub is one business concept, potentially loaded from many
sources.

### 3. Generate — Follow the Vault Templates

DV SQL is templated. Every hub looks like every other hub; every link
looks like every other link. Do not invent new shapes — pick the
template and fill it in.

- See [references/staging-layer.md](references/staging-layer.md) for the two-stage staging pattern (Stage 1 mirror + Stage 2 hashed) that feeds every vault load.
- See [references/hard-vs-soft-rules.md](references/hard-vs-soft-rules.md) to decide where each transformation is allowed to live.
- See [references/hub-patterns.md](references/hub-patterns.md) for hub SQL and dbt config.
- See [references/link-patterns.md](references/link-patterns.md) for standard, transactional, hierarchical, same-as, and multi-way links.
- See [references/satellite-patterns.md](references/satellite-patterns.md) for standard, multi-active, effectivity, and status-tracking satellites.
- See [references/record-tracking-satellites.md](references/record-tracking-satellites.md) for RTS (record-tracking sats) and their pairing with STS.
- See [references/reference-tables.md](references/reference-tables.md) for no-history and historized reference / lookup tables.
- See [references/multi-temporal.md](references/multi-temporal.md) for bi-temporal (business time + load time) historization.
- See [references/hashing-and-keys.md](references/hashing-and-keys.md) for the *exact* normalization + hash-function recipes per dialect.
- See [references/zero-keys-and-ghost.md](references/zero-keys-and-ghost.md) for ghost / zero / error / sentinel keys.
- See [references/loading-patterns.md](references/loading-patterns.md) for insert-only, idempotent, incremental load patterns.
- See [references/pit-and-bridge.md](references/pit-and-bridge.md) for PIT and bridge table construction.
- See [references/business-vault.md](references/business-vault.md) for computed satellites and computed hubs.
- See [references/exploration-and-computed-links.md](references/exploration-and-computed-links.md) for exploration links, computed aggregation links, same-as links, interface links, business-rule links.
- See [references/information-marts.md](references/information-marts.md) for dimensional / aggregated / OBT / exploration / application mart archetypes.
- See [references/real-time-and-virtualization.md](references/real-time-and-virtualization.md) for streaming loads and view-based marts.
- See [references/metrics-and-error-vault.md](references/metrics-and-error-vault.md) for load-observability instrumentation.
- See [references/methodology-and-delivery.md](references/methodology-and-delivery.md) for sprint-scoped delivery and team-structure guidance.
- See [references/dbtvault-and-automatedv.md](references/dbtvault-and-automatedv.md) for macro-first shortcuts using AutomateDV / datavault4dbt.
- See [references/snowflake-specific.md](references/snowflake-specific.md) for Snowflake-native execution patterns (streams, tasks, dynamic tables, hashing, clustering).
- See [references/governance-and-compliance.md](references/governance-and-compliance.md) when regulatory / PII / right-to-erasure requirements apply.
- See [references/cdc-and-streaming-sources.md](references/cdc-and-streaming-sources.md) for Debezium / Fivetran-CDC / Kafka / REST-API ingestion patterns.
- See [references/multi-tenancy.md](references/multi-tenancy.md) for tenant-scoped hash keys and RLS in multi-tenant vaults.
- See [references/data-contracts-and-change-mgmt.md](references/data-contracts-and-change-mgmt.md) for contract-first ingestion + shared-hub change approval.
- See [references/mdm-integration.md](references/mdm-integration.md) for consuming golden records from an existing MDM system.
- See [references/scale-and-ops.md](references/scale-and-ops.md) for archiving, rehashing, DR/backup, CI cost control, freshness SLA.

**Prefer AutomateDV / datavault4dbt macros over hand-rolled SQL when
one exists.** They encode the insert-only + hashdiff + record-source
contract correctly. Hand-roll only when you have a reason (custom
audit column, non-standard load pattern, warehouse the package
doesn't support).

### 4. Load — Idempotent Insert-Only, Every Time

Every vault model is `incremental` with an insert-only strategy. The
`is_incremental()` filter excludes rows already loaded:

- **Hubs**: exclude by hash key already present in the hub.
- **Links**: exclude by hash key already present in the link.
- **Satellites**: exclude when the newest row for that parent hash key
  already has the same hashdiff (nothing changed).

See [references/loading-patterns.md](references/loading-patterns.md)
for the full templates. Never use `merge`, `delete+insert`, or `truncate`
on a raw vault table — those violate the insert-only rule and destroy
audit.

### 5. Validate — Assertions Every Vault Should Pass

Run each of these against every hub / link / satellite you build.
Failure means the model is wrong, not the test.

**Hub assertions:**
```sql
-- No duplicate business keys
SELECT bk_col, COUNT(*) FROM {{ ref('hub_x') }} GROUP BY 1 HAVING COUNT(*) > 1;
-- No duplicate hash keys
SELECT hk_col, COUNT(*) FROM {{ ref('hub_x') }} GROUP BY 1 HAVING COUNT(*) > 1;
-- No NULL business keys or hash keys
SELECT COUNT(*) FROM {{ ref('hub_x') }} WHERE bk_col IS NULL OR hk_col IS NULL;
```

**Link assertions:**
```sql
-- No duplicate link hash keys (grain is enforced)
SELECT lnk_hk, COUNT(*) FROM {{ ref('lnk_x') }} GROUP BY 1 HAVING COUNT(*) > 1;
-- Every hub hash key on the link exists in the corresponding hub
SELECT l.hub_a_hk FROM {{ ref('lnk_x') }} l
LEFT JOIN {{ ref('hub_a') }} h ON l.hub_a_hk = h.hub_a_hk
WHERE h.hub_a_hk IS NULL;
```

**Satellite assertions:**
```sql
-- Uniqueness on (parent hash key, load date)
SELECT parent_hk, load_dts, COUNT(*) FROM {{ ref('sat_x') }} GROUP BY 1,2 HAVING COUNT(*) > 1;
-- No two consecutive rows for the same parent with the same hashdiff (nothing changed → nothing loaded)
WITH ordered AS (
  SELECT parent_hk, load_dts, hashdiff,
         LAG(hashdiff) OVER (PARTITION BY parent_hk ORDER BY load_dts) AS prev_hashdiff
  FROM {{ ref('sat_x') }}
)
SELECT COUNT(*) FROM ordered WHERE hashdiff = prev_hashdiff;
```

Codify these as `dbt tests`. AutomateDV ships most of them as tests
already — see [references/dbtvault-and-automatedv.md](references/dbtvault-and-automatedv.md).

**Verify every requested deliverable exists** by walking the checklist
from step 1 and confirming (a) the `.sql` file exists, (b) it appears
in `altimate-dbt info`, (c) the required columns are present via
`altimate-dbt columns --model <name>`, and (d) the assertions above
return zero rows.

## Companion altimate-code Skills (When on dbt)

Data Vault work is high-leverage for altimate-code's other dbt skills.
When the user is on dbt, invoke the companions below at the workflow
steps indicated. Each addresses a specific class of silent-correctness
risk that vault projects are particularly exposed to.

**During Discover (step 2):**
- **`pii-audit`** — for every source table you're about to model,
  classify columns for PII (SSN, email, phone, name, address). PII
  columns often need to land in a separately-permissioned satellite
  or be masked at the mart. Deciding this *before* modeling is
  cheaper than retrofitting.
- **`schema-migration`** — if this vault work touches an existing
  raw-vault table's DDL (rare, but happens during schema evolution),
  run this to catch type-narrowing, dropped columns, or NOT-NULL
  additions that would break historical rows.

**During Generate (step 3):**
- **`sql-review`** — before committing any hand-rolled hub / link /
  sat SQL, run this to catch generic anti-patterns (`SELECT *` in
  final CTEs, missing anti-joins, cartesian products, injection risk
  in dynamic SQL).
- **`sql-translate`** — when porting reference SQL from
  Snowflake-shaped examples in this skill to Databricks / BigQuery /
  Redshift / Fabric syntax.

**During Load (step 4):**
- **`dbt-test`** — after every new hub / link / sat / ref /
  effectivity / status / RTS / bi-temporal satellite is written,
  invoke this to add the standard test bundle (`unique`, `not_null`,
  `relationships`, `unique_combination_of_columns`,
  `assert_no_consecutive_matching_hashdiffs`). Do not ship a vault
  model without tests.
- **`dbt-unit-tests`** — mandatory for any satellite with hashdiff
  logic, effectivity two-pass loads, multi-active sub-sequencing, or
  a computed business-vault sat. Schema tests only verify mechanics;
  unit tests verify that the *values* your load pattern produces are
  correct. See the `dbt-develop` skill's guidance on when to skip
  (only for pure passthrough sat loads).

**During Validate (step 5):**
- **`dbt-schema-verify`** — run for every model the task touched.
  Treat any `mismatch` verdict as "not done". Vault projects often
  have long deliverable lists (N hubs, M links, K sats), and drift
  from the spec is the single most common cause of PR rework.
- **`dbt-analyze`** — before shipping any change that could ripple
  downstream (adding a satellite column, changing hashdiff scope,
  restructuring a link's driver keys), run this to see column-level
  blast radius. Vault changes propagate to PITs, bridges, and
  every information mart — you want to know which ones break
  *before* the deploy.
- **`data-parity`** — when migrating an existing Kimball / medallion
  model to Data Vault 2.0, use this to prove the new mart output
  matches the old star schema. This is the single best safeguard
  against a "we shipped DV and lost 3% of revenue" incident.
- **`lineage-diff`** — after any change to a mart or PIT, use this
  to visualize which columns' data flows changed. Especially
  valuable when refactoring which satellites feed a mart column.
- **`dbt-docs`** — every vault model needs heavier documentation
  than a standard mart model (business-key rationale, driver-key
  decisions, `record_source` conventions, hashdiff column list,
  cadence group). Invoke this after each new hub / link / sat is
  built and before merging.

**During PR review:**
- **`dbt-pr-review`** — final gate before merge. Runs column-lineage
  blast radius, query equivalence, PII classification, and grade.
  For a vault PR, treat any `REQUEST_CHANGES` verdict as blocking.

**During ops / cost management:**
- **`cost-report`** — for Snowflake vault projects, monthly. Vault
  loads on very large satellites can dominate warehouse cost; the
  report shows which satellites and PIT rebuilds are the biggest
  spenders.
- **`query-optimize`** — when a specific mart query on top of the
  vault is slow. Often points at a missing PIT / bridge, missing
  cluster key, or an inline `MAX(load_dts)` that a PIT would fix.
- **`dbt-troubleshoot`** — when any vault build fails or produces
  wrong values. Prefer this over ad-hoc debugging.

**Not on dbt?** These skills are dbt-specific. On Coalesce,
Matillion, native SQL, or a DV automation tool, only `sql-review`,
`sql-translate`, `data-parity`, `pii-audit`, and `cost-report`
apply. The rest need dbt manifest + `altimate-dbt` context to run.

## Iron Rules

1. **Insert-only. Always.** Vault tables never `UPDATE` or `DELETE`.
   If you're tempted to update a row, you have a business vault or
   information mart problem, not a raw vault problem.
2. **Normalize business keys once, in a shared macro.** The moment you
   have two different pieces of SQL doing "the customer key
   normalization", the two will drift, and half your future satellite
   loads will silently insert duplicates. Put the normalization in one
   macro and call it from every hub, link, and satellite.
3. **Hash the same columns in the same order everywhere.** Hashdiff
   equality depends on byte-for-byte identical inputs. Sort columns
   alphabetically, cast to a consistent string type, and NULL-coalesce
   to a sentinel before concatenating — every time.
4. **`load_dts` is the load timestamp, not the source timestamp.** Use
   `CURRENT_TIMESTAMP()` (or the run's start time, from
   `run_started_at`) — never the source's `updated_at`. Auditability
   requires knowing when *we* saw the record.
5. **Raw vault contains no business logic.** No filters that discard
   source rows for "quality", no unions that merge "logically the same"
   entities, no derived columns that combine other columns. If a
   business rule needs to be applied, it goes in the business vault or
   information mart, not the raw vault.
6. **One satellite per change cadence.** Splitting satellites by the
   rate at which their columns change is the whole point of DV
   satellite design. One giant satellite that stores everything about
   a hub will churn on every load because *some* column always
   changes.
7. **Match the deliverable spec exactly.** Just like `dbt-develop`:
   run `altimate-dbt schema-verify --model <name>` and treat any
   `mismatch` as "not done". Adding "helpful" audit columns nobody
   asked for, or renaming `hashdiff` to `hash_diff`, breaks the
   contract.
8. **When AutomateDV has a macro for it, use the macro.**
   Hand-rolled `hub_template` / `sat_template` SQL is a maintenance
   burden and a bug source. The macro authors have already thought
   about your edge cases.

## Common Data Vault Pitfalls

See [references/common-mistakes.md](references/common-mistakes.md) for
the full catalog. The five that come up most in real projects:

- **Wrong hub grain from a "convenience" join.** Someone writes
  `hub_customer` by selecting from `stg_orders` (because that's where
  they need the customer key next), inheriting the order table's
  grain. Every customer with N orders now appears N times. The fix:
  hub loads always come from *every* source that mentions the
  business key, `UNION ALL`-ed and `DISTINCT`-ed on the hash key.
- **Missing driver key on a link.** An "order fulfillment" link that
  connects order + warehouse + carrier is loaded with just (order,
  warehouse) as its hash key. Every time the carrier changes, the
  same hash key is reused and the change is invisible. Include every
  key that participates in the *identity* of the relationship in the
  hash.
- **Satellite hashdiff computed on unsorted columns.** Two loads of
  the same source row produce different hashdiffs because the
  concatenation order shifted. Every satellite load must sort its
  descriptive columns identically — best done via a shared macro.
- **Using source `updated_at` as `load_dts`.** Now the vault's
  history is the source's history, not your ingestion history. If the
  source reloads back-dated rows, they get sorted into the middle of
  your satellite chain and downstream PIT tables lie. Always use
  ingestion time.
- **Doing "clean-up" in the raw vault.** Someone filters out
  `is_test = TRUE` rows on the way in "because they're not real
  customers". Six months later, a compliance question asks about
  every customer ever, including test ones, and the answer is
  unrecoverable. Filter in the business vault or information mart —
  raw vault is byte-for-byte source.

## Reference Guides

### Foundations (read first)

| Guide | Use When |
|-------|----------|
| [references/core-concepts.md](references/core-concepts.md) | Need the definitions: hub, link, sat, ref, PIT, bridge, hashkey, hashdiff, RTS, STS, MAS, EFS, metrics vault, error mart |
| [references/hard-vs-soft-rules.md](references/hard-vs-soft-rules.md) | Deciding where a transformation is allowed to live (staging vs. raw vault vs. business vault vs. mart) |
| [references/source-modeling.md](references/source-modeling.md) | Going from source tables to hub/link/satellite design |
| [references/hashing-and-keys.md](references/hashing-and-keys.md) | Picking hash function + business-key normalization per dialect |
| [references/zero-keys-and-ghost.md](references/zero-keys-and-ghost.md) | Ghost records, zero keys, error keys, sentinel-hash conventions |

### Layers

| Guide | Use When |
|-------|----------|
| [references/staging-layer.md](references/staging-layer.md) | Building the two-stage staging layer (Stage 1 mirror + Stage 2 hashed) |
| [references/hub-patterns.md](references/hub-patterns.md) | Writing a hub |
| [references/link-patterns.md](references/link-patterns.md) | Writing a link (standard, transactional, hierarchical, same-as, multi-way) |
| [references/satellite-patterns.md](references/satellite-patterns.md) | Writing a satellite (standard, multi-active, effectivity, status-tracking) |
| [references/record-tracking-satellites.md](references/record-tracking-satellites.md) | Record-tracking sats (RTS) for CDC and audit |
| [references/reference-tables.md](references/reference-tables.md) | Reference / lookup tables (country, currency, calendar) |
| [references/multi-temporal.md](references/multi-temporal.md) | Bi-temporal satellites (business time + load time) for sources with retroactive corrections |
| [references/loading-patterns.md](references/loading-patterns.md) | Idempotent insert-only load patterns in dbt |
| [references/pit-and-bridge.md](references/pit-and-bridge.md) | Building PIT and bridge tables |

### Business vault and consumption

| Guide | Use When |
|-------|----------|
| [references/business-vault.md](references/business-vault.md) | Adding computed satellites and computed hubs |
| [references/exploration-and-computed-links.md](references/exploration-and-computed-links.md) | Business-vault link taxonomy: exploration, computed aggregation, same-as, interface, business-rule links |
| [references/information-marts.md](references/information-marts.md) | Building dimensional / aggregated / OBT / exploration / application marts |
| [references/real-time-and-virtualization.md](references/real-time-and-virtualization.md) | Real-time loading and virtualized (view-based) marts |

### Ops and delivery

| Guide | Use When |
|-------|----------|
| [references/metrics-and-error-vault.md](references/metrics-and-error-vault.md) | Instrumenting loads (metrics vault) and handling rejections (error mart) |
| [references/methodology-and-delivery.md](references/methodology-and-delivery.md) | Sprint-scoped delivery, team structure, release sequencing, testing discipline |

### Enterprise delivery (probe Step 0.5 first)

Load these when the corresponding flag applies. Skip for solo /
small-domain projects.

| Guide | Use When |
|-------|----------|
| [references/governance-and-compliance.md](references/governance-and-compliance.md) | PII/PHI in scope, GDPR/CCPA/HIPAA/SOX, right-to-erasure obligations, data-classification propagation |
| [references/cdc-and-streaming-sources.md](references/cdc-and-streaming-sources.md) | Debezium / GoldenGate / Fivetran-CDC sources, Kafka/Kinesis streams, paginated REST APIs, nested/array payloads |
| [references/multi-tenancy.md](references/multi-tenancy.md) | SaaS-B2B or any multi-tenant vault where tenants must not see each other's data |
| [references/data-contracts-and-change-mgmt.md](references/data-contracts-and-change-mgmt.md) | Shared hubs across teams, external source ownership, change-approval mechanics |
| [references/mdm-integration.md](references/mdm-integration.md) | Existing Informatica / Reltio / Profisee / IBM MDM emitting golden records |
| [references/scale-and-ops.md](references/scale-and-ops.md) | > 1B rows expected, > 50 feeds, DR/backup planning, CI cost control, freshness SLAs |

### Platform (pick one — asked in Step 0 of the workflow)

| Guide | Use When |
|-------|----------|
| [references/snowflake-specific.md](references/snowflake-specific.md) | Warehouse: **Snowflake** (streams, tasks, dynamic tables, `MD5_BINARY`, clustering) |
| [references/databricks-specific.md](references/databricks-specific.md) | Warehouse: **Databricks / Delta Lake** (DLT, Structured Streaming, Unity Catalog, liquid clustering, Photon) |
| [references/bigquery-specific.md](references/bigquery-specific.md) | Warehouse: **BigQuery** (partition + cluster, MERGE, streaming inserts, materialized views, Direct Lake / DTS) |
| [references/redshift-specific.md](references/redshift-specific.md) | Warehouse: **Redshift** (`MD5` hex, DIST/SORT keys, VACUUM/ANALYZE cadence, Spectrum for cold sats) |
| [references/ms-fabric-specific.md](references/ms-fabric-specific.md) | Warehouse: **Microsoft Fabric** (Warehouse + Lakehouse, `HASHBYTES`, Direct Lake, Eventstream) |
| [references/postgres-specific.md](references/postgres-specific.md) | Warehouse: **PostgreSQL** (BYTEA hashes, `ON CONFLICT`, partitioning, autovacuum tuning) |

### Orchestration and tools

| Guide | Use When |
|-------|----------|
| [references/dbtvault-and-automatedv.md](references/dbtvault-and-automatedv.md) | Orchestration is dbt + AutomateDV / datavault4dbt packages |
| [references/native-sql-orchestration.md](references/native-sql-orchestration.md) | Orchestration is Airflow / Dagster / Snowflake Tasks / ADF / cron (no dbt) |
| [references/common-mistakes.md](references/common-mistakes.md) | Extended pitfall catalog |
