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
  if (config.ssh_host || config.replica_set) deny()
  // A Unix socket is a local file; a Windows named pipe or other value is not checked here.
  if (config.socketPath && !(typeof config.socketPath === "string" && config.socketPath.startsWith("/"))) deny()
  if (type === "duckdb" || type === "sqlite") {
    if (!localStore(config.path)) deny()
    return
  }
  if (!["postgres", "postgresql", "mysql", "mariadb", "sqlserver", "mssql", "oracle", "redshift", "clickhouse", "trino", "mongodb", "mongo"].includes(type)) deny()
  // Cloud authentication may contact an identity provider even for a loopback host.
  if (config.authentication && !["sql", "ntlm"].includes(String(config.authentication).toLowerCase())) deny()
  const mongo = type === "mongodb" || type === "mongo"
  if (mongo && config.direct_connection !== undefined && config.direct_connection !== true) deny()
  // Postgres accepts a socket directory as its host.
  const postgres = ["postgres", "postgresql", "redshift"].includes(type)
  const socketHost = typeof config.host === "string" && config.host.startsWith("/") && postgres
  // SQL Server names an instance as host\instance.
  const host = typeof config.host === "string" && ["sqlserver", "mssql"].includes(type) ? config.host.split("\\")[0] : config.host
  if (host !== undefined && !socketHost && !isLoopbackHost(host)) deny()
  // dbt-mysql and others name the host `server`; Trino's `server` is a URL checked below.
  if (type !== "trino" && config.server !== undefined && !isLoopbackHost(config.server)) deny()
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
      const query = new Map([...url.searchParams].map(([key, value]) => [key.toLowerCase(), value.toLowerCase()]))
      // postgresql:///db?host=/run/postgresql connects through a local Unix socket.
      // Exactly one lowercase host parameter, naming a socket directory; drivers read only that exact key.
      const hostParams = [...url.searchParams.keys()].filter((key) => key.toLowerCase() === "host")
      const socketURL = postgres && !url.hostname && hostParams.length === 1 && hostParams[0] === "host" &&
        url.searchParams.get("host")!.startsWith("/") && !query.has("hostaddr")
      if ((!socketURL && !isLoopbackHost(url.hostname)) || url.protocol === "mongodb+srv:") deny()
      if (mongo && config.direct_connection !== true && query.get("directconnection") !== "true") deny()
      if (mongo && ["mongodb-aws", "mongodb-oidc", "gssapi"].includes(query.get("authmechanism") ?? "")) deny()
      // Drivers can override the authority via URL parameters or discover replica peers.
      for (const key of url.searchParams.keys()) {
        if (socketURL && key === "host") continue
        if (["host", "hostaddr", "server", "replicaset", "service"].includes(key.toLowerCase())) deny()
      }
    } catch { deny() }
  } else if (mongo && config.direct_connection !== true) deny()
}
