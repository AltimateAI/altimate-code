-- ============================================================================
-- SNOWFLAKE GREENFIELD ROLLBACK
-- Companion to greenfield.sql — drops every object created by that script,
-- in strict reverse dependency order. Review-only: NOT executed by the agent.
-- ============================================================================
--
-- ROLLBACK CONFIRMATION
-- ============================================================================
-- This script will DROP:
--   - 3 databases (BRONZE, SILVER, GOLD) and ALL contained data
--   - 3 warehouses (LOADING_WH, TRANSFORM_WH, ANALYTICS_WH)
--   - 5 custom roles (DATA_PLATFORM_ADMIN, LOADER_ROLE, TRANSFORM_ROLE,
--     ANALYST_ROLE, BI_ROLE) and all their grants
--   - 1 service account (dbt_service)
--   - 1 storage integration (s3_bronze_integration)
--   - 4 resource monitors (account_monitor, loading_wh_monitor,
--     transform_wh_monitor, analytics_wh_monitor)
--   - 3 masking policies, 4 tags, 1 pipe, 1 stage, 1 file format
--
-- Estimated data loss: all data in BRONZE.APP.CUSTOMERS and any SILVER/GOLD
-- tables built on top of it. Time Travel retention (default 1 day unless
-- altered) may allow recovery within that window via UNDROP.
--
-- To proceed, uncomment the following line by replacing the placeholder with
-- your actual account locator (see: SELECT CURRENT_ACCOUNT();):
--
SET rollback_confirmed_account = 'BA06306';
--
-- The script will fail at the first destructive statement if this is not set
-- or does not match CURRENT_ACCOUNT(). This is a hard guard against
-- accidentally rolling back the wrong account.
-- ============================================================================

-- Guard — do not remove. Every destructive block below assumes this ran and
-- succeeded first.
SELECT CASE
  WHEN $rollback_confirmed_account = CURRENT_ACCOUNT() THEN 'proceed'
  ELSE ERROR('Rollback account mismatch or unconfirmed. Refusing to drop objects. Set $rollback_confirmed_account to CURRENT_ACCOUNT() first.')
END;


-- #############################################################################
-- ==== Run as SYSADMIN ====
-- #############################################################################
USE ROLE SYSADMIN;

-- ----------------------------------------------------------------------------
-- 1. Masking policies — unset from columns, then drop
-- ----------------------------------------------------------------------------
ALTER TABLE IF EXISTS BRONZE.APP.CUSTOMERS MODIFY COLUMN email      UNSET MASKING POLICY;
ALTER TABLE IF EXISTS BRONZE.APP.CUSTOMERS MODIFY COLUMN first_name UNSET MASKING POLICY;
ALTER TABLE IF EXISTS BRONZE.APP.CUSTOMERS MODIFY COLUMN last_name  UNSET MASKING POLICY;
-- If applied to downstream GOLD tables, unset there too before dropping the policy:
-- ALTER TABLE IF EXISTS GOLD.CORE.DIM_CUSTOMERS MODIFY COLUMN email      UNSET MASKING POLICY;
-- ALTER TABLE IF EXISTS GOLD.CORE.DIM_CUSTOMERS MODIFY COLUMN first_name UNSET MASKING POLICY;
-- ALTER TABLE IF EXISTS GOLD.CORE.DIM_CUSTOMERS MODIFY COLUMN last_name  UNSET MASKING POLICY;

DROP MASKING POLICY IF EXISTS BRONZE.APP.mask_email;
DROP MASKING POLICY IF EXISTS BRONZE.APP.mask_first_name;
DROP MASKING POLICY IF EXISTS BRONZE.APP.mask_last_name;

-- (No row access policies were created in greenfield.sql — none to unset/drop.)

-- ----------------------------------------------------------------------------
-- 2. Tag references — unset, then drop tag definitions
-- ----------------------------------------------------------------------------
ALTER TABLE IF EXISTS BRONZE.APP.CUSTOMERS
  MODIFY COLUMN email      UNSET TAG BRONZE.APP.pii_category, BRONZE.APP.data_sensitivity;
ALTER TABLE IF EXISTS BRONZE.APP.CUSTOMERS
  MODIFY COLUMN first_name UNSET TAG BRONZE.APP.pii_category, BRONZE.APP.data_sensitivity;
ALTER TABLE IF EXISTS BRONZE.APP.CUSTOMERS
  MODIFY COLUMN last_name  UNSET TAG BRONZE.APP.pii_category, BRONZE.APP.data_sensitivity;

ALTER WAREHOUSE IF EXISTS LOADING_WH   UNSET TAG BRONZE.APP.cost_center, BRONZE.APP.environment;
ALTER WAREHOUSE IF EXISTS TRANSFORM_WH UNSET TAG BRONZE.APP.cost_center, BRONZE.APP.environment;
ALTER WAREHOUSE IF EXISTS ANALYTICS_WH UNSET TAG BRONZE.APP.cost_center, BRONZE.APP.environment;

DROP TAG IF EXISTS BRONZE.APP.pii_category;
DROP TAG IF EXISTS BRONZE.APP.data_sensitivity;
DROP TAG IF EXISTS BRONZE.APP.cost_center;
DROP TAG IF EXISTS BRONZE.APP.environment;

