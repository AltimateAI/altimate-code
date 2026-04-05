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

const MONGODB_ALIASES: AliasMap = {
  ...COMMON_ALIASES,
  connection_string: ["connectionString", "uri", "url"],
  auth_source: ["authSource"],
  replica_set: ["replicaSet"],
  direct_connection: ["directConnection"],
  connect_timeout: ["connectTimeoutMS"],
  server_selection_timeout: ["serverSelectionTimeoutMS"],
}

const CLICKHOUSE_ALIASES: AliasMap = {
  ...COMMON_ALIASES,
  connection_string: ["connectionString", "uri", "url"],
  request_timeout: ["requestTimeout", "timeout"],
  tls_ca_cert: ["tlsCaCert", "ssl_ca", "ca_cert"],
  tls_cert: ["tlsCert", "ssl_cert"],
  tls_key: ["tlsKey", "ssl_key"],
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
  mongodb: MONGODB_ALIASES,
  mongo: MONGODB_ALIASES,
  clickhouse: CLICKHOUSE_ALIASES,
  // duckdb and sqlite have simple configs — no aliases needed
}

// ---------------------------------------------------------------------------
// Connection string password encoding
// ---------------------------------------------------------------------------

/**
 * URI-style connection strings (postgres://, mongodb://, etc.) embed
 * credentials in the userinfo section: `scheme://user:password@host/db`.
 * If the password contains special characters (@, #, :, /, ?, etc.) and
 * they are NOT percent-encoded, drivers will mis-parse the URI and fail
 * with cryptic auth errors.
 *
 * This function detects an unencoded password in the userinfo portion and
 * re-encodes it so the connection string is valid.  Already-encoded
 * passwords (containing %XX sequences) are left untouched.
 */
export function sanitizeConnectionString(connectionString: string): string {
  // Only touch scheme://... URIs.
  const schemeMatch = connectionString.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//)
  if (!schemeMatch) return connectionString

  const scheme = schemeMatch[0]
  const afterScheme = connectionString.slice(scheme.length)

  // Find the userinfo/host separator. A password can legitimately contain
  // '@', '#', '/', '?', or ':' characters, so the URI spec is ambiguous
  // when those are unencoded. We use the LAST '@' as the separator because
  // that correctly handles the common case of passwords with special
  // characters (the stated purpose of this function — see issue #589).
  //
  // The known trade-off: if the query string or path also contains an
  // unencoded '@' (e.g. `?email=alice@example.com`), the rightmost '@'
  // is NOT the userinfo separator. We detect this ambiguous case below
  // with a guard and bail to avoid corrupting the URI.
  const lastAt = afterScheme.lastIndexOf("@")
  if (lastAt < 0) return connectionString // No userinfo — nothing to fix

  const beforeAt = afterScheme.slice(0, lastAt)
  const afterAt = afterScheme.slice(lastAt + 1)

  // Ambiguity guard: if the content AFTER the '@' has no path/query/
  // fragment delimiter ('/', '?', or '#') but the content BEFORE the
  // '@' does, then the '@' is almost certainly inside a path, query,
  // or fragment — not the userinfo separator. Bail and leave the URI
  // untouched so the caller can pre-encode explicitly.
  //
  // Examples that trigger the guard (correctly left alone):
  //   postgresql://u:p@host/db?email=alice@example.com   ('@' in query)
  //   postgresql://u:p@host:5432/db@archive              ('@' in path)
  //   postgresql://u:p@host/db#at@frag                   ('@' in fragment)
  //
  // Examples that pass the guard (correctly encoded):
  //   postgresql://u:p@ss@host/db            (last '@' has '/' after)
  //   postgresql://u:f@ke#PLACEHOLDER@host/db (last '@' has '/' after)
  const afterAtHasDelim = /[/?#]/.test(afterAt)
  const beforeAtHasDelim = /[/?#]/.test(beforeAt)
  if (!afterAtHasDelim && beforeAtHasDelim) {
    return connectionString
  }

  // Idempotent re-encoding: decode any existing percent-escapes and
  // re-encode. Already-encoded values round-trip unchanged; raw values
  // with special characters get encoded. Malformed percent sequences
  // fall back to encoding the raw input.
  const encodeIdempotent = (v: string): string => {
    if (v.length === 0) return v
    try {
      return encodeURIComponent(decodeURIComponent(v))
    } catch {
      return encodeURIComponent(v)
    }
  }

  // Split userinfo on the FIRST ':' only (password may contain ':').
  const colonIdx = beforeAt.indexOf(":")
  let encodedUserinfo: string
  if (colonIdx < 0) {
    // Username-only userinfo: still encode if it contains special chars
    // (e.g. email addresses used as usernames).
    encodedUserinfo = encodeIdempotent(beforeAt)
  } else {
    const user = beforeAt.slice(0, colonIdx)
    const password = beforeAt.slice(colonIdx + 1)
    encodedUserinfo = `${encodeIdempotent(user)}:${encodeIdempotent(password)}`
  }

  const rebuilt = `${scheme}${encodedUserinfo}@${afterAt}`
  return rebuilt === connectionString ? connectionString : rebuilt
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

  // Sanitize connection_string: if the password contains special characters
  // (@, #, :, /, etc.) that are not percent-encoded, URI-based drivers will
  // mis-parse the string and fail with cryptic auth errors.  This is the
  // single integration point — every caller of normalizeConfig() gets the
  // fix automatically.
  if (typeof result.connection_string === "string") {
    result.connection_string = sanitizeConnectionString(result.connection_string)
  }

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
