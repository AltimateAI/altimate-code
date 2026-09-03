-- ============================================================================
-- SNOWFLAKE GREENFIELD SETUP
-- Mode: greenfield | Emission: idempotent | Execution: review-only (NOT executed)
-- Topology: Medallion (BRONZE / SILVER / GOLD)
-- RBAC: small-team, single-layer functional roles
-- Environments: prod-only
-- Ingestion: Snowpipe (event-driven, AWS S3)
-- Budget: 500 credits/month (account ceiling)
-- PII: declared categories -> email, first_name, last_name
-- Multi-tenancy: none | Advanced features: none (no IP policy, no SSO,
--   no DR/replication, no data sharing, no Cortex)
-- ============================================================================
--
-- HOW TO USE THIS FILE
-- Run each "==== Run as <ROLE> ====" block while USE ROLE <ROLE> is active,
-- in the order they appear. Every CREATE is idempotent (IF NOT EXISTS) so
-- re-running this script is safe. This script performs NO destructive
-- operations and is safe to review before any execution.
--
-- ============================================================================
-- CONFIGURE BEFORE RUNNING — placeholder checklist
-- ============================================================================
--   [ ] <STORAGE_AWS_ROLE_ARN>        -- IAM role ARN Snowflake will assume for S3 access
--   [ ] <S3_RAW_BUCKET_URL>           -- e.g. s3://your-company-raw-data/
--   [ ] <SOURCE_SCHEMA_NAME>          -- rename APP to your actual source system name
--   [ ] <SOURCE_TABLE_NAME>           -- rename CUSTOMERS to your actual source table
--   [ ] <NOTIFICATION_EMAIL>          -- email address for resource monitor alerts
--   [ ] <DBT_SERVICE_PUBLIC_KEY>      -- RSA public key for dbt_service key-pair auth
--   [ ] After CREATE STORAGE INTEGRATION runs, run DESC INTEGRATION and copy
--       STORAGE_AWS_IAM_USER_ARN + STORAGE_AWS_EXTERNAL_ID into the AWS IAM
--       role's trust policy (manual, outside Snowflake — see bottom of file)
--   [ ] After CREATE PIPE runs, run SHOW PIPES and copy notification_channel
--       (SQS ARN) into the S3 bucket's Event Notifications config (manual)
--
-- NOTE ON SCOPE (explicitly not needed given the answers provided):
--   - No DEV/staging databases or zero-copy clones: envs = prod-only
--   - No access-role layer (RAW_READ / ANALYTICS_WRITE, etc.): RBAC = small-team
--   - No row access policies: no multi-tenancy declared
--   - No network policies / SSO / MFA integrations: no advanced features requested
--   - No DR / replication / failover groups: no advanced features requested
--   - No data sharing / reader accounts: no advanced features requested
--   - No Cortex / ML warehouse: no advanced features requested
--   - No Terraform output: format = sql only
-- ============================================================================


-- #############################################################################
-- ==== Run as ACCOUNTADMIN ====
-- #############################################################################
USE ROLE ACCOUNTADMIN;

-- ----------------------------------------------------------------------------
-- 1. Databases and Schemas (Medallion topology)
-- ----------------------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS BRONZE COMMENT = 'Raw ingestion layer';
CREATE DATABASE IF NOT EXISTS SILVER COMMENT = 'Cleaned and conformed data (dbt staging + intermediate)';
CREATE DATABASE IF NOT EXISTS GOLD   COMMENT = 'Business-ready marts';

-- One schema per ingestion source in BRONZE.
-- Rename APP to your actual source system (e.g. SALESFORCE, STRIPE, POSTGRES_APP).
CREATE SCHEMA IF NOT EXISTS BRONZE.APP COMMENT = 'Landing schema for <SOURCE_SCHEMA_NAME> via Snowpipe';

CREATE SCHEMA IF NOT EXISTS SILVER.STAGING      COMMENT = 'dbt staging models (stg_*)';
CREATE SCHEMA IF NOT EXISTS SILVER.INTERMEDIATE COMMENT = 'dbt intermediate models (int_*)';

