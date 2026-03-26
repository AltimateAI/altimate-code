# Database Driver Support

## Overview

Altimate Code connects to 11 databases natively via TypeScript drivers. No Python dependency required. Drivers are loaded lazily, so only the driver you need is imported at runtime.

## Support Matrix

| Database | Package | Auth Methods | E2E Tested | Notes |
|----------|---------|-------------|------------|-------|
| PostgreSQL | `pg` | Password, Connection String, SSL | ✅ Docker | Stable, fully parameterized queries |
| DuckDB | `duckdb` | File/Memory (no auth) | ✅ In-memory | Default local database |
| SQLite | `bun:sqlite` (built-in) | File (no auth) | ✅ File-based | Zero-install, built into runtime |
| MySQL | `mysql2` | Password | ✅ Docker | Parameterized introspection |
| SQL Server | `mssql` | Password, Azure AD | ✅ Docker | Uses `tedious` TDS protocol |
| Redshift | `pg` (wire-compat) | Password | ✅ Docker (PG wire) | Uses SVV system views |
| Snowflake | `snowflake-sdk` | Password, Key-Pair (unencrypted + encrypted), OAuth | ✅ Live account | 37 E2E tests, key-pair with passphrase support |
| BigQuery | `@google-cloud/bigquery` | Service Account, ADC | ✅ Live account | 25 E2E tests, UNNEST/STRUCT/DATE types |
| Databricks | `@databricks/sql` | PAT, OAuth | ✅ Live account | 24 E2E tests, Unity Catalog support |
| MongoDB | `mongodb` | Password, Connection String | ✅ Docker | 90 E2E tests, MQL queries, aggregation pipelines |
| Oracle | `oracledb` (thin) | Password | ❌ Needs Oracle 12.1+ | Thin mode only, no Instant Client |

## Installation

Drivers are `optionalDependencies`, so install only what you need:

```bash
# Embedded databases (no external service needed)
bun add duckdb
# SQLite uses bun:sqlite (built-in, no install needed)

# Standard databases
bun add pg                        # PostgreSQL + Redshift
bun add mysql2                    # MySQL
bun add mssql                     # SQL Server

# Document databases
bun add mongodb                   # MongoDB

# Cloud warehouses
bun add snowflake-sdk             # Snowflake
bun add @google-cloud/bigquery    # BigQuery
bun add @databricks/sql           # Databricks
bun add oracledb                  # Oracle (thin mode)
```

## Connection Configuration

### Via `~/.altimate-code/connections.json`

```json
{
  "my-postgres": {
    "type": "postgres",
    "host": "localhost",
    "port": 5432,
    "database": "analytics",
    "user": "analyst",
    "password": "secret"
  },
  "my-snowflake": {
    "type": "snowflake",
    "account": "xy12345.us-east-1",
    "user": "dbt_user",
    "private_key_path": "~/.ssh/snowflake_key.p8",
    "warehouse": "COMPUTE_WH",
    "database": "ANALYTICS"
  },
  "local-duckdb": {
    "type": "duckdb",
    "path": "./analytics.duckdb"
  }
}
```

### Via Environment Variables

```bash
export ALTIMATE_CODE_CONN_MYDB='{"type":"postgres","host":"localhost","port":5432,"database":"mydb","user":"admin","password":"secret"}'
```

### Via dbt Profiles (Recommended for dbt Users)

**dbt-first execution**: When working in a dbt project, `sql.execute` automatically uses dbt's own adapter to connect via `profiles.yml`, so no separate connection configuration is needed. If dbt is not configured or fails, it falls back to native drivers silently.

Connections are also auto-discovered from `~/.dbt/profiles.yml` for the `warehouse.list` and `warehouse.discover` tools. Jinja `{{ env_var() }}` patterns are resolved automatically. Discovered connections are named `dbt_{profile}_{target}`.

To set up dbt integration:
```bash
altimate-dbt init --project-root /path/to/dbt/project --python-path $(which python3)
```

## Auth Methods by Database

