# RBAC Patterns

## Functional Role vs. Access Role Distinction

Snowflake's best practice splits roles into two layers:

- **Functional roles** — named for what someone *does* (ANALYST_ROLE, LOADER_ROLE, TRANSFORM_ROLE). These are what users and service accounts are granted.
- **Access roles** — named for what data they *touch* (SALESFORCE_READ, ANALYTICS_WRITE). Functional roles are granted to access roles, not directly to objects.

For small teams (< 10 people), the two-layer model is overkill — use functional roles directly and grant object privileges to them.

## Reference RBAC Topology (small team)

```
ACCOUNTADMIN
  └─ SYSADMIN
       ├─ DATA_PLATFORM_ADMIN
       │    └─ (all databases and warehouses, admin-level)
       ├─ TRANSFORM_ROLE
       │    ├─ READ: RAW.*
       │    ├─ WRITE: TRANSFORM.*
       │    ├─ WRITE: ANALYTICS.*
       │    └─ OPERATE: TRANSFORM_WH
       ├─ LOADER_ROLE
       │    ├─ WRITE: RAW.*
       │    └─ OPERATE: LOADING_WH
       ├─ ANALYST_ROLE
       │    ├─ READ: ANALYTICS.*
       │    └─ OPERATE: ANALYTICS_WH
       └─ BI_ROLE
            ├─ READ: ANALYTICS.*
            └─ OPERATE: ANALYTICS_WH
```

## Reference RBAC Topology (larger team with access roles)

```
ACCOUNTADMIN
  └─ SYSADMIN
       ├─ DATA_PLATFORM_ADMIN
       ├─ TRANSFORM_ROLE
       │    └─ granted: RAW_READ, ANALYTICS_WRITE, TRANSFORM_WRITE
       ├─ ANALYST_ROLE
       │    └─ granted: ANALYTICS_FINANCE_READ, ANALYTICS_CORE_READ
       ├─ FINANCE_ANALYST_ROLE
       │    └─ granted: ANALYTICS_FINANCE_READ (restricted domain)
       └─ ...

Access roles (object-scoped):
  RAW_READ           → SELECT on RAW.*
  ANALYTICS_CORE_READ → SELECT on ANALYTICS.CORE.*
  ANALYTICS_FINANCE_READ → SELECT on ANALYTICS.FINANCE.*
```

## GRANT emission rule — CRITICAL

**Always emit one target role per GRANT statement. Never comma-separate roles.**

```sql
-- CORRECT — one role per statement
GRANT USAGE ON DATABASE BRONZE TO ROLE DATA_PLATFORM_ADMIN;
GRANT USAGE ON DATABASE BRONZE TO ROLE LOADER_ROLE;
GRANT USAGE ON DATABASE BRONZE TO ROLE TRANSFORM_ROLE;

-- WRONG — DO NOT EMIT THIS FORM
GRANT USAGE ON DATABASE BRONZE TO ROLE DATA_PLATFORM_ADMIN, LOADER_ROLE, TRANSFORM_ROLE;
```

Why: Snowflake's grammar allows the comma-separated form syntactically, but the `snowflake-sdk` driver silently swallows it — the query returns `(0 rows)` with no error, and none of the listed roles actually receive the grant. Verified on live account `DKZPOBS-TQ14188` on 2026-08-25 via follow-up `SHOW GRANTS TO ROLE` queries. Until the driver bug is fixed, always emit one GRANT per role.

The same rule applies to `REVOKE` — one role per statement.

## Privilege Reference

### Database and schema
```sql
GRANT USAGE ON DATABASE <db> TO ROLE <role>;
GRANT USAGE ON SCHEMA <db>.<schema> TO ROLE <role>;

-- Read access on existing + future tables
GRANT SELECT ON ALL TABLES IN SCHEMA <db>.<schema> TO ROLE <role>;
GRANT SELECT ON FUTURE TABLES IN SCHEMA <db>.<schema> TO ROLE <role>;

-- Write access (for dbt / loaders)
GRANT CREATE TABLE ON SCHEMA <db>.<schema> TO ROLE <role>;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA <db>.<schema> TO ROLE <role>;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON FUTURE TABLES IN SCHEMA <db>.<schema> TO ROLE <role>;
```

### Warehouse
```sql
-- Run queries (required for all roles that execute SQL)
GRANT USAGE ON WAREHOUSE <wh> TO ROLE <role>;

-- Resume/suspend the warehouse (data platform admin)
GRANT OPERATE ON WAREHOUSE <wh> TO ROLE <role>;

-- Modify warehouse settings (SYSADMIN+ only, rarely needed for functional roles)
GRANT MODIFY ON WAREHOUSE <wh> TO ROLE <role>;
```

### Stages and pipes (for loader role)
```sql
GRANT USAGE ON INTEGRATION <integration> TO ROLE LOADER_ROLE;
GRANT READ ON STAGE <db>.<schema>.<stage> TO ROLE LOADER_ROLE;
GRANT WRITE ON STAGE <db>.<schema>.<stage> TO ROLE LOADER_ROLE;
GRANT OPERATE ON PIPE <db>.<schema>.<pipe> TO ROLE LOADER_ROLE;
```

## Validation Queries

```sql
-- What privileges does a role have?
SHOW GRANTS TO ROLE ANALYST_ROLE;

-- What roles does a user have?
SHOW GRANTS TO USER jane_doe;

-- Who has access to a specific table?
SHOW GRANTS ON TABLE ANALYTICS.CORE.orders;

-- Full role hierarchy (use finops_role_hierarchy tool for a visual view)
SELECT * FROM SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_ROLES
WHERE GRANTED_ON = 'DATABASE'
ORDER BY CREATED_ON DESC;
```

## Common RBAC Mistakes

### Mistake 1: Orphaned custom roles
**Symptom:** SYSADMIN can't manage objects owned by a custom role.
**Fix:** `GRANT ROLE <custom_role> TO ROLE SYSADMIN;` for every custom role.

### Mistake 2: Missing future grants
**Symptom:** Analyst can query existing tables but not new ones created this week.
**Fix:** `GRANT SELECT ON FUTURE TABLES IN SCHEMA ... TO ROLE ANALYST_ROLE;` — run for every schema.

### Mistake 3: DEFAULT_ROLE = ACCOUNTADMIN
**Symptom:** Every user session opens as ACCOUNTADMIN.
**Fix:** Set `DEFAULT_ROLE` to the least-privilege role the user needs for daily work.

### Mistake 4: Granting SYSADMIN to dbt
**Symptom:** dbt service account can create and drop databases.
**Fix:** Create TRANSFORM_ROLE with USAGE + CREATE TABLE on specific schemas only.

### Mistake 5: No role separation for CI vs. production
**Symptom:** A CI pipeline bug drops prod tables.
**Fix:** Separate service accounts with separate roles: `DBT_CI_ROLE` (DEV databases only) and `DBT_PROD_ROLE` (prod databases only).