CREATE SCHEMA IF NOT EXISTS GOLD.CORE COMMENT = 'Shared dimensions and facts (dim_*, fct_*)';
CREATE SCHEMA IF NOT EXISTS GOLD.MART COMMENT = 'Business-domain marts (mart_*)';

-- ----------------------------------------------------------------------------
-- 2. Warehouses
-- Sizes follow the standard sizing guide for a small team, prod-only account.
-- ----------------------------------------------------------------------------
CREATE WAREHOUSE IF NOT EXISTS LOADING_WH
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE
  COMMENT = 'Snowpipe / COPY loading workloads';

CREATE WAREHOUSE IF NOT EXISTS TRANSFORM_WH
  WAREHOUSE_SIZE = 'SMALL'
  AUTO_SUSPEND = 120
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE
  COMMENT = 'dbt transformation workloads (SILVER + GOLD builds)';

CREATE WAREHOUSE IF NOT EXISTS ANALYTICS_WH
  WAREHOUSE_SIZE = 'MEDIUM'
  AUTO_SUSPEND = 300
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE
  COMMENT = 'BI dashboards and ad-hoc analyst queries';

-- ----------------------------------------------------------------------------
-- 3. Resource Monitors — account ceiling 500 credits/month, split per warehouse
--    (LOADING 50 + TRANSFORM 200 + ANALYTICS 200 = 450, leaving headroom
--     under the 500-credit account ceiling for cloud services / variance)
-- ----------------------------------------------------------------------------
CREATE RESOURCE MONITOR IF NOT EXISTS account_monitor
  WITH CREDIT_QUOTA = 500
  FREQUENCY = MONTHLY
  START_TIMESTAMP = IMMEDIATELY
  TRIGGERS
    ON 50  PERCENT DO NOTIFY
    ON 75  PERCENT DO NOTIFY
    ON 90  PERCENT DO NOTIFY
    ON 100 PERCENT DO SUSPEND;

ALTER ACCOUNT SET RESOURCE_MONITOR = account_monitor;

CREATE RESOURCE MONITOR IF NOT EXISTS loading_wh_monitor
  WITH CREDIT_QUOTA = 50
  FREQUENCY = MONTHLY
  START_TIMESTAMP = IMMEDIATELY
  TRIGGERS
    ON 75  PERCENT DO NOTIFY
    ON 100 PERCENT DO SUSPEND;

CREATE RESOURCE MONITOR IF NOT EXISTS transform_wh_monitor
  WITH CREDIT_QUOTA = 200
  FREQUENCY = MONTHLY
  START_TIMESTAMP = IMMEDIATELY
  TRIGGERS
    ON 75  PERCENT DO NOTIFY
    ON 100 PERCENT DO SUSPEND;

CREATE RESOURCE MONITOR IF NOT EXISTS analytics_wh_monitor
  WITH CREDIT_QUOTA = 200
  FREQUENCY = MONTHLY
  START_TIMESTAMP = IMMEDIATELY
  TRIGGERS
    ON 75  PERCENT DO NOTIFY
    ON 100 PERCENT DO SUSPEND;

ALTER WAREHOUSE LOADING_WH   SET RESOURCE_MONITOR = loading_wh_monitor;
ALTER WAREHOUSE TRANSFORM_WH SET RESOURCE_MONITOR = transform_wh_monitor;
ALTER WAREHOUSE ANALYTICS_WH SET RESOURCE_MONITOR = analytics_wh_monitor;

-- Configure email notifications for resource monitor alerts (manual: set up
-- a notification integration or account-level email in Snowsight ->
-- Admin -> Notifications). Replace <NOTIFICATION_EMAIL> below if using an
-- email notification integration:
-- CREATE NOTIFICATION INTEGRATION IF NOT EXISTS resource_monitor_alerts
--   TYPE = EMAIL
--   ENABLED = TRUE
--   ALLOWED_RECIPIENTS = ('<NOTIFICATION_EMAIL>');