### PostgreSQL / Redshift
| Method | Config Fields |
|--------|--------------|
| Password | `host`, `port`, `database`, `user`, `password` |
| Connection String | `connection_string: "postgresql://user:pass@host:port/db"` |
| SSL | Add `ssl: true` or `ssl: { rejectUnauthorized: false }` |

### Snowflake
| Method | Config Fields |
|--------|--------------|
| Password | `account`, `user`, `password`, `warehouse`, `database` |
| Key-Pair | `account`, `user`, `private_key_path`, `private_key_passphrase?`, `warehouse`, `database` |
| OAuth | `account`, `user`, `authenticator: "oauth"`, `token` |

### BigQuery
| Method | Config Fields |
|--------|--------------|
| Service Account | `project`, `credentials_path` (path to JSON key file) |
| ADC | `project` (uses Application Default Credentials) |

### Databricks
| Method | Config Fields |
|--------|--------------|
| PAT | `server_hostname`, `http_path`, `access_token` |

### MySQL
| Method | Config Fields |
|--------|--------------|
| Password | `host`, `port`, `database`, `user`, `password` |

### SQL Server
| Method | Config Fields |
|--------|--------------|
| Password | `host`, `port`, `database`, `user`, `password` |
| Azure AD | `host`, `database`, `authentication: { type: "azure-active-directory-default" }` |

### Oracle (thin mode)
| Method | Config Fields |
|--------|--------------|
| Password | `host`, `port`, `service_name`, `user`, `password` |

### MongoDB
| Method | Config Fields |
|--------|--------------|
| Password | `host`, `port`, `database`, `user`, `password` |
| Connection String | `connection_string: "mongodb://user:pass@host:port/db"` |

MongoDB supports server versions 3.6 through 8.0. Queries use MQL (MongoDB Query Language) via JSON, not SQL. The driver supports `find`, `aggregate`, CRUD operations, index management, and schema introspection via document sampling.

### DuckDB
| Method | Config Fields |
|--------|--------------|
| In-memory | `path: ":memory:"` |
| File | `path: "./my-database.duckdb"` |

### SQLite
| Method | Config Fields |
|--------|--------------|
| File | `path: "./my-database.sqlite"` |

## SSH Tunneling

Connect through a bastion host by adding SSH config to any connection:

```json
{
  "type": "postgres",
  "host": "db.internal.company.com",
  "port": 5432,
  "database": "prod",
  "user": "analyst",
  "ssh_host": "bastion.company.com",
  "ssh_port": 22,
  "ssh_user": "admin",
  "ssh_auth_type": "key",
  "ssh_key_path": "~/.ssh/id_rsa"
}
```

SSH auth types: `"key"` (default) or `"password"` (set `ssh_password`).

> **Note:** SSH tunneling cannot be used with `connection_string`. Use explicit `host`/`port` instead.

## Auto-Discovery

The CLI auto-discovers connections from:

1. **Docker containers**: detects running PostgreSQL, MySQL, MariaDB, SQL Server, Oracle, MongoDB containers
2. **dbt profiles**: parses `~/.dbt/profiles.yml` for all supported adapters
3. **Environment variables**: detects `SNOWFLAKE_ACCOUNT`, `PGHOST`, `MYSQL_HOST`, `MSSQL_HOST`, `ORACLE_HOST`, `DUCKDB_PATH`, `SQLITE_PATH`, etc.

Use the `warehouse_discover` tool or run project scan to find available connections.

## What's Not Yet E2E Tested

These features work based on SDK documentation but haven't been verified with automated E2E tests:

### Snowflake (partially tested, 37 E2E tests pass)
- ✅ Password authentication
- ✅ Key-pair with unencrypted PEM
- ✅ Key-pair with encrypted PEM + passphrase
- ✅ Schema introspection (SHOW SCHEMAS/TABLES/DESCRIBE)
- ✅ DDL/DML (CREATE, INSERT, UPDATE, DELETE, DROP)
- ✅ Snowflake types (VARIANT, ARRAY, OBJECT, BOOLEAN, DATE)
- ✅ Adversarial SQL injection blocked (multi-statement protection)
- ❌ OAuth/external browser auth (requires interactive browser)
- ❌ Multi-cluster warehouse auto-scaling

