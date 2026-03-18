/**
 * ConnectionRegistry — manages database connections.
 *
 * Loads configs from:
 *   1. ~/.altimate-code/connections.json (global)
 *   2. .altimate-code/connections.json (project-local)
 *   3. ALTIMATE_CODE_CONN_* environment variables
 *
 * Connectors are created lazily via dynamic import of the appropriate driver.
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { Log } from "../../../util/log"
import type { ConnectionConfig, Connector } from "@altimateai/drivers"
import { resolveConfig, saveConnection } from "./credential-store"
import { startTunnel, extractSshConfig, closeTunnel } from "./ssh-tunnel"
import type { WarehouseInfo } from "../types"
import { Telemetry } from "../../../telemetry"

/** In-memory config store. */
let configs = new Map<string, ConnectionConfig>()

/** Cached connector instances. */
const connectors = new Map<string, Connector>()

/** In-flight connector creation promises to prevent race conditions. */
const pending = new Map<string, Promise<Connector>>()

/** Whether the registry has been loaded. */
let loaded = false

// ---------------------------------------------------------------------------
// Config file paths
// ---------------------------------------------------------------------------

function globalConfigPath(): string {
  return path.join(os.homedir(), ".altimate-code", "connections.json")
}

function localConfigPath(): string {
  return path.join(process.cwd(), ".altimate-code", "connections.json")
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function loadFromFile(filePath: string): Record<string, ConnectionConfig> {
  try {
    if (!fs.existsSync(filePath)) return {}
    const raw = fs.readFileSync(filePath, "utf-8")
    const parsed = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return {}
    return parsed as Record<string, ConnectionConfig>
  } catch (e) {
    Log.Default.warn(`Failed to load connections from ${filePath}: ${e}`)
    return {}
  }
}

function loadFromEnv(): Record<string, ConnectionConfig> {
  const result: Record<string, ConnectionConfig> = {}
  const prefix = "ALTIMATE_CODE_CONN_"

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(prefix) || !value) continue
    const name = key.slice(prefix.length).toLowerCase()
    try {
      const config = JSON.parse(value)
      if (typeof config === "object" && config !== null && config.type) {
        result[name] = config as ConnectionConfig
      }
    } catch {
      Log.Default.warn(`Invalid JSON in env var ${key}`)
    }
  }

  return result
}

/** Load all connection configs. Local overrides global; env overrides both. */
export function load(): void {
  configs.clear()

  const global = loadFromFile(globalConfigPath())
  const local = loadFromFile(localConfigPath())
  const env = loadFromEnv()

  // Merge: global < local < env
  for (const [name, config] of Object.entries(global)) {
    configs.set(name, config)
  }
  for (const [name, config] of Object.entries(local)) {
    configs.set(name, config)
  }
  for (const [name, config] of Object.entries(env)) {
    configs.set(name, config)
  }

  loaded = true
}

/** Ensure configs are loaded. */
function ensureLoaded(): void {
  if (!loaded) load()
}

// ---------------------------------------------------------------------------
// Driver factory
// ---------------------------------------------------------------------------

const DRIVER_MAP: Record<string, string> = {
  postgres: "@altimateai/drivers/postgres",
  postgresql: "@altimateai/drivers/postgres",
  redshift: "@altimateai/drivers/redshift",
  snowflake: "@altimateai/drivers/snowflake",
  bigquery: "@altimateai/drivers/bigquery",
  mysql: "@altimateai/drivers/mysql",
  mariadb: "@altimateai/drivers/mysql",
  sqlserver: "@altimateai/drivers/sqlserver",
  mssql: "@altimateai/drivers/sqlserver",
  databricks: "@altimateai/drivers/databricks",
  duckdb: "@altimateai/drivers/duckdb",
  oracle: "@altimateai/drivers/oracle",
  sqlite: "@altimateai/drivers/sqlite",
}