-- ----------------------------------------------------------------------------
-- 4. Storage Integration (AWS S3) — required for Snowpipe
--    REPLACE BEFORE RUNNING: STORAGE_AWS_ROLE_ARN, STORAGE_ALLOWED_LOCATIONS
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 5. Custom Roles (small-team, single-layer functional roles)
-- ----------------------------------------------------------------------------
CREATE ROLE IF NOT EXISTS DATA_PLATFORM_ADMIN COMMENT = 'Full admin over all databases and warehouses';
CREATE ROLE IF NOT EXISTS LOADER_ROLE         COMMENT = 'Snowpipe / ingestion service role — writes to BRONZE only';
CREATE ROLE IF NOT EXISTS TRANSFORM_ROLE      COMMENT = 'dbt service role — reads BRONZE, writes SILVER + GOLD';
CREATE ROLE IF NOT EXISTS ANALYST_ROLE        COMMENT = 'Human analysts — reads GOLD only, masked PII';
CREATE ROLE IF NOT EXISTS BI_ROLE             COMMENT = 'BI tool service account — reads GOLD only, masked PII';

-- ----------------------------------------------------------------------------
-- 6. Grant custom roles to SYSADMIN (avoids orphaned roles — Common Mistake 1)
-- ----------------------------------------------------------------------------
GRANT ROLE DATA_PLATFORM_ADMIN TO ROLE SYSADMIN;
GRANT ROLE LOADER_ROLE         TO ROLE SYSADMIN;
GRANT ROLE TRANSFORM_ROLE      TO ROLE SYSADMIN;
GRANT ROLE ANALYST_ROLE        TO ROLE SYSADMIN;
GRANT ROLE BI_ROLE             TO ROLE SYSADMIN;

-- Sections not emitted (explicitly not needed):
--   Network policies             -- no advanced features requested
--   Security integrations (SSO)  -- no advanced features requested
--   Replication / failover groups-- no advanced features requested
--   Cortex warehouse             -- no advanced features requested


-- #############################################################################
-- ==== Run as SECURITYADMIN ====
-- #############################################################################
USE ROLE SECURITYADMIN;

-- ----------------------------------------------------------------------------
-- 7. Service Accounts
--    Snowpipe itself uses the storage integration (no login user required),
--    but a dbt service account is needed to run TRANSFORM_ROLE workloads.
--    Key-pair auth preferred over password auth.
-- ----------------------------------------------------------------------------
CREATE USER IF NOT EXISTS dbt_service
  DEFAULT_ROLE = TRANSFORM_ROLE
  DEFAULT_WAREHOUSE = TRANSFORM_WH
  -- RSA_PUBLIC_KEY skipped (would need real public key)
  MUST_CHANGE_PASSWORD = FALSE
  COMMENT = 'dbt Cloud / dbt Core CI service account';
GRANT ROLE TRANSFORM_ROLE TO USER dbt_service;

-- ----------------------------------------------------------------------------
-- 8. DEFAULT_ROLE / DEFAULT_WAREHOUSE bindings for human users
--    Add one ALTER USER per team member once accounts exist. Never bind
--    DEFAULT_ROLE = ACCOUNTADMIN for a human's day-to-day account
--    (Common RBAC Mistake 3).
-- ----------------------------------------------------------------------------
-- ALTER USER <analyst_username> SET DEFAULT_ROLE = ANALYST_ROLE, DEFAULT_WAREHOUSE = ANALYTICS_WH;

-- Section not emitted (explicitly not needed): network policy application to
-- service accounts / MFA enforcement — no advanced features requested.


-- #############################################################################
-- ==== Run as SYSADMIN ====
-- #############################################################################
USE ROLE SYSADMIN;

