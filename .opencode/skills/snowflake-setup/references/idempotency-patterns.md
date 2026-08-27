# Idempotency and Rollback Patterns

## Emission Modes

The skill supports three emission modes for every DDL section. Choose based on the target account state.

| Mode | Behavior | Use when |
|------|----------|----------|
| `strict` | Plain `CREATE` — fails if object exists | Fresh account, want to be sure nothing collides |
| `idempotent` | `CREATE ... IF NOT EXISTS` (creates if missing, skips if present) — **default** | Rerunning setup safely; partial state possible |
| `additive` | Detects existing objects first via `SHOW`/`INFORMATION_SCHEMA`, emits DDL only for missing ones | Extending a partially-configured account without touching existing objects |

**Never use `CREATE OR REPLACE` for objects that hold state or grants** — see danger list below.

## Idempotent DDL Reference

### Safe with `CREATE IF NOT EXISTS`
```sql
CREATE DATABASE IF NOT EXISTS RAW COMMENT = 'Raw ingestion layer';
CREATE SCHEMA IF NOT EXISTS RAW.SALESFORCE;
CREATE ROLE IF NOT EXISTS TRANSFORM_ROLE;
CREATE WAREHOUSE IF NOT EXISTS TRANSFORM_WH
  WAREHOUSE_SIZE = 'SMALL' AUTO_SUSPEND = 60 AUTO_RESUME = TRUE;
CREATE FILE FORMAT IF NOT EXISTS RAW.PUBLIC.csv_standard TYPE = 'CSV';
CREATE STAGE IF NOT EXISTS RAW.SALESFORCE.s3_stage
  STORAGE_INTEGRATION = s3_raw_integration
  URL = 's3://your-data-bucket/salesforce/';
CREATE TABLE IF NOT EXISTS RAW.SALESFORCE.ACCOUNTS (...);
CREATE TAG IF NOT EXISTS RAW.PUBLIC.cost_center;
CREATE PIPE IF NOT EXISTS RAW.SALESFORCE.accounts_pipe
  AUTO_INGEST = TRUE AS COPY INTO ...;
CREATE TASK IF NOT EXISTS RAW.SALESFORCE.load_accounts_hourly
  WAREHOUSE = LOADING_WH SCHEDULE = '...' AS ...;
```

### `CREATE OR REPLACE` — use only for these
`OR REPLACE` drops and recreates. Safe when the object holds no state, no grants, and no dependent objects.

```sql
-- Masking policies and row access policies: no state, easy to reapply
CREATE OR REPLACE MASKING POLICY mask_email AS (val STRING) RETURNS STRING -> ...;
CREATE OR REPLACE ROW ACCESS POLICY team_access_policy AS (team_id VARCHAR) RETURNS BOOLEAN -> ...;

-- File formats: no state, references are re-resolved
CREATE OR REPLACE FILE FORMAT RAW.PUBLIC.csv_standard TYPE = 'CSV' ...;
```

### **DANGER: never use `CREATE OR REPLACE` for**

| Object | Why it's dangerous |
|--------|-------------------|
| `WAREHOUSE` | Terminates active connections; in-flight queries fail |
| `ROLE` | Drops all grants ON and TO the role; downstream users lose access silently |
| `USER` | Drops password/keys; service accounts start failing auth immediately |
| `DATABASE` / `SCHEMA` | Drops all contained objects (tables, views, pipes, tasks) — catastrophic data loss |
| `TABLE` (non-transient) | Drops data. Time Travel can recover but only within retention window |
| `STORAGE INTEGRATION` | Regenerates external ID; requires re-running IAM trust policy setup |
| `PIPE` | Loses load history; may re-ingest already-loaded files |
| `RESOURCE MONITOR` | Loses accumulated credit usage; effectively resets the budget mid-period |

If any of these need to change, use `ALTER` instead — never `CREATE OR REPLACE`.

## `ALTER` vs `CREATE OR REPLACE` Cheatsheet

```sql
-- Warehouse: use ALTER
ALTER WAREHOUSE TRANSFORM_WH SET WAREHOUSE_SIZE = 'MEDIUM' AUTO_SUSPEND = 120;

-- Task schedule change: use ALTER (must SUSPEND first)
ALTER TASK RAW.SALESFORCE.load_accounts_hourly SUSPEND;
ALTER TASK RAW.SALESFORCE.load_accounts_hourly SET SCHEDULE = 'USING CRON 0 */2 * * * UTC';
ALTER TASK RAW.SALESFORCE.load_accounts_hourly RESUME;

-- Resource monitor threshold: use ALTER
ALTER RESOURCE MONITOR account_monitor SET CREDIT_QUOTA = 750;

-- Table column addition: use ALTER, not OR REPLACE
ALTER TABLE RAW.SALESFORCE.ACCOUNTS ADD COLUMN email VARCHAR;
```

