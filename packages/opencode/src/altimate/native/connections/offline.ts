// altimate_change - new file
import { isLocalFilePath, normalizeConfig, type ConnectionConfig } from "@altimateai/drivers"
import { isLoopbackHost } from "@/config/offline"

function localStore(value: unknown): boolean {
  if (typeof value !== "string" || value.includes("{{")) return false
  if (value === ":memory:" || value === "") return true
  // UNC shares are network locations, even though they look like paths.
  if (/^(?:\\\\|\/\/)/.test(value)) return false
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value)
      return (!url.hostname || url.hostname === "localhost") && !decodeURIComponent(url.pathname).startsWith("//")
    } catch { return false }
  }
  return isLocalFilePath(value)
}

/** Guard app-owned connection setup; SQL and project macros are user-controlled code. */
export function assertLocalConnection(raw: ConnectionConfig): void {
  const config = normalizeConfig(raw)
  const type = config.type.toLowerCase()
  const deny = () => { throw new Error("Offline mode allows only local file databases and loopback warehouse connections.") }
  if (config.ssh_host || config.replica_set || config.socketPath) deny()
  if (type === "duckdb" || type === "sqlite") {
    if (!localStore(config.path)) deny()
    return
  }
  if (!["postgres", "postgresql", "mysql", "mariadb", "sqlserver", "mssql", "oracle", "redshift", "clickhouse", "trino", "mongodb", "mongo"].includes(type)) deny()
  // Cloud authentication may contact an identity provider even for a loopback host.
  if (config.authentication && !["sql", "ntlm"].includes(String(config.authentication).toLowerCase())) deny()
  const mongo = type === "mongodb" || type === "mongo"
  if (mongo && config.direct_connection !== undefined && config.direct_connection !== true) deny()
  if (config.host !== undefined && !isLoopbackHost(config.host)) deny()
  // Trino and ClickHouse build `${protocol}://${host}` URLs, so a protocol value can carry its own authority.
  if ((type === "trino" || type === "clickhouse") && config.protocol !== undefined &&
    !["http", "https"].includes(String(config.protocol).trim().toLowerCase())) deny()
  const connectionString = type === "trino"
    ? config.connection_string ?? config.server ?? config.url
    : config.connection_string
  if (type === "oracle" && typeof connectionString === "string" && !connectionString.includes("://")) {
    // Easy Connect: host[:port][/service]. Descriptors and TNS aliases name hosts this check cannot see.
    const easy = /^(?:\/\/)?(\[[^\]]+\]|[^:/\s()]+)(?::\d+)?(?:\/[^\s()]*)?$/.exec(connectionString.trim())
    if (!easy || !isLoopbackHost(easy[1])) deny()
  } else if (connectionString) {
    try {
      const url = new URL(String(connectionString))
      if ((type === "trino" || type === "clickhouse") && !["http:", "https:"].includes(url.protocol)) deny()
      if (!isLoopbackHost(url.hostname) || url.protocol === "mongodb+srv:") deny()
      const query = new Map([...url.searchParams].map(([key, value]) => [key.toLowerCase(), value.toLowerCase()]))
      if (mongo && config.direct_connection !== true && query.get("directconnection") !== "true") deny()
      if (mongo && ["mongodb-aws", "mongodb-oidc", "gssapi"].includes(query.get("authmechanism") ?? "")) deny()
      // Drivers can override the authority via URL parameters or discover replica peers.
      for (const key of url.searchParams.keys()) {
        if (["host", "hostaddr", "server", "replicaset", "service"].includes(key.toLowerCase())) deny()
      }
    } catch { deny() }
  } else if (mongo && config.direct_connection !== true) deny()
}