-- ----------------------------------------------------------------------------
-- 9. Warehouse USAGE / OPERATE grants
-- ----------------------------------------------------------------------------
GRANT USAGE, OPERATE ON WAREHOUSE LOADING_WH   TO ROLE LOADER_ROLE;
GRANT USAGE, OPERATE ON WAREHOUSE TRANSFORM_WH TO ROLE TRANSFORM_ROLE;
GRANT USAGE, OPERATE ON WAREHOUSE ANALYTICS_WH TO ROLE ANALYST_ROLE;
GRANT USAGE, OPERATE ON WAREHOUSE ANALYTICS_WH TO ROLE BI_ROLE;
GRANT USAGE, OPERATE ON WAREHOUSE LOADING_WH   TO ROLE DATA_PLATFORM_ADMIN;
GRANT USAGE, OPERATE ON WAREHOUSE TRANSFORM_WH TO ROLE DATA_PLATFORM_ADMIN;
GRANT USAGE, OPERATE ON WAREHOUSE ANALYTICS_WH TO ROLE DATA_PLATFORM_ADMIN;

-- ----------------------------------------------------------------------------
-- 10. Database / schema USAGE grants
-- ----------------------------------------------------------------------------
GRANT USAGE ON DATABASE BRONZE TO ROLE DATA_PLATFORM_ADMIN, LOADER_ROLE, TRANSFORM_ROLE;
GRANT USAGE ON DATABASE SILVER TO ROLE DATA_PLATFORM_ADMIN, TRANSFORM_ROLE;
GRANT USAGE ON DATABASE GOLD   TO ROLE DATA_PLATFORM_ADMIN, TRANSFORM_ROLE, ANALYST_ROLE, BI_ROLE;

GRANT USAGE ON SCHEMA BRONZE.APP           TO ROLE LOADER_ROLE, TRANSFORM_ROLE, DATA_PLATFORM_ADMIN;
GRANT USAGE ON SCHEMA SILVER.STAGING       TO ROLE TRANSFORM_ROLE, DATA_PLATFORM_ADMIN;
GRANT USAGE ON SCHEMA SILVER.INTERMEDIATE  TO ROLE TRANSFORM_ROLE, DATA_PLATFORM_ADMIN;
GRANT USAGE ON SCHEMA GOLD.CORE            TO ROLE TRANSFORM_ROLE, ANALYST_ROLE, BI_ROLE, DATA_PLATFORM_ADMIN;
GRANT USAGE ON SCHEMA GOLD.MART            TO ROLE TRANSFORM_ROLE, ANALYST_ROLE, BI_ROLE, DATA_PLATFORM_ADMIN;

-- ----------------------------------------------------------------------------
-- 11. Object privileges — LOADER_ROLE (write BRONZE only)
-- ----------------------------------------------------------------------------
GRANT CREATE TABLE ON SCHEMA BRONZE.APP TO ROLE LOADER_ROLE;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES    IN SCHEMA BRONZE.APP TO ROLE LOADER_ROLE;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON FUTURE TABLES IN SCHEMA BRONZE.APP TO ROLE LOADER_ROLE;

-- ----------------------------------------------------------------------------
-- 12. Object privileges — TRANSFORM_ROLE (read BRONZE, write SILVER + GOLD)
-- ----------------------------------------------------------------------------
GRANT SELECT ON ALL TABLES    IN SCHEMA BRONZE.APP TO ROLE TRANSFORM_ROLE;
GRANT SELECT ON FUTURE TABLES IN SCHEMA BRONZE.APP TO ROLE TRANSFORM_ROLE;

GRANT CREATE TABLE, CREATE VIEW ON SCHEMA SILVER.STAGING      TO ROLE TRANSFORM_ROLE;
GRANT CREATE TABLE, CREATE VIEW ON SCHEMA SILVER.INTERMEDIATE TO ROLE TRANSFORM_ROLE;
GRANT CREATE TABLE, CREATE VIEW ON SCHEMA GOLD.CORE           TO ROLE TRANSFORM_ROLE;
GRANT CREATE TABLE, CREATE VIEW ON SCHEMA GOLD.MART           TO ROLE TRANSFORM_ROLE;

