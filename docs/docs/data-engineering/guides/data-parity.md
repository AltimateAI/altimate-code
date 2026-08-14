---
title: "Data Parity (Table Diff) — Altimate Code"
description: "Validate table equivalence across databases for migrations, ETL refactors, and data quality checks with Altimate Code."
---

# Data Parity (Table Diff)

Validate that two tables — or two query results — are identical across databases, or diagnose exactly how they differ. Use for **migration validation**, **ETL regression**, and **query refactor verification**.

altimate-code ships a dedicated `data_diff` tool and a `data-parity` skill that orchestrates the full workflow: plan, inspect schema, confirm keys, profile, then diff.

## Supported warehouse pairs

Works across any combination of:

- PostgreSQL
- Snowflake
- BigQuery
- Databricks (SQL Warehouses)
- ClickHouse
- MySQL
- Redshift
- SQL Server
- Microsoft Fabric
- DuckDB
- SQLite
- Oracle

Same-dialect comparisons use a fast FULL OUTER JOIN. Cross-database comparisons use a bisection hashing algorithm that streams checksums rather than raw rows — so you can diff a 100M-row Postgres table against its Snowflake replica without pulling the data out.

## Quick start

```bash
altimate
```

In the TUI, just describe what you want to compare:

```
Compare orders in postgres_prod with orders in snowflake_dw using id as the primary key.
```

The agent will:

1. List your warehouse connections.
2. Inspect both schemas, propose primary keys, and flag audit/timestamp columns to exclude.
3. Confirm your choices.
4. Run a column profile first (cheap — no row scan).
5. Run the row-level diff only on columns that diverged.

## Algorithms

| Algorithm | When to use | Cost |
|-----------|-------------|------|
| `auto` | Default. Picks JoinDiff for same-dialect, HashDiff for cross-database. | Cheapest valid choice |
| `joindiff` | Same-database comparison. Fast. | One FULL OUTER JOIN |
| `hashdiff` | Cross-database. Works at any scale. | Bisection over checksums |
| `profile` | Compliance-safe. Column stats only — no row values leave the database. | Cheapest |
| `cascade` | Profile first, then HashDiff on columns that diverged. Balanced default for exploratory diffs. | Column stats + targeted row diff |

## Partitioning large tables

For tables beyond ~10M rows, partition the diff into independent batches:

```text
Compare orders between postgres and snowflake, partitioned by order_date month.
```

Three partition modes:

| Mode | How to trigger | Example |
|------|----------------|---------|
| **Date** | Set `partition_column` + `partition_granularity` | `l_shipdate` + `month` |
| **Numeric** | Set `partition_column` + `partition_bucket_size` | `l_orderkey` + `100000` |
| **Categorical** | Set `partition_column` alone (no granularity/bucket) | `region`, `status`, `country` |

Each partition is diffed independently. Results are aggregated with a per-partition breakdown so you can see *which* groups have differences.

## SQL Server and Microsoft Fabric

Both `sqlserver` and `fabric` are supported. For Azure AD / Entra ID authentication, altimate-code recognizes all of the major flows through `tedious`:

| `authentication` | Config fields | Use case |
|------------------|---------------|----------|
| `azure-active-directory-password` | `azure_client_id`, `azure_tenant_id`, `user`, `password` | User credentials |
| `azure-active-directory-access-token` (or `access-token`) | `access_token` | Pre-fetched token |
| `service-principal-secret` (`service-principal`) | `azure_tenant_id`, `azure_client_id`, `azure_client_secret` | Service principals |
| `azure-active-directory-msi-vm` (`msi`) | `azure_client_id` (optional) | Azure VM managed identity |
| `azure-active-directory-msi-app-service` | `azure_client_id` (optional) | App Service managed identity |
| `azure-active-directory-default` (`default` / `CLI`) | — | DefaultAzureCredential chain (CLI, env, MSI) |

All Azure AD connections force TLS encryption.

## Compliance and sensitive data

!!! warning "PII / PHI / PCI data"
    `data_diff` prints up to 5 sample diff rows in tool output. Those rows become part of the conversation and are sent to your LLM provider.

    When comparing tables that might contain regulated data:

    - Start with `algorithm: "profile"` — column-level statistics only, no row values leave the database.
    - If a row-level diff is genuinely required, scope it with a `where_clause` that excludes sensitive customers / accounts.
    - The `data-parity` skill asks for confirmation before sending sample rows to the LLM when the table name matches common regulated patterns (`customers`, `patients`, `orders`, `payments`, `accounts`, `users`).

## Column auto-discovery and audit exclusion

When you omit `extra_columns` and the source is a plain table name, altimate-code:

1. Queries `information_schema` (or the dialect-specific equivalent) on both sides.
2. Excludes audit/timestamp columns by name pattern (`updated_at`, `created_at`, `_fivetran_synced`, `_airbyte_emitted_at`, etc.).
3. Queries column defaults and excludes anything with an auto-generating timestamp default (`NOW()`, `CURRENT_TIMESTAMP`, `GETDATE()`, `SYSDATE`, `SYSTIMESTAMP`).
4. Reports excluded columns so you can override if the timestamps are part of what you're validating.

When the source is a SQL query, only the key columns are compared unless you explicitly list `extra_columns`. Always provide `extra_columns` for query-mode comparisons.

## The `data_diff` tool

Direct tool invocation (if you prefer not to use the skill):

```
data_diff(
  source = "orders",
  target = "orders",
  source_warehouse = "postgres_prod",
  target_warehouse = "snowflake_dw",
  key_columns = ["id"],
  algorithm = "auto",
)
```

See the [tool reference](../tools/warehouse-tools.md) for the full parameter list.
