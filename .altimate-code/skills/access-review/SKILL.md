---
name: access-review
description: >
  Audit Snowflake role-based access control (RBAC) -- review role hierarchies, user assignments,
  privilege grants, and identify over-permissioned roles or orphaned grants. Snowflake-specific:
  uses ACCOUNT_USAGE views for role/grant analysis. Use when the user needs a security audit,
  wants to review who has access to what, or needs to clean up Snowflake roles and permissions.
domain: governance
tools:
  - finops_role_grants
  - finops_role_hierarchy
  - finops_user_roles
  - warehouse_list
  - dbt_profiles
docs:
  - title: "Snowflake Access Control"
    url: "https://docs.snowflake.com/en/user-guide/security-access-control-overview"
    context: "Role hierarchy, privilege inheritance, system roles (ACCOUNTADMIN, SECURITYADMIN, SYSADMIN)"
---

# Access Review (Snowflake)

## Requirements
**Agent:** any (read-only analysis)
**Warehouse:** Snowflake only — the `finops_role_hierarchy`, `finops_user_roles`, and `finops_role_grants` tools query Snowflake's `ACCOUNT_USAGE` views.
**Tools used:** finops_role_hierarchy, finops_user_roles, finops_role_grants, warehouse_list, dbt_profiles

Audit Snowflake role-based access control. Reviews role hierarchies, user-to-role mappings, and privilege grants to surface security risks: over-permissioned roles, orphaned grants, excessive ACCOUNTADMIN usage, and privilege escalation paths.

## Workflow
1. **Verify Snowflake connection** -- This skill requires a Snowflake connection.
   - Call `warehouse_list` — returns configured database connections with `name`, `type`, and `database`. Confirm a connection with `type: snowflake` exists.
   - If no Snowflake connection, call `dbt_profiles` to check for a Snowflake adapter.
   - If no Snowflake connection is available, inform the user that this skill requires a Snowflake warehouse and cannot run against other databases.
2. **Pull role hierarchy** -- Call `finops_role_hierarchy` to get the full role inheritance tree
   - Map parent-child relationships between roles
   - Identify system roles (ACCOUNTADMIN, SECURITYADMIN, SYSADMIN, PUBLIC)
   - Note the depth of the hierarchy and any unusual inheritance patterns
3. **Pull user-role assignments** -- Call `finops_user_roles` to get all user-to-role mappings
   - Count users per role
   - Identify users with multiple role assignments
   - If the user specified `--user`, filter to that user's assignments
4. **Pull privilege grants** -- Call `finops_role_grants` to get all privilege grants
   - If the user specified `--role`, filter to that role's grants
   - Categorize grants by type: database, schema, table, warehouse, function
   - Note any grants that bypass the role hierarchy (direct grants to users)
5. **Analyze for security issues**:
   - **Over-permissioned roles**: Roles with ACCOUNTADMIN or SECURITYADMIN that have many users
   - **Orphaned roles**: Roles with no users assigned (dead weight in the hierarchy)
   - **Excessive direct grants**: Privileges granted directly to users instead of through roles
   - **Broad wildcard grants**: ALL PRIVILEGES on entire databases or schemas
   - **Unused roles**: Roles that exist in the hierarchy but are never used in queries
   - **Privilege escalation paths**: Roles that can grant themselves additional privileges
6. **Generate the access review report**:

```
Access Review Report
====================
Warehouse: <detected dialect>
Roles: <N> | Users: <N> | Grants: <N>

## Role Hierarchy
ACCOUNTADMIN
  SECURITYADMIN
  SYSADMIN
    ANALYTICS_ADMIN
      ANALYTICS_READER
      ANALYTICS_WRITER
    ETL_ADMIN
      ETL_RUNNER
  PUBLIC

## Security Findings

### CRITICAL
1. ACCOUNTADMIN granted to 8 users -- should be limited to 2-3 break-glass accounts
   Users: alice@co.com, bob@co.com, charlie@co.com, ...
   Recommendation: Revoke from non-essential users, use SYSADMIN for daily operations

### HIGH
2. Role TEMP_ADMIN has ALL PRIVILEGES on database PRODUCTION
   Recommendation: Scope to specific schemas or tables
3. Direct grants to user dave@co.com bypass role hierarchy
   Recommendation: Grant privileges through roles, not directly to users

### MEDIUM
4. 5 orphaned roles with no users assigned
   Roles: OLD_ANALYTICS, LEGACY_ETL, TEST_ROLE, TEMP_2023, MIGRATION_ROLE
   Recommendation: Remove or reassign these roles
5. Role ANALYTICS_READER can access PII tables without masking policy
   Recommendation: Add masking policies or restrict table access

## User-Role Matrix
| User | Roles | Last Active |
|------|-------|-------------|
| alice@co.com | ACCOUNTADMIN, SYSADMIN | 2024-01-15 |
| bob@co.com | ACCOUNTADMIN, ETL_ADMIN | 2024-01-14 |
| charlie@co.com | ANALYTICS_READER | 2024-01-15 |

## Privilege Summary
| Role | Databases | Schemas | Tables | Warehouses |
|------|-----------|---------|--------|------------|
| SYSADMIN | ALL | ALL | ALL | 3 |
| ANALYTICS_ADMIN | 2 | 5 | 47 | 1 |
| ETL_RUNNER | 1 | 3 | 12 | 2 |

## Recommendations
1. Reduce ACCOUNTADMIN membership to 2-3 break-glass accounts
2. Remove 5 orphaned roles
3. Migrate 3 direct user grants to role-based grants
4. Review ALL PRIVILEGES grants on TEMP_ADMIN role
```

## Common RBAC Issues

| Issue | Risk | Resolution |
|-------|------|------------|
| Too many ACCOUNTADMINs | CRITICAL | Limit to 2-3 break-glass accounts |
| Direct grants to users | HIGH | Always grant through roles |
| ALL PRIVILEGES on production | HIGH | Scope to specific schemas/tables |
| Orphaned roles | MEDIUM | Remove or document purpose |
| No role hierarchy | MEDIUM | Build role tree with inheritance |
| Shared service accounts | HIGH | Create per-service roles |

## Usage

- `/access-review` -- Full RBAC audit
- `/access-review --role ANALYTICS_ROLE` -- Review a specific role's grants and members
- `/access-review --user john@company.com` -- Review a specific user's role assignments

Use the tools: `finops_role_hierarchy`, `finops_user_roles`, `finops_role_grants`, `warehouse_list`, `dbt_profiles`.
