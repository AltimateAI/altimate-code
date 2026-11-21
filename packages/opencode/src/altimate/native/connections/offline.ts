// altimate_change - new file
import { isLocalFilePath, normalizeConfig, type ConnectionConfig } from "@altimateai/drivers"
import { isLoopbackHost } from "@/config/offline"

const DENIED = "Offline mode allows only local file databases and warehouses at a loopback host."

/** A local file path. Templates are rendered later, so they cannot be judged; UNC paths are network shares. */
export function isLocalPath(value: unknown): boolean {
  if (typeof value !== "string" || /\{[{%#]/.test(value) || /^(?:\\\\|\/\/)/.test(value)) return false
  if (value === "" || value === ":memory:") return true
  if (/^file:/i.test(value)) return URL.canParse(value) && ["", "localhost"].includes(new URL(value).hostname)
  // Rejects scheme:// URLs (s3, gcs, http and so on) and DuckDB's non-slash remote schemes such as md:.
  return isLocalFilePath(value)
}

/** Refuse a warehouse connection that does not stay on this machine. */
export function assertLocalConnection(raw: ConnectionConfig): void {
  const config = normalizeConfig(raw)
  const type = String(config.type).toLowerCase()
  if (type === "duckdb" || type === "sqlite") {
    if (!isLocalPath(config.path)) throw new Error(DENIED)
    return
  }
  if (config.ssh_host) throw new Error(DENIED)
  // A Unix socket is a local file.
  if (config.socketPath !== undefined && !(typeof config.socketPath === "string" && config.socketPath.startsWith("/")))
    throw new Error(DENIED)
  // Postgres accepts a socket directory as its host.
  const hosts = [config.host, config.server].filter((value) => value !== undefined)
  for (const host of hosts) {
    if (typeof host === "string" && host.startsWith("/")) continue
    if (!isLoopbackHost(host)) throw new Error(DENIED)
  }
  const url = config.connection_string ?? config.url
  if (url !== undefined) {
    let hostname: string
    try {
      hostname = new URL(String(url)).hostname
    } catch {
      throw new Error(DENIED)
    }
    if (!isLoopbackHost(hostname)) throw new Error(DENIED)
  }
  // Without a host these drivers connect to localhost; any other type names its server some other way.
  if (hosts.length === 0 && url === undefined && config.socketPath === undefined && !LOCALHOST_BY_DEFAULT.has(type))
    throw new Error(DENIED)
}

const LOCALHOST_BY_DEFAULT = new Set(["postgres", "postgresql", "mysql", "mariadb", "sqlserver", "mssql", "clickhouse", "mongodb", "mongo"])
