# Data Contracts and Change Management

Year-1 DV problems are usually correctness bugs. Year-2+ problems
are almost always coordination failures: a source team renames a
column and 40 downstream marts break; someone silently changes a
hash-key normalization and the customer hub fragments; a satellite
gains a new column that no one's mart accounts for. Data contracts
+ a real change-approval process solve these.

**When to load this reference:** the vault has more than one team
producing sources or consuming marts; shared hubs (e.g. `hub_customer`)
are referenced by many downstream projects; source systems are owned
by teams outside the analytics org. Skip for single-team vaults.

---

## Ask the User First — Governance Model

Before writing contract or approval code, get answers to:

1. **Who owns each source?** Name a specific team/service per feed.
   "The data platform team" is not a source owner; the CRM team is.
2. **What does that team commit to?** Just to ship the data, or to
   preserve schema, or to notify on changes, or to all of the above?
3. **Is there an existing contract mechanism?** dbt Contracts?
   Great Expectations? Protobuf/Avro schema registry? Custom
   YAML? None?
4. **Who approves changes to shared hubs?** Reality-check with
   the org — for `hub_customer` referenced by 10 teams, is there
   one committee that approves BK changes, or does the vault team
   have blocking authority?
5. **What SLA does the vault team commit back?** Freshness (data
   lands within N minutes of source), completeness (X% of rows
   land), correctness (Y% of tests pass). Contracts flow both
   ways.
6. **How are breaking changes staged?** Same-day rollout across
   all consumers? Feature-flag with a deprecation window? Versioned
   models (dbt 1.5+ `versions:`)?
7. **What's the escalation path when a source breaks the contract?**
   Auto-quarantine? Slack alert? Page oncall? Roll back?

**Do not skip these.** Contract mechanics without organizational
buy-in produce shelf-ware. Contract mechanics with buy-in but no
tooling produce spreadsheets that go stale.

---

## What a Data Contract Actually Contains

A data contract is a machine-readable document — one per source
feed — describing what the vault expects to receive:

```yaml
# contracts/crm__customers.yml
contract:
  source: crm.customers
  owner:
    team: crm-eng
    slack: '#crm-eng'
    on_call_pager: crm-eng-oncall
    escalation_ticket: 'https://jira.example.com/create?project=CRM'

  freshness_sla:
    max_landing_lag: 5m
    max_run_gap: 15m

  volume_sla:
    daily_min_rows: 10000
    daily_max_rows: 1000000
    weekly_variance_pct: 30

  schema:
    - name: customer_id
      type: string
      nullable: false
      description: Business key
      constraint: primary_key
      classification: pii
    - name: email
      type: string
      nullable: true
      description: Primary email
      classification: pii
      format: email
    - name: created_at
      type: timestamp
      nullable: false
    - name: updated_at
      type: timestamp
      nullable: false

  business_key: customer_id
  cdc_expected: true          # deletes should arrive as tombstones
  retention_days_at_source: 2555   # source guarantees history back this far

  changes_require_approval_from:
    - vault-team
    - ml-platform
    - finance-analytics

  version: 3
  last_reviewed: '2026-01-15'
  next_review: '2026-07-15'
```

The contract file is the single source of truth. Everything
downstream (staging models, hub loads, metrics vault expectations,
alerting rules) *references* the contract instead of hardcoding
values.

---

## Contract-First Ingestion

The staging model reads the contract at compile time and generates
schema assertions:

```sql
-- stg_crm__customers.sql
{{ config(materialized='view') }}

WITH source AS (
    SELECT * FROM {{ source('raw', 'raw_crm_customers') }}
),
contract_verified AS (
    SELECT
        CAST(customer_id AS VARCHAR)     AS customer_id,   -- contract type
        CAST(email       AS VARCHAR)     AS email,
        CAST(created_at  AS TIMESTAMP)   AS created_at,
        CAST(updated_at  AS TIMESTAMP)   AS updated_at
    FROM source
)
SELECT * FROM contract_verified
```

Companion CI test (auto-generated from the contract):

