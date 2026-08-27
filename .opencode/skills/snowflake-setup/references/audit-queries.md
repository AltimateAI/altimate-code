# Brownfield Audit Queries

Queries the skill runs (via `sql_execute` against a configured Snowflake warehouse) to assess an existing account's setup. Each query maps to a check category; results feed into the gap-scored punch list.

## Prerequisites

Audit mode requires a live Snowflake connection. Before running any query, verify:

```sql
-- Must have ACCOUNT_USAGE access (typically ACCOUNTADMIN or a role explicitly granted IMPORTED PRIVILEGES on SNOWFLAKE)
SELECT CURRENT_ROLE(), CURRENT_ACCOUNT();
SHOW GRANTS TO ROLE IDENTIFIER(CURRENT_ROLE());
```

If `SNOWFLAKE.ACCOUNT_USAGE` is not accessible, the skill must fall back to `INFORMATION_SCHEMA` (per-database) and note the reduced coverage in the report.

### `ACCOUNT_USAGE` replication lag — cross-check with `SHOW`

`SNOWFLAKE.ACCOUNT_USAGE.*` views are refreshed with lag — typically 45 minutes to 2 hours per Snowflake's documentation. This means recently-created objects (created in the last ~2 hours) may not appear in these views yet, causing the audit to miss them.

**Rule: for every category the audit relies on `ACCOUNT_USAGE` for, also run the real-time `SHOW` command as a cross-check, and reconcile:**

| ACCOUNT_USAGE view (lagged) | Real-time `SHOW` equivalent |
|-----------------------------|-----------------------------|
| `DATABASES` | `SHOW DATABASES` |
| `SCHEMATA` | `SHOW SCHEMAS IN ACCOUNT` |
| `ROLES` | `SHOW ROLES` |
| `USERS` | `SHOW USERS` |
| `WAREHOUSES` | `SHOW WAREHOUSES` |
| `GRANTS_TO_ROLES` | `SHOW GRANTS TO ROLE <name>` (per role) |
| `POLICY_REFERENCES` | `SHOW MASKING POLICIES IN ACCOUNT` + per-column `POLICY_REFERENCES` table function |
| `TAG_REFERENCES` | `SHOW TAGS IN ACCOUNT` + per-object references |
| `WAREHOUSE_METERING_HISTORY` | No real-time equivalent — cost queries genuinely cannot cross-check; report the lag in the output |

If a `SHOW` returns an object that `ACCOUNT_USAGE` does not, treat the `SHOW` result as authoritative and note the lag in the finding. Verified against live account `DKZPOBS-TQ14188` on 2026-08-26 — recently-created `ORPHANED_ROLE` and `BAD_USER` did not appear in `ACCOUNT_USAGE.ROLES` / `ACCOUNT_USAGE.USERS` for 45+ minutes but appeared immediately in `SHOW ROLES` / `SHOW USERS`.

## Severity Rubric

Each finding is scored:

- **CRITICAL** — active security or data-loss risk (masking absent on PII, ACCOUNTADMIN as DEFAULT_ROLE, no resource monitors)
- **WARNING** — operational risk or best-practice violation (missing FUTURE grants, no dev environment, long Time Travel on staging)
- **INFO** — nice-to-have (untagged warehouses, no cost attribution)

## Section 1: Topology and Databases

```sql
-- All user databases (excludes system databases)
SELECT database_name, created, comment, retention_time
FROM SNOWFLAKE.ACCOUNT_USAGE.DATABASES
WHERE deleted IS NULL
  AND database_name NOT IN ('SNOWFLAKE', 'SNOWFLAKE_SAMPLE_DATA')
ORDER BY created;

-- Detect topology pattern
-- Presence of BRONZE/SILVER/GOLD → Medallion
-- Presence of RAW/TRANSFORM/ANALYTICS → Functional
-- Presence of ANALYTICS_<DOMAIN> → Domain-per-DB
-- None of the above → Ad-hoc / no discernible pattern (WARNING)

-- Schemas per database
SELECT catalog_name AS database, schema_name, comment
FROM SNOWFLAKE.ACCOUNT_USAGE.SCHEMATA
WHERE deleted IS NULL
  AND catalog_name NOT IN ('SNOWFLAKE', 'SNOWFLAKE_SAMPLE_DATA')
ORDER BY 1, 2;
```

