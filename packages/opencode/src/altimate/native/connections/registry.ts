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
import type { ConnectionConfig, Connector } from "./types"
import { resolveConfig, saveConnection } from "./credential-store"
import { startTunnel, extractSshConfig, closeTunnel } from "./ssh-tunnel"
import type { WarehouseInfo } from "../types"

/** In-memory config store. */
let configs = new Map<string, ConnectionConfig>()

/** Cached connector instances. */
const connectors = new Map<string, Connector>()

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
  postgres: "./drivers/postgres",
  postgresql: "./drivers/postgres",
  redshift: "./drivers/redshift",
  snowflake: "./drivers/snowflake",
  bigquery: "./drivers/bigquery",
  mysql: "./drivers/mysql",
  mariadb: "./drivers/mysql",
  sqlserver: "./drivers/sqlserver",
  mssql: "./drivers/sqlserver",
  databricks: "./drivers/databricks",
  duckdb: "./drivers/duckdb",
  oracle: "./drivers/oracle",
  sqlite: "./drivers/sqlite",
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

  // Lazy import the driver
  const mod = await import(driverPath)
  const connector = await mod.connect(resolvedConfig)
  return connector
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get a connector instance (creates lazily). */
export async function get(name: string): Promise<Connector> {
  ensureLoaded()

  const cached = connectors.get(name)
  if (cached) return cached

  const config = configs.get(name)
  if (!config) {
    throw new Error(
      `Connection "${name}" not found. Available: ${Array.from(configs.keys()).join(", ") || "(none)"}`,
    )
  }

  const connector = await createConnector(name, config)
  await connector.connect()
  connectors.set(name, connector)
  return connector
}

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
    const sanitized = await saveConnection(name, config)

    // Save to global config file
    const globalPath = globalConfigPath()
    const dir = path.dirname(globalPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const existing = loadFromFile(globalPath)
    existing[name] = sanitized
    fs.writeFileSync(globalPath, JSON.stringify(existing, null, 2), "utf-8")

    // Update in-memory
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

    return { success: true, name, type: config.type }
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
  loaded = false
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