GRANT INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES    IN SCHEMA SILVER.STAGING      TO ROLE TRANSFORM_ROLE;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON FUTURE TABLES IN SCHEMA SILVER.STAGING      TO ROLE TRANSFORM_ROLE;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES    IN SCHEMA SILVER.INTERMEDIATE TO ROLE TRANSFORM_ROLE;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON FUTURE TABLES IN SCHEMA SILVER.INTERMEDIATE TO ROLE TRANSFORM_ROLE;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES    IN SCHEMA GOLD.CORE           TO ROLE TRANSFORM_ROLE;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON FUTURE TABLES IN SCHEMA GOLD.CORE           TO ROLE TRANSFORM_ROLE;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES    IN SCHEMA GOLD.MART           TO ROLE TRANSFORM_ROLE;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON FUTURE TABLES IN SCHEMA GOLD.MART           TO ROLE TRANSFORM_ROLE;

-- ----------------------------------------------------------------------------
-- 13. Object privileges — ANALYST_ROLE / BI_ROLE (read GOLD only)
-- ----------------------------------------------------------------------------
GRANT SELECT ON ALL TABLES    IN SCHEMA GOLD.CORE TO ROLE ANALYST_ROLE, BI_ROLE;
GRANT SELECT ON FUTURE TABLES IN SCHEMA GOLD.CORE TO ROLE ANALYST_ROLE, BI_ROLE;
GRANT SELECT ON ALL TABLES    IN SCHEMA GOLD.MART TO ROLE ANALYST_ROLE, BI_ROLE;
GRANT SELECT ON FUTURE TABLES IN SCHEMA GOLD.MART TO ROLE ANALYST_ROLE, BI_ROLE;

-- ----------------------------------------------------------------------------
-- 14. DATA_PLATFORM_ADMIN — full admin over all three databases
-- ----------------------------------------------------------------------------
GRANT ALL ON DATABASE BRONZE TO ROLE DATA_PLATFORM_ADMIN;
GRANT ALL ON DATABASE SILVER TO ROLE DATA_PLATFORM_ADMIN;
GRANT ALL ON DATABASE GOLD   TO ROLE DATA_PLATFORM_ADMIN;
GRANT ALL ON ALL SCHEMAS    IN DATABASE BRONZE TO ROLE DATA_PLATFORM_ADMIN;
GRANT ALL ON ALL SCHEMAS    IN DATABASE SILVER TO ROLE DATA_PLATFORM_ADMIN;
GRANT ALL ON ALL SCHEMAS    IN DATABASE GOLD   TO ROLE DATA_PLATFORM_ADMIN;
GRANT ALL ON FUTURE SCHEMAS IN DATABASE BRONZE TO ROLE DATA_PLATFORM_ADMIN;
GRANT ALL ON FUTURE SCHEMAS IN DATABASE SILVER TO ROLE DATA_PLATFORM_ADMIN;
GRANT ALL ON FUTURE SCHEMAS IN DATABASE GOLD   TO ROLE DATA_PLATFORM_ADMIN;

-- ----------------------------------------------------------------------------
-- 15. File format, external stage, target table, and pipe (Snowpipe)
--    REPLACE BEFORE RUNNING: URL path, target table name/columns to match
--    your actual source system schema.
-- ----------------------------------------------------------------------------
CREATE FILE FORMAT IF NOT EXISTS BRONZE.APP.parquet_standard
  TYPE = 'PARQUET'
  SNAPPY_COMPRESSION = TRUE;


GRANT USAGE ON INTEGRATION s3_bronze_integration TO ROLE LOADER_ROLE;
GRANT READ, WRITE ON STAGE BRONZE.APP.s3_stage TO ROLE LOADER_ROLE;

-- Target table. Rename CUSTOMERS / columns to match <SOURCE_TABLE_NAME>.
-- Includes the declared PII columns (email, first_name, last_name) that will
-- be masked in section 17 below.


GRANT OPERATE ON PIPE BRONZE.APP.customers_pipe TO ROLE LOADER_ROLE;

-- After creation, run this and copy notification_channel (SQS ARN) into the
-- S3 bucket's Event Notifications config (see "Manual" section below):
-- SHOW PIPES IN SCHEMA BRONZE.APP;

-- ----------------------------------------------------------------------------
-- 16. Tag Taxonomy (PII + cost allocation)
-- ----------------------------------------------------------------------------
CREATE TAG IF NOT EXISTS BRONZE.APP.pii_category
  ALLOWED_VALUES 'email', 'first_name', 'last_name';

