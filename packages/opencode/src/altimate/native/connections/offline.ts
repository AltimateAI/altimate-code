// altimate_change - new file
import { isLocalFilePath, normalizeConfig, type ConnectionConfig } from "@altimateai/drivers"
import { isLoopbackHost } from "@/config/offline"

const DENIED = "Offline mode allows only local file databases and warehouses at a loopback host."

/** A local file path. Templates are rendered later, so they cannot be judged; UNC paths are network shares. */
export function isLocalPath(value: unknown): boolean {
  if (typeof value !== "string" || /\{[{%#]/.test(value) || /^(?:\\\\|\/\/)/.test(value)) return false
  if (value === "" || value === ":memory:") return true
  // file:////server/share is a UNC path written as a URL.
  if (/^file:/i.test(value))
    return URL.canParse(value) && ["", "localhost"].includes(new URL(value).hostname) && !decodeURIComponent(new URL(value).pathname).startsWith("//")
  // Rejects scheme:// URLs (s3, gcs, http and so on) and DuckDB's non-slash remote schemes such as md:.
  return isLocalFilePath(value)
}

/** Refuse a warehouse connection that does not stay on this machine. */
export function assertLocalConnection(raw: ConnectionConfig): void {
  const config = normalizeConfig(raw)
  const type = String(config.type).toLowerCase()
  // An SSH tunnel reaches another machine whatever the database type.
  if (config.ssh_host) throw new Error(DENIED)
  if (type === "duckdb" || type === "sqlite") {
    if (!isLocalPath(config.path)) throw new Error(DENIED)
    return
  }
  // Only types whose driver connects to the configured host can be judged; account- or project-addressed
  // warehouses (Snowflake, BigQuery, Databricks and others) are refused.
  if (!HOST_ADDRESSED.has(type) || config.replica_set || config.direct_connection === false) throw new Error(DENIED)
  // Trino and ClickHouse build `${protocol}://${host}`, so a protocol value could carry its own authority.
  if (config.protocol !== undefined && !["http", "https"].includes(String(config.protocol).trim().toLowerCase()))
    throw new Error(DENIED)
  // Cloud sign-in contacts an identity provider even for a loopback host. SQL Server's driver and dbt map many
  // values (cli, default, msi, ActiveDirectory*, ServicePrincipal) to Azure AD, so only local methods pass.
  if (
    ["sqlserver", "mssql"].includes(type) &&
    config.authentication !== undefined &&
    !["", "sql", "sqlpassword", "sql-password", "ntlm", "windows"].includes(String(config.authentication).trim().toLowerCase())
  )
    throw new Error(DENIED)
  // A Unix socket is a local file.
  if (config.socketPath !== undefined && !(typeof config.socketPath === "string" && config.socketPath.startsWith("/")))
    throw new Error(DENIED)
  const postgres = ["postgres", "postgresql", "redshift"].includes(type)
  // Postgres accepts a socket directory as its host; a comma-separated list names several hosts.
  const socketDir = (host: string) => postgres && host.startsWith("/") && !host.includes(",")
  const hosts = [config.host, config.server].filter((value) => value !== undefined)
  for (const raw of hosts) {
    // SQL Server names an instance as host\instance.
    const host = typeof raw === "string" && ["sqlserver", "mssql"].includes(type) ? raw.split("\\")[0] : raw
    if (typeof host === "string" && socketDir(host)) continue
    if (!isLoopbackHost(host)) throw new Error(DENIED)
  }
  const url = config.connection_string ?? config.url
  if (url !== undefined) {
    let parsed: URL
    try {
      parsed = new URL(String(url))
    } catch {
      throw new Error(DENIED)
    }
    // mongodb+srv:// and replica sets discover other hosts.
    const param = (name: string) => [...parsed.searchParams].find(([key]) => key.toLowerCase() === name)?.[1]
    if (parsed.protocol.endsWith("+srv:") || param("replicaset") !== undefined || param("directconnection") === "false")
      throw new Error(DENIED)
    const mechanism = [...parsed.searchParams].find(([key]) => key.toLowerCase() === "authmechanism")?.[1]?.toUpperCase()
    if (mechanism && ["MONGODB-AWS", "MONGODB-OIDC", "GSSAPI"].includes(mechanism)) throw new Error(DENIED)
    // A query parameter such as Postgres's ?host= or ?hostaddr= overrides the URL's host.
    const overrides = [...parsed.searchParams].filter(([key]) => ["host", "hostaddr", "server"].includes(key.toLowerCase()))
    if (!parsed.hostname && overrides.length === 0) throw new Error(DENIED)
    for (const host of [parsed.hostname, ...overrides.map(([, value]) => value)].filter(Boolean))
      if (!socketDir(host) && !isLoopbackHost(host)) throw new Error(DENIED)
  }
  // Without a host these drivers connect to localhost; any other type names its server some other way.
  if (hosts.length === 0 && url === undefined && config.socketPath === undefined && !LOCALHOST_BY_DEFAULT.has(type))
    throw new Error(DENIED)
}

const HOST_ADDRESSED = new Set([
  "postgres", "postgresql", "redshift", "mysql", "mariadb", "sqlserver", "mssql", "clickhouse", "trino", "oracle", "mongodb", "mongo",
])

const LOCALHOST_BY_DEFAULT = new Set(["postgres", "postgresql", "mysql", "mariadb", "sqlserver", "mssql", "clickhouse", "mongodb", "mongo", "trino", "oracle", "redshift"])
