---
name: pii-detection
description: >
  Scan database schemas and SQL queries for personally identifiable information (PII) exposure --
  column names, data patterns, and unmasked sensitive fields. Use when the user wants a privacy audit,
  needs to find PII before a migration, or wants to verify masking policies are in place.
persona:
  - platform-engineer
  - data-engineer
domain: governance
tools:
  - schema_detect_pii
  - schema_inspect
  - schema_search
  - warehouse_list
  - dbt_profiles
  - glob
  - read
docs:
  - title: "Snowflake Dynamic Data Masking"
    url: "https://docs.snowflake.com/en/user-guide/security-column-ddm-intro"
    context: "Column-level masking policies, tagging sensitive columns"
---

# PII Detection

## Requirements
**Agent:** any (read-only analysis)
**Tools used:** schema_detect_pii, schema_inspect, schema_search, warehouse_list, dbt_profiles, glob, read

Scan database schemas for columns that contain or may contain personally identifiable information. Identifies PII by column name patterns, data type heuristics, and sample data analysis. Produces an audit report with risk levels and masking recommendations.

## Workflow
1. **Detect the warehouse dialect** -- This is the critical first step. Never assume a dialect.
   - Call `warehouse_list` — returns configured database connections, each with a `name`, `type` (e.g., `snowflake`, `bigquery`, `postgres`, `databricks`), and `database`. Use the `type` field as the dialect.
   - If no connections returned, call `dbt_profiles` to read dbt profile configuration — the adapter type indicates the warehouse.
   - If neither yields a result, ask the user which warehouse they are using.
2. **Determine scan scope** -- Based on user input:
   - Specific schema: scan only that schema (e.g., `raw.public`)
   - Specific database: scan all schemas in that database
   - Full warehouse: scan all accessible schemas
   - SQL file: scan column references in the query for PII exposure
   - If the user provides a file path, use `read` to get the SQL and analyze column names
3. **Run PII detection** -- Call `schema_detect_pii` with the warehouse connection and scan scope
   - The tool scans column names and metadata for PII patterns
   - Returns flagged columns with PII type classification and confidence scores
4. **Inspect flagged columns** -- For each column flagged as potential PII:
   - Call `schema_inspect` on the parent table to get full column metadata (type, nullable, comment)
   - Check if the column has masking policies or tags already applied
   - Verify the PII classification makes sense given the column type and context
5. **Search for related exposure** -- Use `schema_search` to find other columns with similar names
   - If `email` is flagged in one table, search for `email`, `e_mail`, `email_address` across all schemas
   - This catches PII that may have propagated to downstream tables without masking
6. **Generate the PII audit report**:

```
PII Audit Report
================
Warehouse: <detected dialect>
Scope: <schema / database / warehouse>
Columns scanned: <N> | PII flagged: <N> | Risk: HIGH / MEDIUM / LOW

## Summary by PII Type
| PII Type | Columns Found | Risk Level | Masking Status |
|----------|--------------|------------|----------------|
| Email | 5 | HIGH | 2 masked, 3 unmasked |
| Phone | 3 | HIGH | 0 masked |
| Name | 8 | MEDIUM | 4 masked, 4 unmasked |
| Address | 2 | MEDIUM | 0 masked |
| SSN/ID | 1 | CRITICAL | 0 masked |
| IP Address | 2 | LOW | 0 masked |

## Detailed Findings

### CRITICAL Risk

#### raw.public.customers.ssn
- PII Type: SSN/National ID
- Data Type: VARCHAR(11)
- Masking: NONE
- Recommendation: Apply full masking policy immediately. This column should never be exposed in plain text.

### HIGH Risk

#### raw.public.customers.email
- PII Type: Email Address
- Data Type: VARCHAR(255)
- Masking: NONE
- Recommendation: Apply email masking (show domain only: ***@company.com)

#### analytics.public.user_events.ip_address
- PII Type: IP Address
- Data Type: VARCHAR(45)
- Masking: NONE
- Recommendation: Apply partial masking or hash for analytics use

## Cross-Schema Exposure
The following PII columns appear in multiple schemas (potential propagation without masking):
- `email`: raw.customers, staging.stg_customers, marts.dim_customers
- `phone`: raw.customers, staging.stg_customers

## Recommendations
1. Apply masking policies to all CRITICAL and HIGH risk columns
2. Add column tags for PII classification (e.g., SEMANTIC_CATEGORY = 'EMAIL')
3. Audit downstream models that reference flagged source columns
4. Set up automated PII scanning in CI to catch new exposure
```

## PII Classification Reference

| PII Type | Column Name Patterns | Risk Level |
|----------|---------------------|------------|
| SSN / National ID | ssn, social_security, national_id, sin_number | CRITICAL |
| Credit Card | credit_card, cc_number, card_number, pan | CRITICAL |
| Email | email, e_mail, email_address, user_email | HIGH |
| Phone | phone, telephone, mobile, cell_number | HIGH |
| Full Name | full_name, first_name + last_name, customer_name | MEDIUM |
| Address | address, street, city + state + zip, postal_code | MEDIUM |
| Date of Birth | dob, date_of_birth, birth_date, birthday | MEDIUM |
| IP Address | ip_address, ip, client_ip, source_ip | LOW |
| Device ID | device_id, imei, mac_address | LOW |

## Usage

- `/pii-detection` -- Scan all accessible schemas
- `/pii-detection raw.public` -- Scan a specific schema
- `/pii-detection --database analytics` -- Scan all schemas in a database
- `/pii-detection models/staging/stg_customers.sql` -- Check a SQL file for PII column references

Use the tools: `schema_detect_pii`, `schema_inspect`, `schema_search`, `warehouse_list`, `dbt_profiles`, `glob`, `read`.