## Grants: Idempotent by Design

Snowflake `GRANT` is naturally idempotent — running the same grant twice is a no-op. No `IF NOT EXISTS` variant needed or supported.

```sql
GRANT SELECT ON ALL TABLES IN SCHEMA RAW.SALESFORCE TO ROLE ANALYST_ROLE;
GRANT SELECT ON FUTURE TABLES IN SCHEMA RAW.SALESFORCE TO ROLE ANALYST_ROLE;
-- Rerun safely: no error, no state change
```

**Exception:** `GRANT ROLE X TO ROLE Y` creates a hierarchy edge. Running twice is a no-op, but revoking requires the reverse `REVOKE ROLE X FROM ROLE Y`.

## Additive Mode: Existence Checks

Before emitting DDL in `additive` mode, run these checks and skip anything that already exists.

```sql
-- Databases present?
SELECT database_name FROM SNOWFLAKE.INFORMATION_SCHEMA.DATABASES
WHERE database_name IN ('RAW', 'TRANSFORM', 'ANALYTICS');

-- Warehouses present?
SHOW WAREHOUSES LIKE 'TRANSFORM_WH';

-- Roles present?
SHOW ROLES LIKE 'TRANSFORM_ROLE';

-- Resource monitors present?
SHOW RESOURCE MONITORS;

-- Storage integrations present?
SHOW INTEGRATIONS LIKE 's3_raw_integration';

-- Pipes on a schema?
SHOW PIPES IN SCHEMA RAW.SALESFORCE;

-- Masking policies on a table?
SELECT ref_column_name, policy_name
FROM TABLE(INFORMATION_SCHEMA.POLICY_REFERENCES(
  REF_ENTITY_NAME => 'RAW.SALESFORCE.CONTACTS',
  REF_ENTITY_DOMAIN => 'TABLE'
));
```

## Rollback Script Generation

Every setup produces companion rollback scripts. The rollback DROPs objects in strict reverse dependency order.

### Delivery: two files, not one

The altimate-code `sql_execute` tool has a non-bypassable safety guard that blocks `DROP DATABASE`, `DROP SCHEMA`, and `TRUNCATE`. Emit rollback as **two files** so the tool-safe portion can auto-execute and the manual portion is clearly flagged:

- `rollback-tool-safe.sql` — steps 1–7 and 9–14 below. Runs via `sql_execute`.
- `rollback-manual.sql` — steps 7 (schemas) and 8 (databases) only. User must run this via `snowsql`, Snowsight, or a direct `snowflake-sdk` script.

Both files begin with the same account-locator confirmation guard. `rollback-manual.sql` is a small file — usually just a few `DROP DATABASE IF EXISTS` and `DROP SCHEMA IF EXISTS` lines — but must never be omitted or the account is left in a partially-torn-down state.

### Dependency Order (drop in this sequence)

```
1. Row access policies (unset from tables, then drop)              [tool-safe]
2. Masking policies (unset from columns, then drop)                [tool-safe]
3. Tag references (unset tags, then drop tag definitions)          [tool-safe]
4. Pipes and tasks                                                 [tool-safe]
5. External stages and file formats                                [tool-safe]
6. Tables and views                                                [tool-safe]
7. Schemas                                                         [MANUAL — DROP SCHEMA blocked by tool guard]
8. Databases                                                       [MANUAL — DROP DATABASE blocked by tool guard]
9. Warehouses                                                      [tool-safe]
10. Resource monitors (must be unset from warehouses first)        [tool-safe]
11. Grants (revoke from custom roles)                              [tool-safe]
12. Custom roles (revoke from parent roles first)                  [tool-safe]
13. Service account users                                          [tool-safe]
14. Storage integrations and notification integrations             [tool-safe]
```

### Rollback Template Fragments