CREATE TAG IF NOT EXISTS BRONZE.APP.data_sensitivity
  ALLOWED_VALUES 'public', 'internal', 'confidential', 'restricted';

CREATE TAG IF NOT EXISTS BRONZE.APP.cost_center
  ALLOWED_VALUES 'engineering', 'marketing', 'finance', 'data-platform', 'ml';
CREATE TAG IF NOT EXISTS BRONZE.APP.environment
  ALLOWED_VALUES 'prod', 'staging', 'dev', 'sandbox';

ALTER WAREHOUSE LOADING_WH   SET TAG BRONZE.APP.cost_center = 'data-platform', BRONZE.APP.environment = 'prod';
ALTER WAREHOUSE TRANSFORM_WH SET TAG BRONZE.APP.cost_center = 'data-platform', BRONZE.APP.environment = 'prod';
ALTER WAREHOUSE ANALYTICS_WH SET TAG BRONZE.APP.cost_center = 'data-platform', BRONZE.APP.environment = 'prod';

ALTER TABLE BRONZE.APP.CUSTOMERS
  MODIFY COLUMN email      SET TAG BRONZE.APP.pii_category = 'email',      BRONZE.APP.data_sensitivity = 'restricted';
ALTER TABLE BRONZE.APP.CUSTOMERS
  MODIFY COLUMN first_name SET TAG BRONZE.APP.pii_category = 'first_name', BRONZE.APP.data_sensitivity = 'confidential';
ALTER TABLE BRONZE.APP.CUSTOMERS
  MODIFY COLUMN last_name  SET TAG BRONZE.APP.pii_category = 'last_name',  BRONZE.APP.data_sensitivity = 'confidential';

-- ----------------------------------------------------------------------------
-- 17. Masking Policies — declared PII categories: email, first_name, last_name
--     Policies and their application are idempotent (CREATE OR REPLACE is
--     safe for masking policies per idempotency-patterns.md — no state held).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE MASKING POLICY BRONZE.APP.mask_email
  AS (val STRING) RETURNS STRING ->
  CASE
    WHEN CURRENT_ROLE() IN ('DATA_PLATFORM_ADMIN', 'LOADER_ROLE', 'TRANSFORM_ROLE') THEN val
    WHEN CURRENT_ROLE() IN ('ANALYST_ROLE', 'BI_ROLE') THEN REGEXP_REPLACE(val, '^[^@]+', '****')
    ELSE '****@****.***'
  END;

CREATE OR REPLACE MASKING POLICY BRONZE.APP.mask_first_name
  AS (val STRING) RETURNS STRING ->
  CASE
    WHEN CURRENT_ROLE() IN ('DATA_PLATFORM_ADMIN', 'LOADER_ROLE', 'TRANSFORM_ROLE') THEN val
    ELSE LEFT(val, 1) || '***'
  END;

CREATE OR REPLACE MASKING POLICY BRONZE.APP.mask_last_name
  AS (val STRING) RETURNS STRING ->
  CASE
    WHEN CURRENT_ROLE() IN ('DATA_PLATFORM_ADMIN', 'LOADER_ROLE', 'TRANSFORM_ROLE') THEN val
    ELSE LEFT(val, 1) || '***'
  END;

ALTER TABLE BRONZE.APP.CUSTOMERS MODIFY COLUMN email      SET MASKING POLICY BRONZE.APP.mask_email;
ALTER TABLE BRONZE.APP.CUSTOMERS MODIFY COLUMN first_name SET MASKING POLICY BRONZE.APP.mask_first_name;
ALTER TABLE BRONZE.APP.CUSTOMERS MODIFY COLUMN last_name  SET MASKING POLICY BRONZE.APP.mask_last_name;

