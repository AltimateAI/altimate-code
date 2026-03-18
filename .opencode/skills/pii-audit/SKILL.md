---
name: pii-audit
description: Classify schema columns for PII (SSN, email, phone, name, address, credit card) and check whether queries expose them. Use for GDPR/CCPA/HIPAA compliance audits.
---

# PII Audit

## Requirements
**Agent:** any (read-only analysis)
**Tools used:** altimate_core_classify_pii, altimate_core_query_pii, schema_detect_pii, schema_inspect, read, glob

## When to Use This Skill

**Use when the user wants to:**
- Scan a database schema for PII columns (SSN, email, phone, name, address, credit card, IP)
- Check if a specific query exposes PII data
- Audit dbt models for PII leakage before production deployment
- Generate a PII inventory for compliance (GDPR, CCPA, HIPAA)

**Do NOT use for:**
- SQL injection scanning -> use `sql-review`
- General SQL quality checks -> use `sql-review`
- Access control auditing -> finops role tools in `cost-report`

## Workflow

### 1. Classify Schema for PII

**Option A — From schema YAML/JSON:**

```
altimate_core_classify_pii(schema_context: <schema_object>)
```

Analyzes column names, types, and patterns to detect PII categories:
- **Direct identifiers**: SSN, email, phone, full name, credit card number
- **Quasi-identifiers**: Date of birth, zip code, IP address, device ID
- **Sensitive data**: Salary, health records, religious affiliation

**Option B — From warehouse connection:**

First index the schema, inspect it, then classify:
```
schema_index(warehouse: <name>)
schema_inspect(warehouse: <name>, database: <db>, schema: <schema>, table: <table>)
schema_detect_pii(warehouse: <name>)
```

`schema_detect_pii` scans all indexed columns using pattern matching against the schema cache (requires `schema_index` to have been run).

### 2. Check Query PII Exposure

For each query or dbt model, check which PII columns it accesses:

```
altimate_core_query_pii(sql: <sql>, schema_context: <schema_object>)
```

Returns:
- Which PII-classified columns are selected, filtered, or joined on
- Risk level per column (HIGH for direct identifiers, MEDIUM for quasi-identifiers)
- Whether PII is exposed in the output (SELECT) vs only used internally (WHERE/JOIN)

### 3. Audit dbt Models (Batch)

For a full project audit:
```bash
glob models/**/*.sql
```

For each model:
1. Read the compiled SQL
2. Run `altimate_core_query_pii` against the project schema
3. Classify the model's PII risk level

### 4. Present the Audit Report

```
PII Audit Report
================

Schema: analytics.public (42 tables, 380 columns)

PII Columns Found: 18

HIGH RISK (direct identifiers):
  customers.email          -> EMAIL
  customers.phone_number   -> PHONE
  customers.ssn            -> SSN
  payments.card_number     -> CREDIT_CARD

MEDIUM RISK (quasi-identifiers):
  customers.date_of_birth  -> DOB
  customers.zip_code       -> ZIP
  events.ip_address        -> IP_ADDRESS

Model PII Exposure:

| Model | PII Columns Exposed | Risk | Action |
|-------|-------------------|------|--------|
| stg_customers | email, phone, ssn | HIGH | Mask or hash before mart layer |
| mart_user_profile | email | HIGH | Requires access control |
| int_order_summary | (none) | SAFE | No PII in output |
| mart_daily_revenue | zip_code | MEDIUM | Aggregation reduces risk |

Recommendations:
1. Hash SSN and credit_card in staging layer (never expose raw)
2. Add column-level masking policy for email and phone
3. Restrict mart_user_profile to authorized roles only
4. Document PII handling in schema.yml column descriptions
```

## Usage

- `/pii-audit` -- Scan the full project schema for PII
- `/pii-audit models/marts/mart_customers.sql` -- Check a specific model for PII exposure
- `/pii-audit --schema analytics.public` -- Audit a specific database schema