## Section 2: Warehouses

```sql
-- Warehouse inventory
SHOW WAREHOUSES;

-- Warehouses without auto-suspend (CRITICAL — burns credits)
SELECT "name", "size", "auto_suspend", "auto_resume", "scaling_policy"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "auto_suspend" IS NULL OR "auto_suspend" > 600;

-- Warehouses with auto_resume disabled (WARNING)
SELECT "name" FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "auto_resume" = 'false';

-- Multi-cluster settings
SELECT "name", "min_cluster_count", "max_cluster_count", "scaling_policy"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));
```

## Section 3: RBAC

```sql
-- All custom roles (excluding built-ins)
SELECT name, comment, created_on
FROM SNOWFLAKE.ACCOUNT_USAGE.ROLES
WHERE deleted_on IS NULL
  AND name NOT IN ('ACCOUNTADMIN', 'SECURITYADMIN', 'SYSADMIN',
                   'USERADMIN', 'PUBLIC', 'ORGADMIN')
ORDER BY created_on;

-- CRITICAL: orphaned custom roles (not granted to SYSADMIN)
SELECT r.name AS role_name
FROM SNOWFLAKE.ACCOUNT_USAGE.ROLES r
WHERE r.deleted_on IS NULL
  AND r.name NOT IN ('ACCOUNTADMIN', 'SECURITYADMIN', 'SYSADMIN',
                     'USERADMIN', 'PUBLIC', 'ORGADMIN')
  AND NOT EXISTS (
    SELECT 1 FROM SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_ROLES g
    WHERE g.granted_to = 'ROLE'
      AND g.grantee_name = 'SYSADMIN'
      AND g.name = r.name
      AND g.privilege = 'USAGE'
      AND g.deleted_on IS NULL
  );

-- CRITICAL: users with ACCOUNTADMIN as DEFAULT_ROLE
SELECT name, email, default_role, default_warehouse, disabled
FROM SNOWFLAKE.ACCOUNT_USAGE.USERS
WHERE deleted_on IS NULL
  AND disabled = 'false'
  AND default_role IN ('ACCOUNTADMIN', 'SECURITYADMIN', 'ORGADMIN');

-- WARNING: schemas missing FUTURE grants (the #1 forgotten step)
-- Compare: existing SELECT grants on tables vs FUTURE table SELECT grants
WITH schemas_with_select_grants AS (
  SELECT DISTINCT table_catalog || '.' || table_schema AS schema_full
  FROM SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_ROLES
  WHERE granted_on = 'TABLE'
    AND privilege = 'SELECT'
    AND deleted_on IS NULL
),
schemas_with_future_grants AS (
  SELECT DISTINCT name AS schema_full
  FROM SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_ROLES
  WHERE granted_on = 'SCHEMA'
    AND privilege = 'SELECT'
    -- Future grants show up with granted_on = 'FUTURE_TABLE' internally
)
SELECT schema_full AS schema_missing_future_grants
FROM schemas_with_select_grants
WHERE schema_full NOT IN (SELECT schema_full FROM schemas_with_future_grants);

-- Service accounts (users flagged as service — no email, has default warehouse)
SELECT name, default_role, default_warehouse, last_success_login,
       days_to_expiry, has_password, has_rsa_public_key
FROM SNOWFLAKE.ACCOUNT_USAGE.USERS
WHERE deleted_on IS NULL
  AND (email IS NULL OR email LIKE '%service%' OR name LIKE '%_SVC' OR name LIKE 'FIVETRAN%');

-- CRITICAL: service accounts using password auth instead of key-pair
SELECT name FROM SNOWFLAKE.ACCOUNT_USAGE.USERS
WHERE deleted_on IS NULL
  AND has_password = 'true'
  AND has_rsa_public_key = 'false'
  AND (email IS NULL OR name LIKE '%_SVC');
```

## Section 4: Ingestion