-- ----------------------------------------------------------------------------
-- 3. Pipes and tasks — suspend before drop (no tasks were created; Snowpipe
--    only, per the ingestion selection)
-- ----------------------------------------------------------------------------
-- Pipes do not support ALTER ... SUSPEND the way tasks do; simply drop.
DROP PIPE IF EXISTS BRONZE.APP.customers_pipe;

-- ----------------------------------------------------------------------------
-- 4. External stages and file formats
-- ----------------------------------------------------------------------------
DROP STAGE IF EXISTS BRONZE.APP.s3_stage;
DROP FILE FORMAT IF EXISTS BRONZE.APP.parquet_standard;

-- ----------------------------------------------------------------------------
-- 5. Tables and schemas are dropped implicitly via database drop in step 6
--    below (per idempotency-patterns.md, dropping the database removes all
--    contained tables/views/schemas). Listed here for dependency-order
--    documentation only — no separate statement needed.
-- ----------------------------------------------------------------------------


-- #############################################################################
-- ==== Run as ACCOUNTADMIN ====
-- #############################################################################
USE ROLE ACCOUNTADMIN;

-- ----------------------------------------------------------------------------
-- 6. Databases (drops all contained schemas, tables, views)
-- ----------------------------------------------------------------------------
DROP DATABASE IF EXISTS BRONZE;
DROP DATABASE IF EXISTS SILVER;
DROP DATABASE IF EXISTS GOLD;

-- ----------------------------------------------------------------------------
-- 7. Warehouses
-- ----------------------------------------------------------------------------
DROP WAREHOUSE IF EXISTS LOADING_WH;
DROP WAREHOUSE IF EXISTS TRANSFORM_WH;
DROP WAREHOUSE IF EXISTS ANALYTICS_WH;

-- ----------------------------------------------------------------------------
-- 8. Resource monitors (unset from warehouses/account first — warehouses
--    are already dropped above, which auto-detaches their monitors; the
--    account-level monitor still needs an explicit UNSET)
-- ----------------------------------------------------------------------------
ALTER ACCOUNT UNSET RESOURCE_MONITOR;

DROP RESOURCE MONITOR IF EXISTS loading_wh_monitor;
DROP RESOURCE MONITOR IF EXISTS transform_wh_monitor;
DROP RESOURCE MONITOR IF EXISTS analytics_wh_monitor;
DROP RESOURCE MONITOR IF EXISTS account_monitor;

-- ----------------------------------------------------------------------------
-- 9. Storage integration
-- ----------------------------------------------------------------------------
DROP INTEGRATION IF EXISTS s3_bronze_integration;

-- (No notification integration was created in greenfield.sql — the email
-- notification integration in that file was commented out as optional.)


-- #############################################################################
-- ==== Run as SECURITYADMIN ====
-- #############################################################################
USE ROLE SECURITYADMIN;

-- ----------------------------------------------------------------------------
-- 10. Service accounts
-- ----------------------------------------------------------------------------
DROP USER IF EXISTS dbt_service;

-- ----------------------------------------------------------------------------
-- 11. Grants — revoke custom roles from SYSADMIN before dropping them
-- ----------------------------------------------------------------------------
REVOKE ROLE DATA_PLATFORM_ADMIN FROM ROLE SYSADMIN;
REVOKE ROLE LOADER_ROLE         FROM ROLE SYSADMIN;
REVOKE ROLE TRANSFORM_ROLE      FROM ROLE SYSADMIN;
REVOKE ROLE ANALYST_ROLE        FROM ROLE SYSADMIN;
REVOKE ROLE BI_ROLE             FROM ROLE SYSADMIN;

-- ----------------------------------------------------------------------------
-- 12. Custom roles
--     Never drops built-in roles (ACCOUNTADMIN, SECURITYADMIN, SYSADMIN,
--     USERADMIN, ORGADMIN, PUBLIC) — only the custom roles created in
--     greenfield.sql.
-- ----------------------------------------------------------------------------
DROP ROLE IF EXISTS DATA_PLATFORM_ADMIN;
DROP ROLE IF EXISTS LOADER_ROLE;
DROP ROLE IF EXISTS TRANSFORM_ROLE;
DROP ROLE IF EXISTS ANALYST_ROLE;
DROP ROLE IF EXISTS BI_ROLE;

-- ============================================================================
-- POST-ROLLBACK VALIDATION
-- ============================================================================
SHOW DATABASES LIKE 'BRONZE';   -- expect: no rows
SHOW DATABASES LIKE 'SILVER';   -- expect: no rows
SHOW DATABASES LIKE 'GOLD';     -- expect: no rows
SHOW WAREHOUSES LIKE '%_WH';    -- expect: no rows
SHOW ROLES LIKE '%_ROLE';       -- expect: no rows (DATA_PLATFORM_ADMIN also gone)
SHOW RESOURCE MONITORS;         -- expect: no rows
SHOW INTEGRATIONS LIKE 's3_bronze_integration';  -- expect: no rows
SHOW USERS LIKE 'dbt_service';  -- expect: no rows