```sql
-- tests/contract__crm_customers.sql
-- Auto-generated from contracts/crm__customers.yml — do not edit by hand.
-- Fails if the source no longer matches the contracted schema.
{% test contract_crm__customers() %}
    WITH schema_mismatch AS (
        SELECT column_name, data_type
        FROM {{ target.database }}.information_schema.columns
        WHERE table_schema = 'raw'
          AND table_name = 'raw_crm_customers'
          AND column_name IN ('customer_id', 'email', 'created_at', 'updated_at')
    )
    SELECT * FROM schema_mismatch
    WHERE (column_name = 'customer_id' AND data_type NOT IN ('VARCHAR', 'STRING', 'TEXT'))
       OR (column_name = 'email'       AND data_type NOT IN ('VARCHAR', 'STRING', 'TEXT'))
       OR (column_name = 'created_at'  AND data_type NOT IN ('TIMESTAMP', 'TIMESTAMP_NTZ'))
{% endtest %}
```

CI failure = contract violation. Alert routes to source team's
Slack channel per the contract's `owner` block.

### Fail-Fast Behavior

When a contract test fails, downstream vault loads are blocked, not
executed with best-effort data. The default should be:

- **Landing table still receives raw source** (never block ingestion —
  you need the audit trail).
- **Staging model refuses to build** — CI red, deployment blocked.
- **Alert goes to source-team on-call**, not vault-team.
- **Metrics vault records the block** as a `contract_violation` event.

The source team fixes their side and re-deploys the source; the
contract auto-re-validates and vault loads resume.

---

## Change-Approval Mechanics for Shared Hubs

The single most damaging change in a mature DV is a silent
normalization tweak on a shared hub. Someone in team A changes
`TRIM → LTRIM` for their satellite's hashdiff — every hub row now
hashes differently — every downstream mart's joins silently miss.

### Rule — Every Shared Hub Has an Owner

`hub_customer` is not owned by whoever touched it last. It's owned
by a named team/role with veto authority. Codify in a metadata
file:

```yaml
# metadata/hub_ownership.yml
hub_customer:
  owning_team: data-platform-core
  approvers:
    - data-platform-core
    - customer-analytics
    - identity-team
  slack_channel: '#hub-customer-changes'
  change_review_days: 5
```

### Rule — Every PR That Touches a Shared Hub Requires Named Reviewers

Enforce via CODEOWNERS (or a companion CI check):

```
# CODEOWNERS
/models/raw_vault/hubs/hub_customer.sql        @data-platform-core @customer-analytics
/models/raw_vault/hubs/hub_customer/           @data-platform-core @customer-analytics
/macros/dv_hash*.sql                           @data-platform-core
```

The hashing macros are shared infrastructure — an even higher bar.
Any change requires platform-team approval regardless of who uses
it.

### Rule — Blast-Radius Report on Every Hub PR

Before approval, the reviewer sees a machine-generated blast-radius
report:

```
CHANGE: models/raw_vault/hubs/hub_customer.sql

Direct dependents (5 satellites, 3 links):
  - sat_customer_pii
  - sat_customer_engagement
  - sat_customer_financial
  - sat_customer_public
  - sat_customer_status
  - lnk_order_customer
  - lnk_customer_am
  - lnk_customer_account

Downstream marts (12):
  - finance/dim_customer
  - finance/fct_orders
  - ml/features_customer_v3
  - ...

Companion contracts referencing this hub:
  - contracts/crm__customers.yml (owner: crm-eng)
  - contracts/erp__customer_master.yml (owner: erp-eng)

If normalization changes: every downstream hash must be recomputed.
Migration plan required before merge.
```

Use `altimate-dbt children --model hub_customer` (see
[dbt-analyze companion skill invocation]) to produce this. Do not
approve without seeing this report.

---

## Versioning Shared Models

When a hub or shared satellite needs a truly breaking change
(different normalization, added BK part, changed grain), version it
rather than mutate in place. dbt 1.5+ supports model versions
natively:

```yaml
models:
  - name: hub_customer
    latest_version: 2
    versions:
      - v: 1
        # frozen — legacy consumers reference this
      - v: 2
        # new normalization / new BK composition
        defined_in: hub_customer_v2
```

Migration plan:
1. Ship `hub_customer_v2` alongside v1.
2. New downstream references point to v2 (`ref('hub_customer',
   v=2)`).
3. Existing marts deprecated over N sprints; each moves to v2 as
   its team completes migration.
