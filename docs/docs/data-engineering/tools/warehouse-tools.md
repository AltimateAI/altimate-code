# Warehouse Tools

## project_scan

Scan the entire data engineering environment in one call. Detects dbt projects, warehouse connections, Docker databases, installed tools, and configuration files. Used by the `/discover` command.

```
> /discover

# Environment Scan

## Git Repository
✓ Git repo on branch `main` (origin: github.com/org/analytics)

## dbt Project
✓ Project "analytics" (profile: snowflake_prod)
  Models: 47, Sources: 12, Tests: 89
  ✓ packages.yml found

## Warehouse Connections

### Already Configured
Name            | Type      | Database
prod-snowflake  | snowflake | ANALYTICS

### From dbt profiles.yml
Name                  | Type      | Source
dbt_snowflake_dev     | snowflake | dbt-profile

### From Docker
Container      | Type     | Host:Port
local-postgres | postgres | localhost:5432

### From Environment Variables
Name          | Type     | Signal
env_bigquery  | bigquery | GOOGLE_APPLICATION_CREDENTIALS

## Installed Data Tools
✓ dbt v1.8.4
✓ sqlfluff v3.1.0
✗ airflow (not found)

## Config Files
✓ .altimate-code/altimate-code.json
✓ .sqlfluff
✗ .pre-commit-config.yaml (not found)
```

### What it detects

| Category | Detection method |
|----------|-----------------|
| **Git** | `git` commands (branch, remote) |
| **dbt project** | Walks up directories for `dbt_project.yml`, reads name/profile |
| **dbt manifest** | Parses `target/manifest.json` for model/source/test counts |
| **dbt profiles** | Bridge call to parse `~/.dbt/profiles.yml` |
| **Docker DBs** | Bridge call to discover running PostgreSQL/MySQL/MSSQL containers |
| **Existing connections** | Bridge call to list already-configured warehouses |
| **Environment variables** | Scans `process.env` for warehouse signals (see table below) |
| **Schema cache** | Bridge call for indexed warehouse status |
| **Data tools** | Spawns `tool --version` for 9 common tools |
| **Config files** | Checks for `.altimate-code/`, `.sqlfluff`, `.pre-commit-config.yaml` |

### Environment variable detection

| Warehouse | Signal (any one triggers detection) |
|-----------|-------------------------------------|
| Snowflake | `SNOWFLAKE_ACCOUNT` |
| BigQuery | `GOOGLE_APPLICATION_CREDENTIALS`, `BIGQUERY_PROJECT`, `GCP_PROJECT` |
| Databricks | `DATABRICKS_HOST`, `DATABRICKS_SERVER_HOSTNAME` |
| PostgreSQL | `PGHOST`, `PGDATABASE`, `DATABASE_URL` |
| MySQL | `MYSQL_HOST`, `MYSQL_DATABASE` |
| Redshift | `REDSHIFT_HOST` |

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `skip_docker` | boolean | Skip Docker container discovery (faster) |
| `skip_tools` | boolean | Skip installed tool detection (faster) |

---

## warehouse_list

List all configured warehouse connections.

```
> warehouse_list

┌─────────────────┬───────────┬────────────┬─────────────┐
│ Name            │ Type      │ Database   │ Status      │
├─────────────────┼───────────┼────────────┼─────────────┤
│ prod-snowflake  │ snowflake │ ANALYTICS  │ configured  │
│ dev-duckdb      │ duckdb    │ dev.duckdb │ configured  │
│ bigquery-prod   │ bigquery  │ my-project │ configured  │
│ databricks-prod │ databricks│ main       │ configured  │
└─────────────────┴───────────┴────────────┴─────────────┘
```

---

## warehouse_test

Test a warehouse connection.

```
> warehouse_test prod-snowflake

Testing connection to prod-snowflake (snowflake)...
  ✓ Connected successfully
  Account: xy12345.us-east-1
  User: analytics_user
  Role: ANALYST_ROLE
  Warehouse: COMPUTE_WH
  Database: ANALYTICS
```

```
> warehouse_test bigquery-prod

Testing connection to bigquery-prod (bigquery)...
  ✓ Connected successfully
  Project: my-gcp-project
  Dataset: analytics
  Auth: Service Account (svc-altimate@my-gcp-project.iam.gserviceaccount.com)
```

### Connection troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `Authentication failed` | Wrong credentials | Check password/token in config |
| `Connection refused` | Network/firewall | Verify host/port, check VPN |
| `Object does not exist` | Wrong database/schema | Verify database name in config |
| `Role not authorized` | Insufficient privileges | Use a role with USAGE on warehouse |
| `Timeout` | Network latency | Increase connection timeout |

---

## warehouse_add

Add a new warehouse connection by providing a name and configuration.

```
> warehouse_add my-postgres {"type": "postgres", "host": "localhost", "port": 5432, "database": "analytics", "user": "analyst", "password": "secret"}

✓ Added warehouse 'my-postgres' (postgres)
```

---

## warehouse_remove

Remove an existing warehouse connection.

```
> warehouse_remove my-postgres

✓ Removed warehouse 'my-postgres'
```

---

## warehouse_discover

Discover database containers running in Docker. Detects PostgreSQL, MySQL/MariaDB, and SQL Server containers with their connection details.

```
> warehouse_discover

Container      | Type     | Host:Port       | User     | Database | Status
local-postgres | postgres | localhost:5432  | postgres | postgres | running
mysql-dev      | mysql    | localhost:3306  | root     | mydb     | running

Use warehouse_add to save any of these as a connection.
```
