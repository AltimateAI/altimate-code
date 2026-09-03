---
name: snowflake-setup
description: Bootstrap or audit a Snowflake account end-to-end — topology, RBAC, ingestion, PII governance, cost controls, DR, sharing, Cortex. Supports greenfield setup, brownfield audit + remediation, and hybrid mode. Emits idempotent SQL, HCL/Terraform, and rollback scripts.
---

# Snowflake Setup and Audit

Guide the user through standing up a production-ready Snowflake account, or auditing an existing one and remediating gaps. Produces DDL (or Terraform HCL) grouped by executing role, a rollback script, and a post-setup checklist.

## Requirements

**Agent:** any
**Tools used:**
- **Baseline:** `read`, `write`, `bash`
- **Connection lifecycle:** `warehouse_list`, `warehouse_add`, `warehouse_discover` (auto-detect existing accounts), `warehouse_test` (validate role + warehouse + database access)
- **Query execution:** `sql_execute` (required for audit; optional for greenfield `guided-execute`)
- **Audit intelligence:** `finops_analyze_credits` (credit breakdown + anomalies), `finops_role_hierarchy` + `finops_role_grants` + `finops_user_roles` (role tree, per-role grants, per-user role assignments — use all three together for the RBAC audit), `finops_warehouse_advice` (data-driven sizing)
- **Live schema scanning:** `schema_inspect` (inspect a specific table's columns/types on the target warehouse), `schema_detect_pii` (scan warehouse/schema/table for PII columns via heuristic + sampling)
- **Schema-file analysis (offline, not against live account):** `altimate_core_classify_pii` (classify PII in a YAML/JSON schema definition — usable in greenfield mode when the user provides a schema file, or in audit mode after exporting live schema via `schema_inspect`), `altimate_core_grade` (grade a SQL query against a schema), `altimate_core_policy` (check a SQL query against a policy JSON), `altimate_core_export_ddl` (emit DDL from a schema definition)
**References:**
- `references/topology-patterns.md` — database and warehouse topologies (Medallion, Functional, Domain-per-DB, Data Vault 2.0)
- `references/data-vault-patterns.md` — hub/link/satellite modeling, loader patterns, DV2 RBAC and governance (loaded only when DV2 topology selected)
- `references/rbac-patterns.md` — roles, grants, service accounts
- `references/ingestion-patterns.md` — Snowpipe, Task+COPY, Fivetran, Snowpipe Streaming
- `references/governance-patterns.md` — masking, row access, tags
- `references/cost-governance.md` — resource monitors, cost attribution
- `references/idempotency-patterns.md` — emission modes and rollback rules
- `references/audit-queries.md` — brownfield diagnostic queries
- `references/terraform-mapping.md` — DDL → HCL mapping
- `references/advanced-features.md` — DR, sharing, Cortex, network/SSO, cost forecasting

## When to Use This Skill

**Use when the user wants to:**
- Bootstrap a brand-new Snowflake account
- Audit an existing account for gaps (missing FUTURE grants, unmasked PII, no resource monitors, orphaned roles, etc.) and generate a remediation plan
- Extend a partially-configured account with missing pieces (RBAC, cost controls, governance)
- Get IaC (Terraform) equivalents of the setup
- Produce a rollback plan before a risky setup change

**Do NOT use for:**
- Optimizing a single warehouse or query → `query-optimize`
- Investigating cost anomalies day-to-day → `cost-report`
- Migrating queries from another warehouse → `sql-translate` + `schema-migration`
- PII detection alone → `pii-audit`

## Workflow

### 1. Auto-detect Existing Accounts + Confirm Mode

Before asking anything, call `warehouse_discover` to enumerate warehouses the user may already have configured elsewhere (e.g. via Datamate, `~/.snowsql/config`, or environment variables). If a Snowflake connection is detected, mention it in the mode question so the user can choose knowingly:

> "I detected an existing Snowflake connection: `<account> / <user> / <role>`. Are you starting fresh (`greenfield`), auditing this one (`audit`), or extending it (`hybrid`)?"

If nothing is detected, proceed with the standard mode question below.

**First triage question** — always asked:

- `greenfield` — brand-new account, generate full setup from scratch
- `audit` — scan existing account, produce scored gap report + remediation DDL
- `hybrid` — audit existing account, then extend it toward a target topology

Audit and hybrid modes **require** a configured Snowflake warehouse the agent can reach via `sql_execute`. The signed-in Snowflake user must have `ACCOUNTADMIN` or a role granted `IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE`. See the warehouse-preflight step below for how the skill discovers or registers a connection — do not fall back to greenfield if audit is chosen but no warehouse exists.

### 2. Gather Requirements (Greenfield / Hybrid)

Ask all blocking questions **in one batch** — do not proceed until answered.

**Blocking:**

1. **Topology?** — Medallion / Functional / Domain-per-Database / Data Vault 2.0 (see `topology-patterns.md`, and `data-vault-patterns.md` if DV2 chosen)
2. **RBAC model?** — small-team single-layer / large-team functional+access two-layer (see `rbac-patterns.md`)
3. **Environments?** — prod-only / prod+dev / prod+staging+dev
4. **Ingestion sources?** (multi-select) — Fivetran or Airbyte, Snowpipe (event-driven), Task+COPY (batch), Snowpipe Streaming (Kafka), CDC from operational DBs
5. **Cloud provider for external stages?** — AWS S3 / GCS / Azure Blob
6. **Emission mode?** — `strict` / `idempotent` (default) / `additive` (see `idempotency-patterns.md`)
7. **Output format?** — `sql` (default) / `terraform` / `both`

**Optional (defaults available):**

8. **Monthly credit budget?** — number, or `forecast` to trigger the cost-forecasting workflow (see `advanced-features.md` § Cost Forecasting)
9. **PII discovery mode?** — `declared` (user lists categories) / `discover` (call `schema_detect_pii` on RAW schemas after they're populated; optionally cross-check with `altimate_core_classify_pii` if a schema file is provided) / `both`
10. **Multi-tenant data?** — yes/no; if yes, plan row access policies
11. **Existing account or new signup?** — affects ACCOUNTADMIN bootstrap DDL

**Advanced-feature triggers (each opt-in):**

12. **Restrict access by IP?** — enables network policy section
13. **Federate authentication (SSO)?** — Okta / Azure AD / Google Workspace / none
14. **Enable Cortex (LLM functions, Cortex Search)?** — yes/no
15. **Cross-region disaster recovery?** — none / replication-only / failover-group
16. **Data sharing?** — none / outbound-share / reader-account

### 2b. Warehouse Preflight (Audit / Hybrid, and Greenfield if `guided-execute`)

Before running any diagnostic query or execute step, verify a Snowflake warehouse connection is configured:

1. Call `warehouse_list` and look for an entry with `type: snowflake`
2. If **none is found**:
   - Fail fast for `audit` mode — tell the user the exact next step: "Run `warehouse_add` with your Snowflake account, user, role (ACCOUNTADMIN or one with `IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE`), warehouse, and either password or private-key path. Rerun `/snowflake-setup` once configured."
   - For `hybrid`, offer the same. Do not silently fall back to greenfield.
   - For `greenfield` with `guided-execute` selected, offer to either (a) add the warehouse now via `warehouse_add`, or (b) downgrade the execution path to `review-only`.
3. If **multiple Snowflake warehouses** exist, prompt the user to pick one before proceeding. Present the list with the fields returned by `warehouse_list` (name, account, role, warehouse) so the user can distinguish between them — never guess or auto-select even if one looks "primary". Wait for an explicit selection; do not run any query until the user answers. Remember the selection for every subsequent `sql_execute` call in this session.
4. If **exactly one Snowflake warehouse** exists, use it — but surface which one you're using ("Using Snowflake warehouse: `<name>` (account: `<account>`, role: `<role>`)") so the user can catch a wrong-account mistake before any query runs.
5. Confirm the selected warehouse works before proceeding: call `warehouse_test` with the chosen warehouse. This validates connectivity, role permissions, warehouse USAGE, and database access as a single package (superior to a bare `SELECT CURRENT_ACCOUNT()` because it catches missing grants that a scalar query wouldn't). Surface the result. If it fails, do not proceed — surface the error and ask the user to fix credentials via `warehouse_add`.
6. Cache the chosen warehouse name (and current role) for the rest of the workflow; every downstream `sql_execute` call must target it explicitly.

### 3. (Audit / Hybrid) Run Diagnostic Queries

Run each section of `references/audit-queries.md` via `sql_execute` (targeting the warehouse chosen in step 2b). **Prefer altimate tools over hand-written SQL** where they cover the same ground — they return structured data and their queries are versioned in the altimate-core:

| Section | Tool to use first | Fall back to raw SQL when |
|---------|-------------------|----------------------------|
| 1. Topology and databases | `sql_execute` (queries from `audit-queries.md`) | Always — no dedicated tool |
| 2. Warehouses | `sql_execute` | Always — no dedicated tool |
| 3. RBAC | **`finops_role_hierarchy`** (role tree) + **`finops_role_grants`** (per-role object grants) + **`finops_user_roles`** (which users have which roles) — use all three to find orphaned roles, over-privileged roles, and DEFAULT_ROLE = ACCOUNTADMIN | Any tool unavailable or returned partial data |
| 4. Ingestion | `sql_execute` | Always — no dedicated tool |
| 5. Governance (PII) | Handled in step 5 (PII Discovery) — do not duplicate here | — |
| 6. Cost controls | **`finops_analyze_credits`** — credit breakdown, anomaly detection, per-warehouse spend | Tool unavailable |
| 7. Network and security | `sql_execute` | Always — no dedicated tool |
| 8. Data sharing and replication | `sql_execute` | Always — no dedicated tool |

For each finding, score CRITICAL / WARNING / INFO per the severity rubric. Compute maturity score:

```
maturity = 100 - (CRITICAL × 10) - (WARNING × 3) - (INFO × 1)
```

Deliver the audit report as a table sorted by severity:

```
CRITICAL FINDINGS (must fix before production):
  [RBAC]      3 users have DEFAULT_ROLE = ACCOUNTADMIN
              → alice, bob, service_x
              Remediation: ALTER USER <name> SET DEFAULT_ROLE = <least_priv_role>;

  [GOVERNANCE] 12 columns look like PII but have no masking
              → RAW.SALESFORCE.CONTACTS.email, RAW.SALESFORCE.CONTACTS.phone, ...
              Remediation: apply mask_email / mask_phone from governance-patterns.md

  [COST]      2 warehouses have no resource monitor
              → TRANSFORM_WH, DEV_WH
              Remediation: see cost-governance.md § Resource Monitor Architecture

WARNING FINDINGS:
  ...

INFO FINDINGS:
  ...

Maturity: 63/100 (< 70: requires remediation before relying on for production)
```

**Maturity score is authoritative for this skill.** (Earlier drafts proposed a second-opinion via `altimate_core_grade`, but that tool grades SQL queries against a schema — not audit findings. No second-opinion mechanic is needed; keep the CRITICAL/WARNING/INFO rubric.)

In hybrid mode, use audit findings to seed the greenfield questionnaire — pre-fill answers based on what already exists (topology detected, ingestion sources present, existing warehouse sizes from `finops_analyze_credits`, role structure from `finops_role_hierarchy` + `finops_role_grants`) and only ask for gaps.

### 4. Generate the Plan

Produce a single markdown plan with the following sections, in this order. For each section not needed given the user's choices, state "Not needed because …" explicitly — do not silently skip.

1. **Databases and Schemas** ← `topology-patterns.md` (placeholder-driven; see 4a). **If topology = `data-vault-2`**, also emit `RAW_VAULT`, `BUSINESS_VAULT`, `INFO_MARTS` per `data-vault-patterns.md`, plus the HUBS/LINKS/SATELLITES schema pattern inside `RAW_VAULT`.
2. **Warehouses** ← `topology-patterns.md` § Warehouse Sizing Guide (placeholder-driven; see 4a). **In hybrid mode**, call `finops_warehouse_advice` on the existing account and use its recommendations to override the static sizing table where they differ. Present the delta to the user before emitting. **If topology = `data-vault-2`**, apply the DV2 cost adjustment table from `data-vault-patterns.md` (typically 2–3× LOADING_WH and TRANSFORM_WH baselines).
3. **RBAC** ← `rbac-patterns.md` (placeholder-driven; see 4a). **In hybrid mode**, use `finops_role_hierarchy` + `finops_role_grants` output to detect existing roles and only emit DDL for missing ones. **If topology = `data-vault-2`**, add the `VAULT_LOADER_ROLE`, `BUSINESS_VAULT_BUILDER_ROLE`, and `MART_BUILDER_ROLE` from `data-vault-patterns.md`, and emit the insert-only enforcement `REVOKE UPDATE, DELETE` statements on `RAW_VAULT.*`.
4. **Ingestion** (one subsection per selected source) ← `ingestion-patterns.md` (requires detail questions; see 4b)
5. **Governance** ← `governance-patterns.md` (placeholder-driven for defaults; see PII discovery in step 5). **Before emitting any masking / row-access policy DDL**, verify each target column actually exists by calling `schema_inspect` on the target table (needs the warehouse name from step 2b). If the column is missing or has an unexpected type, refuse to emit that policy and surface the error. **If topology = `data-vault-2`**, apply masking at the layer chosen in the DV2 detail questions (RAW_VAULT satellites / BUSINESS_VAULT+INFO_MARTS / hybrid) per `data-vault-patterns.md` § PII placement.
6. **Cost Controls** ← `cost-governance.md` (placeholder-driven). **In hybrid mode**, seed monitor thresholds from `finops_analyze_credits` (30-day p95 usage × 1.5 = suggested quota).
7. **Environment Promotion** (zero-copy clones) ← `topology-patterns.md` (placeholder-driven)
8. **Network Security + SSO** (if enabled) ← `advanced-features.md` (requires detail questions; see 4b)
9. **Disaster Recovery** (if enabled) ← `advanced-features.md` (requires detail questions; see 4b)
10. **Data Sharing** (if enabled) ← `advanced-features.md` (requires detail questions; see 4b)
11. **Cortex / ML** (if enabled) ← `advanced-features.md` (requires detail questions; see 4b)
12. **Cost Forecast** (if budget = `forecast`) ← `advanced-features.md` (requires detail questions; see 4b)
13. **Rollback Script** ← `idempotency-patterns.md`. **In audit/hybrid mode**, before generating the DROP sequence, enumerate existing objects via `SHOW DATABASES`, `SHOW WAREHOUSES`, `SHOW ROLES`, `SHOW USERS`, `SHOW INTEGRATIONS`, and `SHOW RESOURCE MONITORS` (via `sql_execute`). Cross-reference with the objects the skill created in this session and emit `DROP … IF EXISTS` only for the intersection. This ensures the rollback covers exactly what exists — no more, no less.

    **Delivery split — DROP DATABASE / DROP SCHEMA / TRUNCATE cannot run via altimate-code.** The `sql_execute` tool has a non-bypassable safety guard blocking these three statement types (see `packages/opencode/src/altimate/tools/sql-classify.ts`). This means `guided-execute` **cannot** apply a full rollback on its own. The skill's rollback file must therefore split into two parts:
    - `rollback-tool-safe.sql` — every DROP except DATABASE / SCHEMA / TRUNCATE (roles, warehouses, users, monitors, policies, tags, pipes, tasks, stages, integrations). Runs cleanly via `sql_execute`.
    - `rollback-manual.sql` — the `DROP DATABASE` and `DROP SCHEMA` statements. Must be executed via `snowsql`, Snowsight SQL Worksheet, or a direct `snowflake-sdk` script by the user.
    Emit both files, and tell the user explicitly at the end of the rollback plan: *"After running rollback-tool-safe.sql, execute rollback-manual.sql through Snowsight or snowsql — this file contains DROP DATABASE / DROP SCHEMA statements that altimate-code cannot execute for you."*

### 4a. Placeholder-Driven Sections

Sections 1, 2, 3, 5 (non-PII parts), 6, 7 use safe defaults derived from the triage answers. Any value the skill cannot safely default is emitted as a **clearly-marked placeholder** (e.g. `<YOUR_DBT_SERVICE_PASSWORD>`, `<STORAGE_AWS_ROLE_ARN>`, `<OKTA_ISSUER_ID>`) with a comment `-- REPLACE BEFORE RUNNING` inline. For Terraform output, use `var.<name>` and declare the variable in `variables.tf` with a description that says what to set.

Every placeholder must appear in a **"Configure Before Running" checklist** at the top of the delivered SQL / HCL file so users can't miss them. Never emit a bucket name, IAM ARN, IP range, cert body, private key path, or SSO URL as a guess or plausible-looking default — always a placeholder.

Naming defaults the skill uses without asking (safe because they're conventional and can be renamed later):
- Database names: from topology choice (BRONZE/SILVER/GOLD or RAW/TRANSFORM/ANALYTICS)
- Warehouse names: `<PURPOSE>_WH` (LOADING_WH, TRANSFORM_WH, ANALYTICS_WH, DEV_WH)
- Role names: `<PURPOSE>_ROLE` per the RBAC reference topology
- Schema names within RAW: one per selected ingestion source

### 4b. Detail Questions (Section-by-Section Confirmation)

For sections where wrong defaults are dangerous (real bucket names, IP ranges, IdP URLs, region choices, target accounts), ask a small batch of detail questions **just before emitting that section**. Present the current plan for the section, then ask.

**Data Vault 2.0 detail questions (asked only if topology = `data-vault-2`, before Section 1 is emitted):**

- Which dbt vault package to configure? — `AutomateDV` (recommended) / `dbtvault` (legacy) / `custom` (no package, hand-rolled macros)
- Hash algorithm? — `MD5` (default, faster) / `SHA256` (compliance-grade, slower)
- Business key naming convention? — `BK_<ENTITY>_ID` (default) / `NK_<ENTITY>` / custom pattern
- Which source systems feed the initial vault? (one hub per business entity per source; typical: customer, order, product)
- PII placement — mask in `RAW_VAULT` at load / mask only in `BUSINESS_VAULT` + `INFO_MARTS` (default for regulated industries) / hybrid (column mask in vault + row access in marts)
- Vault refresh cadence — how often should `RAW → RAW_VAULT` run? (default: hourly for hot, nightly for reference data)

**Section 4 — Ingestion (per selected source):**

- If Snowpipe or Task+COPY was selected:
  - S3 / GCS / Azure Blob URL(s)? (e.g. `s3://my-raw-data/salesforce/`)
  - IAM role ARN or GCP service account or Azure app registration for the storage integration?
  - Which schemas should each stage point at? (default: one schema per source per `topology-patterns.md`)
  - For Task+COPY: cron schedule (default `0 * * * * UTC` = hourly)
- If Fivetran/Airbyte was selected:
  - Which sources? (Salesforce, HubSpot, Stripe, GitHub, Postgres, other)
  - Fivetran/Airbyte-generated schema names, or use `<CONNECTOR>_<SOURCE>` convention?
  - Loader service account name (default: `<connector>_loader`)
- If Snowpipe Streaming was selected:
  - Kafka topic names?
  - Which target tables and clustering keys?

**Section 8 — Network Security + SSO:**

- If IP restriction was enabled (triage Q12=yes):
  - CIDR blocks to allow? (comma-separated list)
  - Should the same policy apply to service accounts, or a separate CI-runner policy?
- If SSO was enabled (triage Q13):
  - Full IdP issuer URL? (Okta / Azure AD tenant / Google Workspace)
  - SSO endpoint URL?
  - X509 signing cert (paste body or provide path)?
  - Enforce SSO-only login (block password auth for humans)?
- Always ask (regardless of triage answers):
  - Enable MFA enforcement for all human users? (recommended: yes)
  - Generate key-pair auth for service accounts now, or emit placeholders for user-supplied keys?

**Section 9 — Disaster Recovery (if triage Q15 ≠ none):**

- Target region for the replica account? (e.g. `AWS_US_WEST_2`)
- Target account locator (must already exist and be in the same org)?
- Replication schedule? (default: `60 MINUTE` for replication-only, `15 MINUTE` for failover)
- RPO target? (informational — used to validate schedule)
- For failover-group: client connection name? (default: `prod_connection`)

**Section 10 — Data Sharing (if triage Q16 ≠ none):**

- Which schemas or specific objects to share? (must be secure views, not raw tables)
- Consumer account identifiers?
- For reader account: reader account name and initial admin password (placeholder, not asked)?

**Section 11 — Cortex / ML (if triage Q14=yes):**

- Cortex warehouse size? (default: MEDIUM Snowpark-optimized)
- Which roles need `USAGE` on Cortex functions? (default: ANALYST_ROLE)
- Set up a Cortex Search service? If yes, target table + attribute columns + target lag?

**Section 12 — Cost Forecast (if triage Q8=forecast):**

- Expected data volume ingested per day (GB)?
- Expected number of dbt models?
- Expected concurrent BI users?
- Expected ad-hoc analyst sessions per week?
- Expected credit price ($/credit) for cost estimation? (default: $3)

**In hybrid mode**, populate answers to these detail questions from audit findings where possible (e.g. detected bucket URLs from existing storage integrations, current network policies, current credit consumption from `finops_query_history`). Only ask about deltas.

### 5. PII Discovery (if `discover` or `both`)

After the RAW databases and schemas are created (or in audit mode, before generating masking DDL):

1. Call `schema_detect_pii` with the warehouse from step 2b, scoped to the RAW schema(s). This scans live tables/columns via heuristic + sampling and returns PII candidates with confidence scores.
2. Optionally: if the user has a schema YAML/JSON file (e.g. from dbt sources.yml), also run `altimate_core_classify_pii` with that `schema_path` for a cross-check.
3. Merge results with any user-declared categories.
4. Auto-populate masking policy targets in section 5 (Governance).
5. Report the classification confidence per column in the plan output.

Fall back gracefully:
- If `schema_detect_pii` returns no results (RAW schemas empty in greenfield), use declared categories only
- If neither `schema_detect_pii` nor `altimate_core_classify_pii` is available, fall back to the name-based heuristic from `audit-queries.md` § Section 5 and note the reduced confidence

### 6. Emit the DDL / HCL

Apply the emission mode from question 6 to every `CREATE` statement:

- `strict` → plain `CREATE`
- `idempotent` (default) → `CREATE IF NOT EXISTS` for allowed objects; use `ALTER` (not `OR REPLACE`) for objects on the danger list in `idempotency-patterns.md`
- `additive` → run existence checks first via `SHOW` / `INFORMATION_SCHEMA`, skip anything present

Apply the output format from question 7:
- `sql` → grouped SQL blocks (see below)
- `terraform` → HCL files per `terraform-mapping.md` (`providers.tf`, `variables.tf`, one `.tf` per section)
- `both` → both, in separate output files

**SQL grouping — always** organize by executing role so the user knows which `USE ROLE` to run before each block:

```
==== Run as ACCOUNTADMIN ====
1. Databases and schemas
2. Warehouses
3. Resource monitors (account-level + per-warehouse)
4. Storage integrations (if S3/GCS/Azure)
5. Custom roles
6. Grant custom roles to SYSADMIN (idempotency check: skip if already granted)
7. Network policies (if enabled)
8. Security integrations for SSO/SCIM (if enabled)
9. Replication / failover groups (if DR enabled)
10. Cortex warehouse (if enabled)

==== Run as SECURITYADMIN ====
11. Service accounts (loader, dbt, streaming, cortex)
12. DEFAULT_ROLE / DEFAULT_WAREHOUSE bindings
13. Network policy application to service accounts

==== Run as SYSADMIN ====
14. Object privileges to functional roles
15. FUTURE privileges (CRITICAL — always include)
16. File formats, stages, pipes, tasks
17. Masking policies and row access policies
18. Apply masking to PII columns (from PII discovery output)
19. Tag taxonomy and tag applications
20. Shares (if data sharing enabled)

==== Manual (outside Snowflake) ====
- AWS IAM role trust policy for storage integrations (or GCS / Azure equivalent)
- S3 bucket event notifications → SQS (if Snowpipe)
- Fivetran / Airbyte destination configuration
- IdP-side SCIM / SAML setup (Okta app, Azure AD enterprise app, etc.)
- Client connection URL configuration (if failover group enabled)
```

Always append a **validation query pack** the user can run after each block to confirm it worked (queries pulled from the appropriate reference file).

**Rule: validation queries must only reference objects the emitted DDL actually creates.** If a section's DDL was skipped because it depends on placeholders the user did not fill in (e.g. no S3 bucket URL was provided, so the storage integration / external stage / pipe DDL was omitted), the corresponding validation queries — `SYSTEM$PIPE_STATUS(...)`, `SHOW STAGES`, `DESC INTEGRATION`, `SHOW PIPES`, or `SELECT ... FROM RAW.<schema>.<table>` — must **also** be omitted. Emitting validation queries for objects that were never created leaves the user chasing false "0 rows" reports on the tail of the file. The skill should track which sections it emitted and pass that flag into the validation-query emission.

### 7. Emit the Rollback Script

Regardless of mode or format, always generate a companion rollback SQL file per `idempotency-patterns.md` § Rollback Script Generation:

- DROPs in strict reverse dependency order (policies → tags → pipes/tasks → stages → tables → schemas → databases → warehouses → resource monitors → grants → roles → users → integrations)
- Every DROP uses `IF EXISTS`
- Never emits `DROP ... CASCADE`
- Never drops built-in roles or the `SNOWFLAKE` database
- SUSPEND tasks and UNSET policies/tags/monitors before dropping
- Interactive confirmation guard at the top requiring the user to paste the account locator before destructive statements execute

### 8. Execute per the User's Choice

The execution path was already selected in triage Q3. Do not re-ask; just proceed:

- `review-only` — hand over the plan + DDL/HCL as files; do not offer to execute
- `guided-execute` — run DDL directly via `sql_execute` against the warehouse from step 2b, section by section, pausing for user confirmation between role switches. If no Snowflake warehouse is configured (step 2b failed), fall back to `review-only` and warn the user. **Caveat:** `sql_execute` cannot run `DROP DATABASE`, `DROP SCHEMA`, or `TRUNCATE` (non-bypassable safety guard). Rollback delivery is therefore split into `rollback-tool-safe.sql` (auto-executable) and `rollback-manual.sql` (user runs via snowsql/Snowsight). See plan section 13.
- `dbt-integrate` — same as `guided-execute` (or `review-only` if no connection), and additionally emit a `profiles.yml` snippet configured for the created databases, warehouses, and service account
- `terraform-apply` — emit HCL files and initialize a working directory with `terraform init`; user runs `terraform plan` / `terraform apply` themselves

### 9. Post-Setup Checklist

Regardless of path, remind the user of manual steps that can't be scripted:

- [ ] Configure AWS / GCS / Azure IAM trust policy for storage integrations (use the `storage_aws_iam_user_arn` and `storage_aws_external_id` outputs)
- [ ] Set up S3 event notifications → SQS (if using Snowpipe)
- [ ] Configure Fivetran / Airbyte destinations with the new loader service account credentials
- [ ] Distribute service-account private keys to CI systems (never commit to source control)
- [ ] Set `DEFAULT_ROLE` on all human users to their least-privilege role — never ACCOUNTADMIN
- [ ] Configure notification integrations for resource monitor alerts (email, Slack via webhook)
- [ ] If PII discovery ran on empty RAW: rerun after first ingestion, then apply any newly-discovered masking policies
- [ ] Test masking as `ANALYST_ROLE` — confirm masked output, not plaintext
- [ ] Set up IdP-side SCIM app (paste SCIM access token from setup output)
- [ ] Test SSO login flow for one human user before enforcing `SSO_LOGIN_PAGE = TRUE`
- [ ] Store the rollback script somewhere retrievable (private ops repo) in case the setup needs to be undone
- [ ] Document topology, RBAC, and DR posture decisions in the team wiki
- [ ] Schedule a re-audit in 30 days (rerun `/snowflake-setup` and choose `audit`) to catch drift

## Usage

**Single entry point:** `/snowflake-setup`

The skill always starts by asking a small set of triage questions to establish scope, then routes into the appropriate workflow. There are no flags, positional args, or command variants — everything is driven by the interactive prompt.

### Turn 1 — Triage Questions (always ask, in this order)

Ask these upfront, before reading any references or generating any DDL. Present them as a single batch so the user can answer all at once.

1. **What kind of work is this?**
   - `greenfield` — brand-new Snowflake account, generate full setup
   - `audit` — existing account, scan for gaps and produce a scored remediation plan
   - `hybrid` — audit first, then extend the account toward a target topology

2. **Output format?**
   - `sql` — grouped executable SQL blocks (default)
   - `terraform` — HCL files for the Snowflake-Labs Terraform provider
   - `both` — emit both simultaneously

3. **How much control do you want at execution time?**
   - `review-only` — deliver plan + DDL/HCL as files; never offer to execute
   - `guided-execute` — after review, offer to run DDL via `sql_execute` against a configured Snowflake warehouse, pausing at each role switch
   - `dbt-integrate` — also emit a matching `profiles.yml` snippet
   - `terraform-apply` — emit HCL and prepare a `terraform init`-ready working directory (only offered if output format includes terraform)

### Turn 2 — Mode-Specific Questions

Based on the answer to triage Q1, ask the appropriate detailed questions:

- **`greenfield` or `hybrid`** → go to workflow step **2. Gather Requirements** and ask the 5 blocking + 4 optional + 5 feature-trigger questions listed there
- **`audit`** → go to workflow step **2b. Warehouse Preflight** first (verify a Snowflake warehouse is configured via `warehouse_list`; if not, prompt the user to run `warehouse_add` and stop). Then proceed to step **3. Run Diagnostic Queries**. Do not silently degrade to greenfield.

### Turn 3+ — Execute the Workflow

Follow workflow steps 4–9 in order. Never batch a workflow step with a triage question; each turn does one thing so the user can course-correct.

### Rules for the Triage Prompt

- **Never assume** — always ask Q1 even if the user's opening message hints at a mode. A message like "help me set up Snowflake" could mean greenfield or hybrid.
- **Never ask more than the triage batch on turn 1.** If the user typed a message like "audit my snowflake and generate terraform", accept those as answers to Q1 and Q2 and only ask the remaining triage question(s).
- **Confirm before proceeding** if the user's initial message conflicts with a triage answer (e.g. "greenfield" + "audit my existing"). Clarify which they meant.

## Guardrails

Non-negotiable behaviors the skill must enforce:

1. **No ACCOUNTADMIN to service accounts.** Any DDL granting ACCOUNTADMIN (directly or via role hierarchy) to a service account is a bug — refuse to emit it.
2. **Always include FUTURE grants** alongside object grants — the #1 forgotten step; silent access failures on new tables.
3. **Never `CREATE OR REPLACE`** for WAREHOUSE, ROLE, USER, DATABASE, SCHEMA, TABLE (non-transient), STORAGE INTEGRATION, PIPE, or RESOURCE MONITOR — use `ALTER` instead. See `idempotency-patterns.md` § DANGER.
4. **Storage integration DDL requires ACCOUNTADMIN** and one-time manual IAM setup — flag this in the plan header, not buried in a note.
5. **Prefer key-pair auth over passwords** for all service accounts. If the user asks for passwords, emit the DDL but include the upgrade path in the checklist.
6. **Never drop built-in roles or the `SNOWFLAKE` database** in rollback scripts.
7. **Audit mode requires a live connection.** Warehouse preflight (step 2b) must find a Snowflake warehouse via `warehouse_list` and pass a `SELECT CURRENT_ACCOUNT()` smoke test via `sql_execute` before any diagnostic query runs. Fail fast with `warehouse_add` guidance if not — do not silently degrade.
8. **PII discovery results are advisory, not authoritative.** Present classifications with confidence scores; require explicit user confirmation before applying masking policies to columns flagged as PII.
9. **Rollback scripts are gated.** Interactive confirmation prompt at the top; refuse to run without the account locator matching `CURRENT_ACCOUNT()`.
10. **Terraform state must not contain secrets.** If emitting Terraform, remind the user to use a remote backend and mark sensitive outputs.
11. **One role per GRANT statement — never comma-separate roles.** The comma-separated form (e.g. `GRANT USAGE ON DATABASE X TO ROLE A, B, C`) is silently dropped by the current `snowflake-sdk` driver — the query returns `(0 rows)` with no error and the roles receive nothing. See `references/rbac-patterns.md` § GRANT emission rule. Same rule applies to `REVOKE`.
