# Schema Tools

## schema_inspect

Get column details for any table.

```
> schema_inspect orders --warehouse prod-snowflake

Table: ANALYTICS.PUBLIC.ORDERS

┌──────────────┬──────────────┬──────────┬─────────────┐
│ Column       │ Type         │ Nullable │ Primary Key │
├──────────────┼──────────────┼──────────┼─────────────┤
│ order_id     │ NUMBER(38,0) │ NO       │ YES         │
│ customer_id  │ NUMBER(38,0) │ NO       │ NO          │
│ order_date   │ TIMESTAMP_NTZ│ NO       │ NO          │
│ amount       │ DECIMAL(12,2)│ YES      │ NO          │
│ status       │ VARCHAR(50)  │ YES      │ NO          │
│ _loaded_at   │ TIMESTAMP_NTZ│ NO       │ NO          │
└──────────────┴──────────────┴──────────┴─────────────┘
6 columns
```

**Parameters:**
- `table` (required): Table name (schema-qualified: `schema.table` or just `table`)
- `schema_name` (optional): Schema to search in
- `warehouse` (optional): Connection name

---

## schema_index

Index your warehouse metadata into a local SQLite cache for fast searching.

```
> schema_index prod-snowflake

Indexing ANALYTICS warehouse...
  Schemas indexed: 12
  Tables indexed: 847
  Columns indexed: 15,293

Cache saved to ~/.altimate/cache/prod-snowflake.db
```

Run this once per warehouse (or periodically to refresh). Enables `schema_search` and powers schema-aware autocomplete.

---

## schema_search

Search indexed metadata by keyword to find tables, columns, and schemas.

```
> schema_search "revenue" --warehouse prod-snowflake

Tables:
  1. ANALYTICS.MARTS.FCT_REVENUE (42 columns), "Monthly revenue fact table"
  2. ANALYTICS.STAGING.STG_REVENUE_EVENTS (18 columns)

Columns:
  1. ANALYTICS.MARTS.FCT_ORDERS.total_revenue (DECIMAL)
  2. ANALYTICS.MARTS.DIM_PRODUCTS.revenue_category (VARCHAR)
  3. ANALYTICS.RAW.STRIPE_CHARGES.revenue_amount (FLOAT)
```

**Parameters:**
- `query` (required): Search term
- `warehouse` (optional): Limit to one connection
- `limit` (optional): Max results

---

## schema_cache_status

Check cache freshness across all warehouses.

```
> schema_cache_status

┌─────────────────┬──────────┬────────┬─────────┬─────────────────────┐
│ Warehouse       │ Schemas  │ Tables │ Columns │ Last Indexed        │
├─────────────────┼──────────┼────────┼─────────┼─────────────────────┤
│ prod-snowflake  │ 12       │ 847    │ 15,293  │ 2026-02-26 14:30:00 │
│ dev-duckdb      │ 2        │ 23     │ 156     │ 2026-02-25 09:15:00 │
│ bigquery-prod   │ n/a      │ n/a    │ n/a     │ Never               │
└─────────────────┴──────────┴────────┴─────────┴─────────────────────┘
```

---

## schema_detect_pii

Scan columns for potential PII (personally identifiable information).

```
> schema_detect_pii --warehouse prod-snowflake --schema PUBLIC

PII Findings:

  ⚠ ANALYTICS.PUBLIC.USERS.email (VARCHAR)
    Category: EMAIL_ADDRESS
    Confidence: high
    Recommendation: Apply masking policy

  ⚠ ANALYTICS.PUBLIC.USERS.phone_number (VARCHAR)
    Category: PHONE_NUMBER
    Confidence: high

  ⚠ ANALYTICS.PUBLIC.USERS.ip_address (VARCHAR)
    Category: IP_ADDRESS
    Confidence: medium

  ⚠ ANALYTICS.PUBLIC.ORDERS.shipping_address (VARCHAR)
    Category: PHYSICAL_ADDRESS
    Confidence: medium

4 potential PII columns found in PUBLIC schema
```

**Detection categories:** email, phone, SSN, credit card, IP address, physical address, date of birth, name patterns

---

## schema_tags

Read metadata tags on warehouse objects (Snowflake object tagging, BigQuery labels).

```
> schema_tags --warehouse prod-snowflake --object_name USERS

Tags on ANALYTICS.PUBLIC.USERS:
  data_classification: CONFIDENTIAL
  pii_level: HIGH
  owner_team: platform
  retention_days: 365
```

---

## schema_diff

Compare schema changes between two SQL versions to understand migration impact.

```
> schema_diff \
    --old_sql "CREATE TABLE orders (id INT, amount FLOAT, status TEXT)" \
    --new_sql "CREATE TABLE orders (id INT, amount DECIMAL(12,2), status TEXT, created_at TIMESTAMP)"

Schema Changes:
  ~ Modified: amount (FLOAT → DECIMAL(12,2)), severity: medium
  + Added: created_at (TIMESTAMP), severity: low

Impact: Type change on 'amount' may affect downstream consumers expecting FLOAT
```
