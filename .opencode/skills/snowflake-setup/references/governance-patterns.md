# Data Governance Patterns

## Dynamic Data Masking — Template Library

### Email: show domain only to analysts

```sql
CREATE MASKING POLICY <db>.<schema>.mask_email
  AS (val STRING) RETURNS STRING ->
  CASE
    WHEN CURRENT_ROLE() IN ('DATA_PLATFORM_ADMIN', 'LOADER_ROLE') THEN val
    WHEN CURRENT_ROLE() IN ('ANALYST_ROLE', 'BI_ROLE') THEN REGEXP_REPLACE(val, '^[^@]+', '****')
    ELSE '****@****.***'
  END;
```

### Phone: last 4 digits only

```sql
CREATE MASKING POLICY <db>.<schema>.mask_phone
  AS (val STRING) RETURNS STRING ->
  CASE
    WHEN CURRENT_ROLE() IN ('DATA_PLATFORM_ADMIN') THEN val
    ELSE CONCAT('***-***-', RIGHT(REGEXP_REPLACE(val, '[^0-9]', ''), 4))
  END;
```

### SSN: completely hidden except for data platform admin

```sql
CREATE MASKING POLICY <db>.<schema>.mask_ssn
  AS (val STRING) RETURNS STRING ->
  CASE
    WHEN CURRENT_ROLE() = 'DATA_PLATFORM_ADMIN' THEN val
    ELSE '***-**-****'
  END;
```

### Credit card: last 4 digits

```sql
CREATE MASKING POLICY <db>.<schema>.mask_credit_card
  AS (val STRING) RETURNS STRING ->
  CASE
    WHEN CURRENT_ROLE() = 'DATA_PLATFORM_ADMIN' THEN val
    ELSE CONCAT('****-****-****-', RIGHT(REGEXP_REPLACE(val, '[^0-9]', ''), 4))
  END;
```

### Full name: first name + last initial

```sql
CREATE MASKING POLICY <db>.<schema>.mask_full_name
  AS (val STRING) RETURNS STRING ->
  CASE
    WHEN CURRENT_ROLE() IN ('DATA_PLATFORM_ADMIN', 'LOADER_ROLE') THEN val
    ELSE CONCAT(SPLIT_PART(val, ' ', 1), ' ', LEFT(SPLIT_PART(val, ' ', 2), 1), '.')
  END;
```

### Date of birth: year only

```sql
CREATE MASKING POLICY <db>.<schema>.mask_dob
  AS (val DATE) RETURNS DATE ->
  CASE
    WHEN CURRENT_ROLE() = 'DATA_PLATFORM_ADMIN' THEN val
    ELSE DATE_FROM_PARTS(YEAR(val), 1, 1)   -- show Jan 1 of birth year
  END;
```

## Applying Masking Policies

```sql
-- Apply to a column
ALTER TABLE RAW.SALESFORCE.CONTACTS
  MODIFY COLUMN email SET MASKING POLICY mask_email;

-- Remove a masking policy
ALTER TABLE RAW.SALESFORCE.CONTACTS
  MODIFY COLUMN email UNSET MASKING POLICY;

-- View policies applied to a table
SELECT column_name, masking_policy_name
FROM INFORMATION_SCHEMA.COLUMNS c
JOIN TABLE(INFORMATION_SCHEMA.POLICY_REFERENCES(
  REF_ENTITY_NAME => 'RAW.SALESFORCE.CONTACTS',
  REF_ENTITY_DOMAIN => 'TABLE'
)) pr ON c.column_name = pr.ref_column_name;
```

## Row Access Policies

### Pattern 1 — Role-based row filtering

```sql
-- Users with DATA_PLATFORM_ADMIN see all rows; others see nothing by default
CREATE ROW ACCESS POLICY <db>.<schema>.admin_only_access
  AS (dummy_col VARCHAR) RETURNS BOOLEAN ->
  CURRENT_ROLE() = 'DATA_PLATFORM_ADMIN';
```

### Pattern 2 — User-to-data mapping table

