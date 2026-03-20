# Warehouses

Altimate Code connects to 8 warehouse types. Configure them in `.altimate-code/connections.json` (project-local) or `~/.altimate-code/connections.json` (global).

## Configuration

Each warehouse has a key (the connection name) and a config object:

```json
{
  "my-connection-name": {
    "type": "<warehouse-type>",
    ...
  }
}
```

!!! tip
    Use `{env:...}` substitution for passwords and tokens so you never commit secrets to version control.

## Snowflake

```json
{
  "prod-snowflake": {
    "type": "snowflake",
    "account": "xy12345.us-east-1",
    "user": "analytics_user",
    "password": "{env:SNOWFLAKE_PASSWORD}",
    "warehouse": "COMPUTE_WH",
    "database": "ANALYTICS",
    "role": "ANALYST_ROLE"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `account` | Yes | Snowflake account identifier (e.g. `xy12345.us-east-1`) |
| `user` | Yes | Username |
| `password` | Auth | Password (use one auth method) |
| `private_key_path` | Auth | Path to private key file (alternative to password) |
| `private_key_passphrase` | No | Passphrase for encrypted private key |
| `warehouse` | No | Warehouse name |
| `database` | No | Database name |
| `schema` | No | Schema name |
| `role` | No | User role |

### Key-pair authentication

```json
{
  "prod-snowflake": {
    "type": "snowflake",
    "account": "xy12345.us-east-1",
    "user": "svc_altimate",
    "private_key_path": "~/.ssh/snowflake_rsa_key.p8",
    "private_key_passphrase": "{env:SNOWFLAKE_KEY_PASSPHRASE}",
    "warehouse": "COMPUTE_WH",
    "database": "ANALYTICS",
    "role": "TRANSFORM_ROLE"
  }
}
```

## BigQuery

```json
{
  "bigquery-prod": {
    "type": "bigquery",
    "project": "my-gcp-project",
    "credentials_path": "/path/to/service-account.json",
    "location": "US"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `project` | Yes | Google Cloud project ID |
| `credentials_path` | No | Path to service account JSON file. Omit to use Application Default Credentials (ADC) |
| `location` | No | Default location (default: `US`) |

### Using Application Default Credentials

If you're already authenticated via `gcloud`, omit `credentials_path`:

```json
{
  "bigquery-prod": {
    "type": "bigquery",
    "project": "my-gcp-project"
  }
}
```

## Databricks

```json
{
  "databricks-prod": {
    "type": "databricks",
    "server_hostname": "adb-1234567890.1.azuredatabricks.net",
    "http_path": "/sql/1.0/warehouses/abcdef1234567890",
    "access_token": "{env:DATABRICKS_TOKEN}",
    "catalog": "main",
    "schema": "default"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `server_hostname` | Yes | Databricks workspace hostname |
| `http_path` | Yes | HTTP path from compute resources |
| `access_token` | Yes | Personal Access Token (PAT) |
| `catalog` | No | Unity Catalog name |
| `schema` | No | Schema/database name |

## PostgreSQL

```json
{
  "my-postgres": {
    "type": "postgres",
    "host": "localhost",
    "port": 5432,
    "database": "analytics",
    "user": "analyst",
    "password": "{env:PG_PASSWORD}"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `connection_string` | No | Full connection string (alternative to individual fields) |
| `host` | No | Hostname (default: `localhost`) |
| `port` | No | Port (default: `5432`) |
| `database` | No | Database name (default: `postgres`) |
| `user` | No | Username |
| `password` | No | Password |

### Using a connection string

```json
{
  "my-postgres": {
    "type": "postgres",
    "connection_string": "postgresql://analyst:secret@localhost:5432/analytics"
  }
}
```

## Redshift

```json
{
  "redshift-prod": {
    "type": "redshift",
    "host": "my-cluster.abc123.us-east-1.redshift.amazonaws.com",
    "port": 5439,
    "database": "analytics",
    "user": "admin",
    "password": "{env:REDSHIFT_PASSWORD}"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `connection_string` | No | Full connection string (alternative to individual fields) |
| `host` | No | Hostname |
| `port` | No | Port (default: `5439`) |
| `database` | No | Database name (default: `dev`) |
| `user` | No | Username |
| `password` | No | Password |
| `iam_role` | No | IAM role ARN (alternative to password) |
| `region` | No | AWS region (default: `us-east-1`) |
| `cluster_identifier` | No | Cluster identifier (required for IAM auth) |

### IAM authentication

```json
{
  "redshift-prod": {
    "type": "redshift",
    "host": "my-cluster.abc123.us-east-1.redshift.amazonaws.com",
    "database": "analytics",
    "user": "admin",
    "iam_role": "arn:aws:iam::123456789012:role/RedshiftReadOnly",
    "cluster_identifier": "my-cluster",
    "region": "us-east-1"
  }
}
```

## DuckDB

```json
{
  "dev-duckdb": {
    "type": "duckdb",
    "path": "./dev.duckdb"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `path` | No | Database file path. Omit or use `":memory:"` for in-memory |

## MySQL

```json
{
  "mysql-prod": {
    "type": "mysql",
    "host": "localhost",
    "port": 3306,
    "database": "analytics",
    "user": "analyst",
    "password": "{env:MYSQL_PASSWORD}"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `host` | No | Hostname (default: `localhost`) |
| `port` | No | Port (default: `3306`) |
| `database` | No | Database name |
| `user` | No | Username |
| `password` | No | Password |
| `ssl_ca` | No | Path to CA certificate file |
| `ssl_cert` | No | Path to client certificate file |
| `ssl_key` | No | Path to client key file |

## SQL Server

```json
{
  "sqlserver-prod": {
    "type": "sqlserver",
    "host": "localhost",
    "port": 1433,
    "database": "analytics",
    "user": "sa",
    "password": "{env:MSSQL_PASSWORD}"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `host` | No | Hostname (default: `localhost`) |
| `port` | No | Port (default: `1433`) |
| `database` | No | Database name |
| `user` | No | Username |
| `password` | No | Password |
| `driver` | No | ODBC driver name (default: `ODBC Driver 18 for SQL Server`) |
| `azure_auth` | No | Use Azure AD authentication (default: `false`) |
| `trust_server_certificate` | No | Trust server certificate without validation (default: `false`) |

## SSH Tunneling

All warehouse types support SSH tunneling for connections behind a bastion host:

```json
{
  "prod-via-bastion": {
    "type": "postgres",
    "host": "10.0.1.50",
    "database": "analytics",
    "user": "analyst",
    "password": "{env:PG_PASSWORD}",
    "ssh_host": "bastion.example.com",
    "ssh_port": 22,
    "ssh_user": "ubuntu",
    "ssh_auth_type": "key",
    "ssh_key_path": "~/.ssh/id_rsa"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `ssh_host` | Yes | SSH bastion hostname |
| `ssh_port` | No | SSH port (default: `22`) |
| `ssh_user` | Yes | SSH username |
| `ssh_auth_type` | No | `"key"` or `"password"` |
| `ssh_key_path` | No | Path to SSH private key |
| `ssh_password` | No | SSH password |

## Auto-Discovery

The `/discover` command can automatically detect warehouse connections from:

| Source | Detection |
|--------|-----------|
| dbt profiles | Parses `~/.dbt/profiles.yml` |
| Docker containers | Finds running PostgreSQL, MySQL, and SQL Server containers |
| Environment variables | Scans for `SNOWFLAKE_ACCOUNT`, `PGHOST`, `DATABRICKS_HOST`, etc. |

See [Warehouse Tools](../data-engineering/tools/warehouse-tools.md) for the full list of environment variable signals.

## Testing Connections

After configuring a warehouse, verify it works:

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