4. When zero consumers reference v1, retire it in a followup PR.
5. Never delete v1's data — the historical mart snapshots still
   need it.

---

## Contract Enforcement — Where It Runs

Contract checks fire in three places, each with different semantics:

| Where | What it checks | On failure |
|-------|----------------|-----------|
| CI (PR) | Schema of vault models matches the contract; new column has classification tag; BK composition unchanged | Block PR merge |
| CI (scheduled) | Source schema still matches contract; volume within SLA | Auto-open ticket on source team |
| Runtime (dbt build) | Row-level contract (not-null, accepted values); freshness SLA | Block downstream loads; alert source team |

Every warehouse-native dbt build already runs runtime tests. The
gap most teams have is the *scheduled* PR-independent scan of the
source's own schema.

---

## The Deprecation Playbook

When retiring a model:

1. **Announce**: PR that adds `deprecated: true` in the model's
   `_models.yml`, with a documented replacement.
2. **Wait**: N sprints (per governance policy) for consumers to
   migrate.
3. **Enforce**: CI warning becomes error on any reference to the
   deprecated model.
4. **Freeze**: model stops receiving new data (but existing rows
   remain — audit).
5. **Archive**: after retention window, DDL removed but underlying
   storage retained per data-retention policy.
6. **Delete**: only if legally allowed AND no audit obligation
   remains.

**Never step directly from "deprecated" to "deleted."** Each stage
is a checkpoint.

---

## Contract Registry Table

For discoverability, store contract metadata in a warehouse-side
registry:

```sql
CREATE TABLE governance.contract_registry (
    contract_name         VARCHAR    NOT NULL PRIMARY KEY,
    source_system         VARCHAR    NOT NULL,
    source_table          VARCHAR    NOT NULL,
    version               INTEGER    NOT NULL,
    owner_team            VARCHAR    NOT NULL,
    owner_slack           VARCHAR,
    freshness_sla_minutes INTEGER,
    last_reviewed         DATE       NOT NULL,
    next_review           DATE       NOT NULL,
    contract_yaml_path    VARCHAR    NOT NULL,
    active                BOOLEAN    NOT NULL DEFAULT TRUE
);
```

Populated by CI on every contract change. Marts can join to it to
show "which contract governs this data" in BI tools.

---

## Testing the Governance Process Itself

Governance code needs its own tests:

- **Every source has a contract:** CI enumerates staging models
  with no matching contract file → fails.
- **Every shared hub has an owner:** CI checks CODEOWNERS covers
  every `models/raw_vault/hubs/hub_*.sql` file.
- **Contract-registry freshness:** scheduled query fails if any
  contract's `next_review` is in the past.
- **Blast-radius report is generated:** every hub PR must include
  the generated report as a comment.

---

## Common Data-Contract Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Contracts stored in a Confluence page | They rot; nobody reads before shipping | Machine-readable YAML in the repo |
| Contract owned by data-analytics | Source team doesn't know they own anything | Owner is the *source-producing* team, not vault |
| Only-runtime contract checks | Source teams learn of drift 3 weeks later | Add scheduled schema-diff scans against production sources |
| Silent normalization change on shared hub | Every downstream hash misses | Hashing macro in CODEOWNERS to platform team only |
| Renaming a hub without versioning | Every downstream reference breaks | Model versions; parallel-run new + old |
| Change approval by "get 1 LGTM" | Anyone approves anything | Named approver teams per hub in metadata |
| No blast-radius report on hub PR | Reviewer can't gauge impact | Auto-generated in PR comment; block merge without it |
| Delete deprecated model at retirement time | Historical marts lose lineage; audit trail gap | Freeze then archive; only delete after retention |
| Contract-registry lives in code but not warehouse | BI users can't discover contracts | Sync to a governance schema; join to marts for lineage viz |
| Contract violations page vault-team | Vault-team owns the fix, but source-team owns the data | Alert routes per contract's `owner` field |
| Volume SLA absent | Silent 90% row drops go undetected for days | Contract has daily_min_rows + variance; metrics-vault fires alert |
| Deprecation policy defined but never enforced | Deprecated models stay forever | CI escalates warning → error on deadline |
| No contract review cadence | Contracts frozen in time; drift accumulates | Every contract has next_review; scheduled query flags overdue |