async function createConnector(
  name: string,
  config: ConnectionConfig,
): Promise<Connector> {
  const driverPath = DRIVER_MAP[config.type.toLowerCase()]
  if (!driverPath) {
    throw new Error(
      `Unsupported database type: ${config.type}. Supported: ${Object.keys(DRIVER_MAP).join(", ")}`,
    )
  }

  // Resolve credentials from keychain
  let resolvedConfig = await resolveConfig(name, config)

  // Handle SSH tunnel
  const sshConfig = extractSshConfig(resolvedConfig)
  if (sshConfig) {
    const tunnel = await startTunnel(name, sshConfig)
    // Rewrite host/port to use the local tunnel
    resolvedConfig = {
      ...resolvedConfig,
      host: "127.0.0.1",
      port: tunnel.localPort,
    }
  }

  // Import the driver using static string literals for bundler compatibility
  let connector: Connector
  try {
    let mod: any
    switch (driverPath) {
      case "@altimateai/drivers/postgres":
        mod = await import("@altimateai/drivers/postgres")
        break
      case "@altimateai/drivers/redshift":
        mod = await import("@altimateai/drivers/redshift")
        break
      case "@altimateai/drivers/snowflake":
        mod = await import("@altimateai/drivers/snowflake")
        break
      case "@altimateai/drivers/bigquery":
        mod = await import("@altimateai/drivers/bigquery")
        break
      case "@altimateai/drivers/mysql":
        mod = await import("@altimateai/drivers/mysql")
        break
      case "@altimateai/drivers/sqlserver":
        mod = await import("@altimateai/drivers/sqlserver")
        break
      case "@altimateai/drivers/databricks":
        mod = await import("@altimateai/drivers/databricks")
        break
      case "@altimateai/drivers/duckdb":
        mod = await import("@altimateai/drivers/duckdb")
        break
      case "@altimateai/drivers/oracle":
        mod = await import("@altimateai/drivers/oracle")
        break
      case "@altimateai/drivers/sqlite":
        mod = await import("@altimateai/drivers/sqlite")
        break
      default:
        throw new Error(`No static import available for driver: ${driverPath}`)
    }
    connector = await mod.connect(resolvedConfig)
  } catch (e) {
    // Clean up SSH tunnel if driver creation fails
    if (sshConfig) {
      closeTunnel(name)
    }
    throw e
  }
  return connector
}

// ---------------------------------------------------------------------------
// Telemetry helpers
// ---------------------------------------------------------------------------

export function detectAuthMethod(config: ConnectionConfig | null | undefined): string {
  if (!config || typeof config !== "object") return "unknown"
  if (config.connection_string) return "connection_string"
  if (config.private_key_path || config.privateKeyPath || config.private_key || config.privateKey) return "key_pair"
  const auth = typeof config.authenticator === "string" ? config.authenticator.toUpperCase() : ""
  if (auth === "EXTERNALBROWSER" || (typeof config.authenticator === "string" && /^https?:\/\/.+\.okta\.com/i.test(config.authenticator))) return "sso"
  if (auth === "OAUTH") return "oauth"
  if (config.access_token || config.token) return "token"
  if (config.password) return "password"
  const t = typeof config.type === "string" ? config.type.toLowerCase() : ""
  if (t === "duckdb" || t === "sqlite") return "file"
  return "unknown"
}

export function categorizeConnectionError(e: unknown): string {
  const msg = String(e).toLowerCase()
  if (msg.includes("not installed") || msg.includes("cannot find module")) return "driver_missing"
  if (msg.includes("password") || msg.includes("authentication") || msg.includes("unauthorized") || msg.includes("jwt")) return "auth_failed"
  if (msg.includes("timeout") || msg.includes("timed out")) return "timeout"
  if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("network")) return "network_error"
  if (msg.includes("config") || msg.includes("not found") || msg.includes("missing")) return "config_error"
  return "other"
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get a connector instance (creates lazily). */
export async function get(name: string): Promise<Connector> {
  ensureLoaded()

  const cached = connectors.get(name)
  if (cached) return cached

  // If a connector is already being created, await the same Promise
  const inflight = pending.get(name)
  if (inflight) return inflight

  const config = configs.get(name)
  if (!config) {
    throw new Error(
      `Connection "${name}" not found. Available: ${Array.from(configs.keys()).join(", ") || "(none)"}`,
    )
  }

  const startTime = Date.now()
  const promise = (async () => {
    try {
      const connector = await createConnector(name, config)
      try {
        await connector.connect()
      } catch (connectErr) {
        // If connect() fails after tunnel was started, clean up the tunnel
        closeTunnel(name)
        throw connectErr
      }
      connectors.set(name, connector)
      try {
        Telemetry.track({
          type: "warehouse_connect",
          timestamp: Date.now(),
          session_id: Telemetry.getContext().sessionId,
          warehouse_type: config.type,
          auth_method: detectAuthMethod(config),
          success: true,
          duration_ms: Date.now() - startTime,
        })
      } catch {}
      return connector
    } catch (e) {
      try {
        Telemetry.track({
          type: "warehouse_connect",
          timestamp: Date.now(),
          session_id: Telemetry.getContext().sessionId,
          warehouse_type: config?.type ?? "unknown",
          auth_method: detectAuthMethod(config),
          success: false,
          duration_ms: Date.now() - startTime,
          error: String(e).slice(0, 500),
          error_category: categorizeConnectionError(e),
        })
      } catch {}
      throw e
    } finally {
      pending.delete(name)
    }
  })()

  pending.set(name, promise)
  return promise
}

