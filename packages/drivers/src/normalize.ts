/**
 * Config field name normalization for warehouse drivers.
 *
 * The warehouse_add tool takes a generic Record<string, unknown> config.
 * LLMs, dbt profiles, and SDK conventions use different field names for the
 * same config values. This module normalizes them to canonical snake_case
 * names before the config reaches the driver.
 */

import type { ConnectionConfig } from "./types"

// ---------------------------------------------------------------------------
// Per-driver alias maps
// ---------------------------------------------------------------------------
// Key = canonical field name, Value = list of aliases (checked in order).
// First-value-wins: if the canonical field is already present, aliases are
// ignored.

type AliasMap = Record<string, string[]>

/** Aliases common to most drivers. */
const COMMON_ALIASES: AliasMap = {
  user: ["username"],
  database: ["dbname", "db"],
}

const SNOWFLAKE_ALIASES: AliasMap = {
  ...COMMON_ALIASES,
  private_key_path: ["privateKeyPath"],
  private_key_passphrase: ["privateKeyPassphrase", "privateKeyPass"],
  private_key: ["privateKey"],
  access_token: ["token"],
  oauth_client_id: ["oauthClientId"],
  oauth_client_secret: ["oauthClientSecret"],
}

const BIGQUERY_ALIASES: AliasMap = {
  project: ["projectId", "project_id"],
  credentials_path: ["keyfile", "keyFilename", "key_file", "keyFile"],
  credentials_json: ["keyfile_json", "keyfileJson"],
  dataset: ["defaultDataset", "default_dataset"],
}

const DATABRICKS_ALIASES: AliasMap = {
  server_hostname: ["host", "serverHostname"],
  http_path: ["httpPath"],
  access_token: ["token", "personal_access_token", "personalAccessToken"],
}

const POSTGRES_ALIASES: AliasMap = {
  ...COMMON_ALIASES,
  connection_string: ["connectionString"],
}

const REDSHIFT_ALIASES: AliasMap = {
  ...COMMON_ALIASES,
  connection_string: ["connectionString"],
}

const MYSQL_ALIASES: AliasMap = {
  ...COMMON_ALIASES,
}

const SQLSERVER_ALIASES: AliasMap = {
  ...COMMON_ALIASES,
  host: ["server", "serverName", "server_name"],
  trust_server_certificate: ["trustServerCertificate"],
}

const ORACLE_ALIASES: AliasMap = {
  ...COMMON_ALIASES,
  connection_string: ["connectString", "connect_string", "connectionString"],
  service_name: ["serviceName"],
}

/** Map of warehouse type to its alias map. */
const DRIVER_ALIASES: Record<string, AliasMap> = {
  snowflake: SNOWFLAKE_ALIASES,
  bigquery: BIGQUERY_ALIASES,
  databricks: DATABRICKS_ALIASES,
  postgres: POSTGRES_ALIASES,
  postgresql: POSTGRES_ALIASES,
  redshift: REDSHIFT_ALIASES,
  mysql: MYSQL_ALIASES,
  mariadb: MYSQL_ALIASES,
  sqlserver: SQLSERVER_ALIASES,
  mssql: SQLSERVER_ALIASES,
  oracle: ORACLE_ALIASES,
  // duckdb and sqlite have simple configs — no aliases needed
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Apply alias mappings to a config object.
 * For each canonical field: if it is not already set, check each alias in
 * order and use the first non-undefined value. Consumed aliases are removed
 * from the output to avoid passing unexpected fields to the driver.
 */
function applyAliases(config: ConnectionConfig, aliases: AliasMap): ConnectionConfig {
  const result = { ...config }

  for (const [canonical, aliasList] of Object.entries(aliases)) {
    let resolved = result[canonical] !== undefined
    for (const alias of aliasList) {
      if (result[alias] !== undefined) {
        if (!resolved) {
          result[canonical] = result[alias]
          resolved = true
        }
        delete result[alias]
      }
    }
  }

  return result
}

/**
 * Handle Snowflake private_key: if the value doesn't look like a file path,
 * keep it as private_key (inline PEM). If it looks like a path, move it to
 * private_key_path.
 */
function normalizeSnowflakePrivateKey(config: ConnectionConfig): ConnectionConfig {
  const pk = config.private_key
  if (typeof pk !== "string" || !pk) return config
  if (config.private_key_path) return config // already have a path

  // Inline PEM starts with "-----BEGIN" or contains newlines
  if (pk.includes("-----BEGIN") || pk.includes("\n")) {
    return config // keep as private_key (inline PEM)
  }

  // Looks like a file path
  if (pk.includes("/") || pk.includes("\\") || pk.endsWith(".pem") || pk.endsWith(".p8")) {
    const result = { ...config }
    result.private_key_path = pk
    delete result.private_key
    return result
  }

  return config
}

/**
 * Normalize a connection config by resolving field name aliases.
 * Returns a new config object; does not mutate the input.
 * Unknown types pass through unchanged.
 */
export function normalizeConfig(config: ConnectionConfig): ConnectionConfig {
  const type = config.type?.toLowerCase()
  if (!type) return { ...config }

  const aliases = DRIVER_ALIASES[type]
  let result = aliases ? applyAliases(config, aliases) : { ...config }

  // Type-specific post-processing
  // Note: MySQL SSL fields (ssl_ca, ssl_cert, ssl_key) are NOT constructed
  // into an ssl object here. They stay as top-level fields so the credential
  // store can detect and strip them. The MySQL driver constructs the ssl
  // object at connection time.
  if (type === "snowflake") {
    result = normalizeSnowflakePrivateKey(result)
  }

  return result
}
