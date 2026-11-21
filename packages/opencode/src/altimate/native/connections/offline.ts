// altimate_change - new file
import { isIP } from "node:net"
import { isLocalFilePath, normalizeConfig, type ConnectionConfig } from "@altimateai/drivers"

/** Literal loopback addresses only: no DNS lookups or hostname suffix matching. */
export function isLoopbackHost(value: unknown): boolean {
  if (typeof value !== "string") return false
  const host = value.toLowerCase().replace(/^\[|\]$/g, "")
  return host === "localhost" || host === "localhost." || host === "::1" || (isIP(host) === 4 && host.startsWith("127."))
}

function localStore(value: unknown): boolean {
  if (typeof value !== "string" || value.includes("{{")) return false
  if (value === ":memory:" || value === "") return true
  // UNC shares are network locations, even though they look like paths.
  if (/^(?:\\\\|\/\/)/.test(value)) return false
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value)
      return !url.hostname || url.hostname === "localhost"
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
  if (config.authentication && !["default", "sql", "ntlm"].includes(String(config.authentication).toLowerCase())) deny()
  if (config.host !== undefined && !isLoopbackHost(config.host)) deny()
  const connectionString = type === "trino"
    ? config.connection_string ?? config.server ?? config.url
    : config.connection_string
  if (connectionString) {
    try {
      const url = new URL(String(connectionString))
      if ((type === "trino" || type === "clickhouse") && !["http:", "https:"].includes(url.protocol)) deny()
      if (!isLoopbackHost(url.hostname) || url.protocol === "mongodb+srv:") deny()
      if (["mongodb", "mongo"].includes(type) && url.searchParams.get("directConnection") !== "true") deny()
      // Drivers can override the authority via URL parameters or discover replica peers.
      for (const key of url.searchParams.keys()) {
        if (["host", "hostaddr", "server", "replicaset", "service"].includes(key.toLowerCase())) deny()
      }
    } catch { deny() }
  } else if (["mongodb", "mongo"].includes(type) || !isLoopbackHost(config.host ?? "127.0.0.1")) deny()
}