```sql
-- Storage integrations
SHOW INTEGRATIONS;

-- Pipes and their status
SHOW PIPES IN ACCOUNT;

-- Pipes with recent errors
SELECT pipe_catalog_name, pipe_schema_name, pipe_name,
       last_load_time, error_count, first_error_message
FROM TABLE(SNOWFLAKE.INFORMATION_SCHEMA.PIPE_USAGE_HISTORY(
  DATE_RANGE_START => DATEADD('day', -7, CURRENT_TIMESTAMP())
))
WHERE error_count > 0
ORDER BY last_load_time DESC;

-- Tasks and their state (suspended tasks are silent failures)
SHOW TASKS IN ACCOUNT;

-- WARNING: tasks that haven't run in 7+ days despite being enabled
SELECT name, database_name, schema_name, state, schedule
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE state = 'started'
  AND schedule IS NOT NULL;
```

## Section 5: Governance

```sql
-- All masking policies in the account
SHOW MASKING POLICIES IN ACCOUNT;

-- All row access policies
SHOW ROW ACCESS POLICIES IN ACCOUNT;

-- CRITICAL: columns with likely PII names but no masking policy
-- (name-based heuristic; the skill should call altimate_core_classify_pii for accuracy)
WITH pii_column_candidates AS (
  SELECT table_catalog, table_schema, table_name, column_name
  FROM SNOWFLAKE.ACCOUNT_USAGE.COLUMNS
  WHERE deleted IS NULL
    AND table_schema NOT IN ('INFORMATION_SCHEMA')
    AND table_catalog NOT IN ('SNOWFLAKE', 'SNOWFLAKE_SAMPLE_DATA')
    AND (
      LOWER(column_name) LIKE '%email%'
      OR LOWER(column_name) LIKE '%phone%'
      OR LOWER(column_name) LIKE '%ssn%'
      OR LOWER(column_name) LIKE '%first_name%'
      OR LOWER(column_name) LIKE '%last_name%'
      OR LOWER(column_name) LIKE '%full_name%'
      OR LOWER(column_name) LIKE '%dob%'
      OR LOWER(column_name) LIKE '%birth%'
      OR LOWER(column_name) LIKE '%credit_card%'
      OR LOWER(column_name) LIKE '%cc_num%'
      OR LOWER(column_name) LIKE '%address%'
    )
),
columns_with_masking AS (
  SELECT ref_database_name, ref_schema_name, ref_entity_name, ref_column_name
  FROM SNOWFLAKE.ACCOUNT_USAGE.POLICY_REFERENCES
  WHERE policy_kind = 'MASKING_POLICY'
    AND policy_status = 'ACTIVE'
)
SELECT p.table_catalog, p.table_schema, p.table_name, p.column_name,
       'CRITICAL: likely PII with no masking' AS finding
FROM pii_column_candidates p
LEFT JOIN columns_with_masking m
  ON p.table_catalog = m.ref_database_name
  AND p.table_schema = m.ref_schema_name
  AND p.table_name = m.ref_entity_name
  AND p.column_name = m.ref_column_name
WHERE m.ref_column_name IS NULL;

-- Tag taxonomy coverage
SHOW TAGS IN ACCOUNT;

-- WARNING: warehouses without cost-attribution tags
SELECT w.name AS warehouse_name
FROM (SHOW WAREHOUSES) w
WHERE NOT EXISTS (
  SELECT 1 FROM SNOWFLAKE.ACCOUNT_USAGE.TAG_REFERENCES tr
  WHERE tr.domain = 'WAREHOUSE'
    AND tr.object_name = w.name
    AND tr.tag_name IN ('COST_CENTER', 'TEAM', 'ENVIRONMENT')
);
```

## Section 6: Cost Controls