-- Apply the same masking policies to any downstream SILVER/GOLD table that
-- carries these columns forward, e.g.:
-- ALTER TABLE GOLD.CORE.DIM_CUSTOMERS MODIFY COLUMN email      SET MASKING POLICY BRONZE.APP.mask_email;
-- ALTER TABLE GOLD.CORE.DIM_CUSTOMERS MODIFY COLUMN first_name SET MASKING POLICY BRONZE.APP.mask_first_name;
-- ALTER TABLE GOLD.CORE.DIM_CUSTOMERS MODIFY COLUMN last_name  SET MASKING POLICY BRONZE.APP.mask_last_name;

-- Sections not emitted (explicitly not needed):
--   Row access policies -- no multi-tenancy declared
--   Shares               -- no advanced features requested


-- ============================================================================
-- ==== Manual (outside Snowflake) ====
-- ============================================================================
-- 1. AWS IAM role trust policy for the storage integration:
--    a. Run: DESC INTEGRATION s3_bronze_integration;
--    b. Copy STORAGE_AWS_IAM_USER_ARN and STORAGE_AWS_EXTERNAL_ID
--    c. Update the trust policy on the IAM role referenced by
--       <STORAGE_AWS_ROLE_ARN> to allow that IAM user to assume it, with a
--       condition on sts:ExternalId matching STORAGE_AWS_EXTERNAL_ID.
--
-- 2. S3 bucket event notification (required for Snowpipe AUTO_INGEST):
--    a. Run: SHOW PIPES IN SCHEMA BRONZE.APP;
--    b. Copy the notification_channel value (SQS queue ARN)
--    c. In the S3 bucket -> Properties -> Event notifications -> Create:
--       - Event type: s3:ObjectCreated:*
--       - Prefix: customers/  (match the stage path used in section 15)
--       - Destination: the SQS queue ARN from step (b)
--
-- 3. Distribute dbt_service's private key to your CI system (never commit
--    to source control). Generate the key pair locally and paste only the
--    public key into section 7 (<DBT_SERVICE_PUBLIC_KEY>).
--
-- 4. Configure resource monitor alert recipients in Snowsight
--    (Admin -> Notifications) or via a notification integration, and set
--    <NOTIFICATION_EMAIL> above.
-- ============================================================================


-- ============================================================================
-- VALIDATION QUERY PACK — run after each block to confirm it worked
-- ============================================================================

-- Databases / schemas created
SHOW DATABASES LIKE 'BRONZE';
SHOW DATABASES LIKE 'SILVER';
SHOW DATABASES LIKE 'GOLD';
SHOW SCHEMAS IN DATABASE BRONZE;

-- Warehouses created and sized correctly
SHOW WAREHOUSES LIKE '%_WH';

-- Resource monitors attached
SHOW RESOURCE MONITORS;
SELECT resource_monitor_name FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY LIMIT 1; -- sanity check access

-- Storage integration configured (before wiring AWS trust policy)
DESC INTEGRATION s3_bronze_integration;

-- Roles created and attached to SYSADMIN (no orphaned roles)
SHOW ROLES LIKE '%_ROLE';
SHOW GRANTS TO ROLE TRANSFORM_ROLE;

-- Pipe status (after AWS event notification is wired up)
SELECT SYSTEM$PIPE_STATUS('BRONZE.APP.CUSTOMERS_PIPE');

-- Masking verification — run as each role, confirm masked vs plaintext
-- USE ROLE ANALYST_ROLE;
-- SELECT email, first_name, last_name FROM BRONZE.APP.CUSTOMERS LIMIT 5;  -- expect masked
-- USE ROLE DATA_PLATFORM_ADMIN;
-- SELECT email, first_name, last_name FROM BRONZE.APP.CUSTOMERS LIMIT 5;  -- expect plaintext

-- Tag application
SELECT tag_database, tag_schema, tag_name, tag_value, object_database, object_schema, object_name, column_name
FROM SNOWFLAKE.ACCOUNT_USAGE.TAG_REFERENCES
WHERE tag_name = 'PII_CATEGORY'
ORDER BY object_database, object_schema, object_name, column_name;

-- Future grants present (Common RBAC Mistake 2 check)
SHOW GRANTS ON FUTURE TABLES IN SCHEMA SILVER.STAGING;