/** Whether a one-time warehouse census has been sent this session. */
let censusSent = false

/** List all configured connections. */
export function list(): { warehouses: WarehouseInfo[] } {
  ensureLoaded()
  const warehouses: WarehouseInfo[] = []
  for (const [name, config] of configs) {
    warehouses.push({
      name,
      type: config.type,
      database: config.database as string | undefined,
    })
  }

  // Fire a one-time census on first list call
  if (!censusSent && configs.size > 0) {
    censusSent = true
    try {
      const allConfigs = Array.from(configs.values())
      const types = [...new Set(allConfigs.map((c) => c.type))]
      const sources: string[] = []
      if (fs.existsSync(globalConfigPath())) sources.push("config_global")
      if (fs.existsSync(localConfigPath())) sources.push("config_local")
      if (Object.keys(loadFromEnv()).length > 0) sources.push("env")

      Telemetry.track({
        type: "warehouse_census",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        total_connections: configs.size,
        warehouse_types: types,
        connection_sources: sources,
        has_ssh_tunnel: allConfigs.some((c) => !!c.ssh_host),
        has_keychain: false,
      })
    } catch {}
  }

  return { warehouses }
}

/** Test a connection by running SELECT 1. */
export async function test(
  name: string,
): Promise<{ connected: boolean; error?: string }> {
  try {
    const connector = await get(name)
    await connector.execute("SELECT 1")
    return { connected: true }
  } catch (e) {
    return { connected: false, error: String(e) }
  }
}

/** Add a new connection and persist to global config. */
export async function add(
  name: string,
  config: ConnectionConfig,
): Promise<{ success: boolean; name: string; type: string; error?: string }> {
  try {
    ensureLoaded()

    // Store credentials in keychain, get sanitized config
    const { sanitized, warnings } = await saveConnection(name, config)

    // Save to global config file
    const globalPath = globalConfigPath()
    const dir = path.dirname(globalPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const existing = loadFromFile(globalPath)
    existing[name] = sanitized
    fs.writeFileSync(globalPath, JSON.stringify(existing, null, 2), "utf-8")

    // In-memory: keep original config (with credentials) so the current
    // session can connect even when keytar is unavailable. Only the disk
    // file uses the sanitized version (credentials stripped).
    configs.set(name, config)

    // Clear cached connector
    const cached = connectors.get(name)
    if (cached) {
      try {
        await cached.close()
      } catch {
        // ignore
      }
      connectors.delete(name)
    }

    const result: { success: boolean; name: string; type: string; warnings?: string[] } = { success: true, name, type: config.type }
    if (warnings.length > 0) {
      result.warnings = warnings
    }
    return result
  } catch (e) {
    return { success: false, name, type: config.type ?? "unknown", error: String(e) }
  }
}

/** Remove a connection from global config. */
export async function remove(
  name: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    ensureLoaded()

    // Close connector if cached
    const cached = connectors.get(name)
    if (cached) {
      try {
        await cached.close()
      } catch {
        // ignore
      }
      connectors.delete(name)
    }

    // Close SSH tunnel if active
    closeTunnel(name)

    // Remove from global config file
    const globalPath = globalConfigPath()
    const existing = loadFromFile(globalPath)
    delete existing[name]
    fs.writeFileSync(globalPath, JSON.stringify(existing, null, 2), "utf-8")

    // Remove from in-memory
    configs.delete(name)

    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

/** Reload all configs and clear cached connectors. */
export async function reload(): Promise<void> {
  // Close all cached connectors
  for (const [, connector] of connectors) {
    try {
      await connector.close()
    } catch {
      // ignore
    }
  }
  connectors.clear()
  loaded = false
  load()
}

/** Get the raw config for a connection (for testing). */
export function getConfig(name: string): ConnectionConfig | undefined {
  ensureLoaded()
  return configs.get(name)
}

/** Reset the registry state (for testing). */
export function reset(): void {
  configs.clear()
  connectors.clear()
  pending.clear()
  loaded = false
  censusSent = false
}

/**
 * Set configs directly (for testing without file system).
 */
export function setConfigs(
  newConfigs: Record<string, ConnectionConfig>,
): void {
  configs.clear()
  for (const [name, config] of Object.entries(newConfigs)) {
    configs.set(name, config)
  }
  loaded = true
}