```sql
-- Resource monitors
SHOW RESOURCE MONITORS;

-- CRITICAL: no account-level resource monitor
SELECT COUNT(*) AS account_monitor_count
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "level" = 'ACCOUNT';
-- Expect >= 1

-- CRITICAL: warehouses with no resource monitor attached
SELECT "name" AS warehouse_name
FROM (SHOW WAREHOUSES)
WHERE "resource_monitor" IS NULL OR "resource_monitor" = 'null';

-- INFO: current spending vs monitor limits
SELECT
  wm.warehouse_name,
  SUM(wm.credits_used) AS credits_last_30d,
  rm.credit_quota AS monitor_quota,
  ROUND(SUM(wm.credits_used) / NULLIF(rm.credit_quota, 0) * 100, 1) AS pct_of_quota
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY wm
LEFT JOIN SNOWFLAKE.ACCOUNT_USAGE.RESOURCE_MONITORS rm
  ON rm.name = (
    SELECT "resource_monitor" FROM (SHOW WAREHOUSES) w
    WHERE w."name" = wm.warehouse_name
  )
WHERE wm.start_time >= DATEADD('day', -30, CURRENT_TIMESTAMP())
GROUP BY 1, 3
ORDER BY pct_of_quota DESC;

-- Long Time Travel on ingestion / staging tables (INFO: storage waste)
SELECT table_catalog, table_schema, table_name, retention_time,
       ROUND(bytes / POWER(1024, 3), 2) AS size_gb
FROM SNOWFLAKE.ACCOUNT_USAGE.TABLES
WHERE deleted IS NULL
  AND retention_time > 1
  AND table_schema NOT IN ('INFORMATION_SCHEMA')
  AND (LOWER(table_catalog) LIKE '%raw%' OR LOWER(table_catalog) LIKE '%bronze%')
ORDER BY bytes DESC;
```

## Section 7: Network and Security

```sql
-- Network policies
SHOW NETWORK POLICIES;

-- WARNING: no account-level network policy set
SHOW PARAMETERS LIKE 'NETWORK_POLICY' IN ACCOUNT;

-- Users bypassing MFA (CRITICAL for password auth)
SELECT name, ext_authn_duo, mins_to_bypass_mfa
FROM SNOWFLAKE.ACCOUNT_USAGE.USERS
WHERE deleted_on IS NULL
  AND has_password = 'true'
  AND (ext_authn_duo = 'false' OR ext_authn_duo IS NULL)
  AND email IS NOT NULL;  -- human users only

-- Sessions from unexpected IPs (last 7 days)
SELECT DISTINCT client_ip, COUNT(*) AS session_count
FROM SNOWFLAKE.ACCOUNT_USAGE.SESSIONS
WHERE created_on >= DATEADD('day', -7, CURRENT_TIMESTAMP())
GROUP BY 1
ORDER BY 2 DESC;
```

## Section 8: Data Sharing and Replication

```sql
-- Outbound shares
SHOW SHARES;

-- Replication groups (DR posture)
SHOW REPLICATION GROUPS;

-- Failover groups
SHOW FAILOVER GROUPS;
```

## Aggregate Score

The skill computes an overall score after running all sections:

```
Total findings: <n>
  CRITICAL: <n>   ← must-fix before production
  WARNING:  <n>   ← operational risk
  INFO:     <n>   ← polish

Setup maturity: <0-100>
  100 – (CRITICAL × 10) – (WARNING × 3) – (INFO × 1)
  ≥ 90: production-ready
  70–89: usable with caveats
  < 70: requires remediation before relying on for production workloads
```

## Remediation DDL Generation

For each finding, the skill emits a remediation snippet from the appropriate reference file:

| Finding | Remediation source |
|---------|--------------------|
| Missing FUTURE grants | `references/rbac-patterns.md` § Privilege Reference |
| PII without masking | `references/governance-patterns.md` § Masking policies + Applying |
| No resource monitor | `references/cost-governance.md` § Resource Monitor Architecture |
| Warehouse no auto-suspend | `ALTER WAREHOUSE ... SET AUTO_SUSPEND = 60` |
| Orphaned custom role | `GRANT ROLE <name> TO ROLE SYSADMIN;` |
| DEFAULT_ROLE = ACCOUNTADMIN | `ALTER USER <name> SET DEFAULT_ROLE = <least_priv_role>;` |
| Service account with password | Key-pair auth setup (Batch 5 network/security section) |
| No account-level network policy | `references/network-security-patterns.md` (Batch 5) |