```sql
-- Create a mapping table defining which team_id each user can see
CREATE TABLE ANALYTICS.CORE.user_data_access_map (
  user_email  VARCHAR,
  team_id     VARCHAR
);

-- Row access policy referencing the mapping table
CREATE ROW ACCESS POLICY ANALYTICS.CORE.team_access_policy
  AS (team_id VARCHAR) RETURNS BOOLEAN ->
  EXISTS (
    SELECT 1 FROM ANALYTICS.CORE.user_data_access_map m
    WHERE m.user_email = CURRENT_USER()
      AND m.team_id = team_id
  )
  OR CURRENT_ROLE() = 'DATA_PLATFORM_ADMIN';

-- Apply to table
ALTER TABLE ANALYTICS.CORE.orders
  ADD ROW ACCESS POLICY ANALYTICS.CORE.team_access_policy ON (team_id);
```

### Pattern 3 — Environment-based filtering (dev sees sample only)

```sql
CREATE ROW ACCESS POLICY ANALYTICS.CORE.env_sample_policy
  AS (created_at TIMESTAMP_LTZ) RETURNS BOOLEAN ->
  CASE
    WHEN CURRENT_ROLE() IN ('DATA_PLATFORM_ADMIN', 'TRANSFORM_ROLE') THEN TRUE
    ELSE created_at >= DATEADD('day', -90, CURRENT_TIMESTAMP())  -- analysts see last 90 days only
  END;
```

## Object Tagging for PII

```sql
-- Tag taxonomy
CREATE TAG <db>.<schema>.pii_category
  ALLOWED_VALUES 'email', 'phone', 'ssn', 'name', 'address', 'dob', 'credit_card', 'ip_address', 'device_id';

CREATE TAG <db>.<schema>.data_sensitivity
  ALLOWED_VALUES 'public', 'internal', 'confidential', 'restricted';

-- Apply at column level
ALTER TABLE RAW.SALESFORCE.CONTACTS
  MODIFY COLUMN email       SET TAG pii_category = 'email',   data_sensitivity = 'restricted';
ALTER TABLE RAW.SALESFORCE.CONTACTS
  MODIFY COLUMN phone       SET TAG pii_category = 'phone',   data_sensitivity = 'confidential';
ALTER TABLE RAW.SALESFORCE.CONTACTS
  MODIFY COLUMN first_name  SET TAG pii_category = 'name',    data_sensitivity = 'confidential';

-- Query all PII-tagged columns across account
SELECT tag_database, tag_schema, tag_name, tag_value,
       object_database, object_schema, object_name, column_name
FROM SNOWFLAKE.ACCOUNT_USAGE.TAG_REFERENCES
WHERE tag_name = 'PII_CATEGORY'
ORDER BY object_database, object_schema, object_name, column_name;
```

## Governance Validation Queries

```sql
-- Tables with no masking policies (check for PII exposure)
SELECT t.table_schema, t.table_name, t.table_type
FROM INFORMATION_SCHEMA.TABLES t
WHERE t.table_schema NOT IN ('INFORMATION_SCHEMA')
  AND t.table_name NOT IN (
    SELECT DISTINCT ref_entity_name
    FROM TABLE(INFORMATION_SCHEMA.POLICY_REFERENCES(
      REF_ENTITY_DOMAIN => 'TABLE'
    ))
  );

-- Verify masking as a role
USE ROLE ANALYST_ROLE;
SELECT email, phone, first_name FROM RAW.SALESFORCE.CONTACTS LIMIT 5;
-- Should see masked values, not plaintext

USE ROLE DATA_PLATFORM_ADMIN;
SELECT email, phone, first_name FROM RAW.SALESFORCE.CONTACTS LIMIT 5;
-- Should see plaintext

-- Policies currently in effect
SHOW MASKING POLICIES IN ACCOUNT;
SHOW ROW ACCESS POLICIES IN ACCOUNT;
```

## Governance Checklist

- [ ] PII classification run on all RAW schemas (`altimate_core_classify_pii` or `schema_detect_pii`)
- [ ] PII tag taxonomy created and applied to identified columns
- [ ] Masking policies created for each PII category (email, phone, SSN, name, DOB, credit card)
- [ ] Masking policies applied at the RAW layer (not just marts)
- [ ] Masking verified by querying as ANALYST_ROLE — confirming masked output
- [ ] Row access policies applied where multi-tenant or domain-restricted data exists
- [ ] `data_sensitivity = 'restricted'` tagged columns only accessible to DATA_PLATFORM_ADMIN
- [ ] PII inventory documented in schema.yml column descriptions (use `altimate_core_classify_pii` output)