```sql
-- 1. Policies: unset before drop
USE ROLE SYSADMIN;
ALTER TABLE RAW.SALESFORCE.CONTACTS MODIFY COLUMN email UNSET MASKING POLICY;
ALTER TABLE ANALYTICS.CORE.orders DROP ROW ACCESS POLICY team_access_policy;
DROP MASKING POLICY IF EXISTS mask_email;
DROP ROW ACCESS POLICY IF EXISTS team_access_policy;

-- 2. Tags
ALTER WAREHOUSE TRANSFORM_WH UNSET TAG cost_center, environment;
DROP TAG IF EXISTS cost_center;

-- 3. Pipes and tasks (suspend before drop)
ALTER TASK RAW.SALESFORCE.load_accounts_hourly SUSPEND;
DROP TASK IF EXISTS RAW.SALESFORCE.load_accounts_hourly;
DROP PIPE IF EXISTS RAW.SALESFORCE.accounts_pipe;

-- 4. Stages and file formats
DROP STAGE IF EXISTS RAW.SALESFORCE.s3_stage;
DROP FILE FORMAT IF EXISTS RAW.PUBLIC.csv_standard;

-- 5. Databases (this drops all contained objects)
USE ROLE ACCOUNTADMIN;
DROP DATABASE IF EXISTS RAW;
DROP DATABASE IF EXISTS TRANSFORM;
DROP DATABASE IF EXISTS ANALYTICS;

-- 6. Warehouses
DROP WAREHOUSE IF EXISTS LOADING_WH;
DROP WAREHOUSE IF EXISTS TRANSFORM_WH;
DROP WAREHOUSE IF EXISTS ANALYTICS_WH;

-- 7. Resource monitors (unset from warehouses first)
ALTER WAREHOUSE TRANSFORM_WH UNSET RESOURCE_MONITOR;
DROP RESOURCE MONITOR IF EXISTS transform_wh_monitor;
DROP RESOURCE MONITOR IF EXISTS account_monitor;

-- 8. Roles (revoke from SYSADMIN first)
USE ROLE SECURITYADMIN;
REVOKE ROLE TRANSFORM_ROLE FROM ROLE SYSADMIN;
DROP ROLE IF EXISTS TRANSFORM_ROLE;

-- 9. Service accounts
DROP USER IF EXISTS fivetran_loader;
DROP USER IF EXISTS dbt_service;

-- 10. Storage integrations
USE ROLE ACCOUNTADMIN;
DROP INTEGRATION IF EXISTS s3_raw_integration;
```

## Rollback Safety Rules

The generated rollback script **must**:

1. Use `IF EXISTS` on every `DROP` — never fail because an object was already removed
2. Include an interactive prompt at the top requiring the user to type the account identifier before destructive statements execute (prevents accidental prod rollback)
3. Never emit `DROP ... CASCADE` — cascade drops mask dependency errors that reveal misconfigured environments
4. Never drop the built-in `PUBLIC` role, `ACCOUNTADMIN`, `SECURITYADMIN`, `SYSADMIN`, `USERADMIN`, or `ORGADMIN` roles
5. Never drop the `SNOWFLAKE` database or `INFORMATION_SCHEMA` schemas
6. Emit `SUSPEND` before dropping any `TASK` or `PIPE`
7. Emit `UNSET` for masking/row-access policies and tags before dropping the policy/tag definition
8. Emit `UNSET RESOURCE_MONITOR` on warehouses before dropping the monitor
9. Include a `WHERE environment != 'prod'` guard when running against a mixed-env account, or refuse to run without an explicit `--include-prod` flag

## Confirmation Prompt Template

```sql
-- ============================================================
-- ROLLBACK CONFIRMATION
-- ============================================================
-- This script will DROP:
--   - 3 databases (RAW, TRANSFORM, ANALYTICS) and ALL contained data
--   - 4 warehouses
--   - 5 custom roles and all their grants
--   - 2 service accounts
--   - 1 storage integration
--
-- Estimated data loss: ~<size> GB across <count> tables
-- Time Travel retention: <n> days (data may be recoverable within window)
--
-- To proceed, uncomment the following line by removing the `-- ` prefix:
--
-- SET rollback_confirmed_account = '<PASTE_ACCOUNT_LOCATOR_HERE>';
--
-- The script will fail at the first destructive statement if this is not set
-- or does not match CURRENT_ACCOUNT().
-- ============================================================

-- Guard at top of destructive section
SELECT CASE
  WHEN $rollback_confirmed_account = CURRENT_ACCOUNT() THEN 'proceed'
  ELSE ERROR('Rollback account mismatch or unconfirmed. Refusing to drop objects.')
END;
```
