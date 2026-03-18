---
name: schema-migration
description: Analyze DDL migrations for data loss risks — type narrowing, missing defaults, dropped constraints, breaking column changes. Use before applying schema changes to production.
---

# Schema Migration Analysis

## Requirements
**Agent:** any (read-only analysis)
**Tools used:** altimate_core_migration, altimate_core_schema_diff, schema_diff, read, glob, bash (for git operations)

## When to Use This Skill

**Use when the user wants to:**
- Analyze a DDL migration for data loss risks before applying it
- Compare two schema versions to find breaking changes
- Review ALTER TABLE / CREATE TABLE changes in a PR
- Validate that a model refactoring doesn't break the column contract

**Do NOT use for:**
- Writing new models -> use `dbt-develop`
- Analyzing downstream impact of SQL logic changes -> use `dbt-analyze`
- Optimizing queries -> use `query-optimize`

## Workflow

### 1. Get the Schema Versions

**For DDL migrations** (ALTER TABLE, CREATE TABLE):
- Read the migration file(s) from disk
- The "old" schema is the current state; the "new" schema is after applying the migration

**For dbt model changes** (comparing before/after SQL):
```bash
# Get the old version from git
git show HEAD:<path/to/model.sql> > /tmp/old_model.sql
# The new version is the current file
```

**For schema YAML changes:**
- Read both versions of the schema.yml file

### 2. Analyze DDL Migration Safety

Call `altimate_core_migration` to detect data loss risks:

```
altimate_core_migration(old_ddl: <old_ddl>, new_ddl: <new_ddl>, dialect: <dialect>)
```

This checks for:
- **Type narrowing**: VARCHAR(100) -> VARCHAR(50) (truncation risk)
- **NOT NULL without default**: Adding NOT NULL column without DEFAULT (fails on existing rows)
- **Dropped columns**: Data loss if column has values
- **Dropped constraints**: Unique/check constraints removed (data integrity risk)
- **Type changes**: INTEGER -> VARCHAR (irreversible in practice)
- **Index drops**: Performance regression risk

### 3. Diff Schema Structures

**For YAML/JSON schemas:** Call `altimate_core_schema_diff` to compare two schema definitions:

```
altimate_core_schema_diff(schema1: <old_schema>, schema2: <new_schema>)
```

Returns: added/removed/modified tables and columns, type changes, constraint changes, breaking change detection.

**For SQL model changes:** Call `schema_diff` to compare two SQL models for column-level breaking changes:

```
schema_diff(old_sql: <old_sql>, new_sql: <new_sql>, dialect: <dialect>)
```

Returns: dropped columns (BREAKING), type changes (WARNING), potential renames (Levenshtein distance matching).

### 4. Present the Analysis

```
Schema Migration Analysis
=========================

Migration: alter_orders_table.sql
Dialect: snowflake

BREAKING CHANGES (2):
  [DATA LOSS] Dropped column: orders.discount_amount
    -> Column has 1.2M non-NULL values. Data will be permanently lost.

  [TRUNCATION] Type narrowed: orders.customer_name VARCHAR(200) -> VARCHAR(50)
    -> 3,400 rows exceed 50 chars. Values will be truncated.

WARNINGS (1):
  [CONSTRAINT] Dropped unique constraint on orders.external_id
    -> Duplicates may be inserted after migration.

SAFE CHANGES (3):
  [ADD] New column: orders.updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  [ADD] New column: orders.version INTEGER DEFAULT 1
  [WIDEN] Type widened: orders.amount DECIMAL(10,2) -> DECIMAL(18,2)

Recommendation: DO NOT apply without addressing BREAKING changes.
  1. Back up discount_amount data before dropping
  2. Verify no values exceed 50 chars, or widen the target type
  3. Confirm external_id uniqueness is no longer required
```

### 5. For dbt Model Refactoring

When the user is refactoring a dbt model (renaming columns, changing types):
1. Run `schema_diff` on old vs new compiled SQL
2. Cross-reference with `dbt-analyze` to check downstream consumers
3. Flag any downstream model that references a dropped/renamed column

## Usage

- `/schema-migration migrations/V003__alter_orders.sql` -- Analyze a DDL migration file
- `/schema-migration models/staging/stg_orders.sql` -- Compare current file against last commit
- `/schema-migration --old schema_v1.yml --new schema_v2.yml` -- Compare two schema files