### BigQuery (partially tested, 25 E2E tests pass)
- ✅ Service Account JSON key authentication
- ✅ Schema introspection (datasets, tables, columns)
- ✅ BigQuery types (UNNEST, STRUCT, DATE/DATETIME/TIMESTAMP, STRING_AGG)
- ✅ Adversarial inputs (injection blocked, invalid SQL)
- ❌ Application Default Credentials (ADC)
- ❌ Location-specific query execution
- ❌ Dry run / cost estimation

### Databricks (partially tested, 24 E2E tests pass)
- ✅ Personal Access Token (PAT) authentication
- ✅ Unity Catalog (SHOW CATALOGS, SHOW SCHEMAS)
- ✅ Schema introspection (listSchemas, listTables, describeTable)
- ✅ DDL (CREATE TEMPORARY VIEW)
- ✅ Adversarial inputs (injection blocked, invalid SQL)
- ❌ OAuth M2M authentication
- ❌ Cluster auto-start behavior

### Oracle
- Thick mode (requires Oracle Instant Client)
- Wallet-based authentication
- TNS connection strings

### General
- SSH tunnel with password authentication
- SSH tunnel with passphrase-protected keys
- Credential store with keytar (OS keychain)

---

## Architecture

### How SQL Execution Works

```
User calls sql.execute("SELECT * FROM orders")
        │
        ▼
   ┌─────────────────────────┐
   │  1. dbt adapter (first) │ ← Uses profiles.yml, no separate config
   │     If dbt configured   │
   └──────────┬──────────────┘
              │ (fails or not configured)
              ▼
   ┌─────────────────────────┐
   │  2. Native driver       │ ← Uses connections.json or env vars
   │     pg / snowflake-sdk  │
   │     / mysql2 / etc.     │
   └──────────┬──────────────┘
              │ (no connection configured)
              ▼
   ┌─────────────────────────┐
   │  3. Error               │ ← Clear message with setup instructions
   └─────────────────────────┘
```

### Dispatcher Pattern

All 73 tool methods route through a central `Dispatcher` that maps method names to native TypeScript handlers. There is no Python bridge; every call executes in-process.

### Shared Driver Package

Database drivers live in `packages/drivers/` (`@altimateai/drivers`), a workspace package shared across the monorepo. Each driver:
- Lazy-loads its npm package via dynamic `import()` (no startup cost)
- Uses parameterized queries for schema introspection (SQL injection safe)
- Implements a common `Connector` interface: `connect()`, `execute()`, `listSchemas()`, `listTables()`, `describeTable()`, `close()`

## Credential Security

Credentials are handled with a 3-tier fallback:

1. **OS Keychain** (via `keytar`): preferred and secure. Credentials stored in macOS Keychain, Linux Secret Service, or Windows Credential Vault.
2. **Environment variables** (`ALTIMATE_CODE_CONN_*`): for CI/headless environments. Pass full connection JSON.
3. **Refuse**: if keytar is unavailable and no env var set, credentials are NOT stored in plaintext. The CLI warns and tells you to use env vars.

Sensitive fields (`password`, `private_key_passphrase`, `access_token`, `ssh_password`, `connection_string`) are always stripped from `connections.json` on disk.

## Telemetry

The following anonymized telemetry events are tracked to understand usage patterns (no SQL content, passwords, or file paths are ever sent):

| Event | When | Key Fields |
|-------|------|------------|
| `warehouse_connect` | Connection attempt | warehouse_type, auth_method, success, error_category |
| `warehouse_query` | SQL execution | warehouse_type, query_type (SELECT/INSERT/DDL), row_count |
| `warehouse_introspection` | Schema indexing | operation, result_count |
| `warehouse_discovery` | Auto-discovery | source (docker/dbt/env), connections_found |
| `warehouse_census` | Once per session | total_connections, warehouse_types |

Telemetry can be disabled:
```bash
export ALTIMATE_TELEMETRY_DISABLED=true
```

Or in config:
```json
{
  "telemetry": { "disabled": true }
}
```

Telemetry failures **never** affect functionality because every tracking call is wrapped in try/catch.
