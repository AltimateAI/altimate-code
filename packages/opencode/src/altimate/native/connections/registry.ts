/**
 * ConnectionRegistry — manages database connections.
 *
 * Loads configs from:
 *   1. ~/.altimate-code/connections.json (global)
 *   2. .altimate-code/connections.json (project-local)
 *   3. ALTIMATE_CODE_CONN_* environment variables
 *
 * Connectors are created lazily via dynamic import of the appropriate driver.
 *
 * A relative `path` on a file-backed connection (duckdb, sqlite) is resolved
 * once at load time against the directory that declared it — the global config
 * resolves against ~/.altimate-code, a project config and the environment
 * variables resolve against the project root. It is never re-resolved against
 * the working directory at connect time, which `--dir` changes.
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { Instance } from "@/project/instance"
import { Log } from "@/altimate/util/log"
import type { ConnectionConfig, Connector } from "@altimateai/drivers"
import { isLocalFilePath, normalizeConfig } from "@altimateai/drivers"
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

// altimate_change start — the project root, not the process working directory
/**
 * The directory the current request is working in.
 *
 * A server or `run --attach` session never chdirs: it carries the project in
 * the instance context and leaves the working directory wherever the server was
 * launched (server.ts routes every request through `Instance.provide`). Reading
 * `process.cwd()` there picks up the launch directory, which is somebody else's
 * project. `Instance.directory` throws synchronously when there is no instance
 * context — early CLI paths and unit tests — and the working directory is the
 * right answer in exactly those cases, since `run --dir` has already chdir'd.
 *
 * The registry itself is still process-global: `loaded` latches on first
 * access, so one server process serving two projects keeps the first project's
 * configs for both. That predates this change — the base was simply the launch
 * directory for everyone — and making the registry per-instance is a larger
 * change than this fix. What this does guarantee is that whichever project
 * loads resolves against itself, not against wherever the server was started.
 */
function projectRoot(): string {
  try {
    return Instance.directory
  } catch {
    return process.cwd()
  }
}
// altimate_change end

function localConfigPath(): string {
  // altimate_change start — resolve against the project, not the launch cwd
  return path.join(projectRoot(), ".altimate-code", "connections.json")
  // altimate_change end
}

// ---------------------------------------------------------------------------
// Store path resolution
// ---------------------------------------------------------------------------

// altimate_change start — resolve file-backed store paths against a stable base
/** Driver types whose `path` field names a database file on local disk. */
const FILE_STORE_TYPES = new Set(["duckdb", "sqlite"])

/**
 * Absolutize the `path` of every file-backed connection in `entries` against
 * `baseDir`, once, at load time.
 *
 * A relative store path must not follow the process working directory. `run`
 * and `attach` call `process.chdir()` for `--dir` (see cli/cmd/run.ts), so a
 * path resolved lazily at connect time points somewhere different depending on
 * how the CLI was invoked — and both file-backed engines answer a miss by
 * creating an empty database rather than failing.
 *
 * The base is the directory that declared the path, which is stable for the
 * life of the config file:
 *   - global config  -> ~/.altimate-code (the config file's own directory)
 *   - project config -> the project root (the parent of its .altimate-code)
 *   - environment    -> the project root, the only directory an ambient
 *                       variable can reasonably mean
 */
function resolveStorePaths(
  entries: Record<string, ConnectionConfig>,
  baseDir: string,
): Record<string, ConnectionConfig> {
  const resolved: Record<string, ConnectionConfig> = {}
  for (const [name, config] of Object.entries(entries)) {
    const storePath = config?.path
    const type = typeof config?.type === "string" ? config.type.toLowerCase() : ""
    // altimate_change start — recognize a Windows-absolute path even when this
    // process runs on POSIX. path.isAbsolute() is platform-bound: on macOS/Linux
    // it does not recognize `C:\...`, so a config shared or migrated from a
    // Windows machine had its already-absolute path re-mangled through
    // path.resolve(baseDir, ...) below, producing something like
    // "/project/C:\Users\me\warehouse.duckdb" instead of being left untouched.
    if (
      !FILE_STORE_TYPES.has(type) ||
      typeof storePath !== "string" ||
      !isLocalFilePath(storePath) ||
      path.isAbsolute(storePath) ||
      path.win32.isAbsolute(storePath)
    ) {
      // altimate_change end
      resolved[name] = config
      continue
    }
    resolved[name] = { ...config, path: path.resolve(baseDir, storePath) }
  }
  return resolved
}
// altimate_change end

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

  // altimate_change start — absolutize store paths against the directory that
  // declared them, so a later process.chdir() (--dir) cannot move the store.
  const base = projectRoot()
  const global = resolveStorePaths(loadFromFile(globalConfigPath()), path.dirname(globalConfigPath()))
  const local = resolveStorePaths(loadFromFile(localConfigPath()), base)
  const env = resolveStorePaths(loadFromEnv(), base)
  // altimate_change end

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
  fabric: "@altimateai/drivers/sqlserver",
  databricks: "@altimateai/drivers/databricks",
  duckdb: "@altimateai/drivers/duckdb",
  oracle: "@altimateai/drivers/oracle",
  sqlite: "@altimateai/drivers/sqlite",
  mongodb: "@altimateai/drivers/mongodb",
  mongo: "@altimateai/drivers/mongodb",
  clickhouse: "@altimateai/drivers/clickhouse",
  trino: "@altimateai/drivers/trino",
}

// altimate_change start — canonical driver identity for workspace precedence.
/**
 * Collapse a `config.type` onto the canonical name of the driver that serves it, so
 * callers reasoning about "which database is this really" cannot be fooled by an
 * alias: `postgresql` and `postgres` are one driver, as are `mariadb`/`mysql`,
 * `mssql`/`fabric`/`sqlserver`, and `mongo`/`mongodb`.
 *
 * Derived by inverting `DRIVER_MAP` rather than restating it, so a type added there
 * cannot silently desync from everything keyed on driver identity. Returns null for a
 * type no driver serves.
 *
 * `redshift` maps to its own driver and therefore stays distinct from `postgres`: a
 * different service with different credentials and endpoints, where Postgres
 * wire-compatibility is an implementation detail rather than an identity.
 */
export function canonicalType(type: string | undefined | null): string | null {
  if (!type) return null
  const driverPath = DRIVER_MAP[type.toLowerCase()]
  if (!driverPath) return null
  return driverPath.slice(driverPath.lastIndexOf("/") + 1)
}
// altimate_change end

async function createConnector(name: string, config: ConnectionConfig): Promise<Connector> {
  const driverPath = DRIVER_MAP[config.type.toLowerCase()]
  if (!driverPath) {
    // altimate_change start — friendlier error for known-but-unsupported databases
    const KNOWN_UNSUPPORTED: Record<string, string> = {
      cassandra: "Cassandra is not yet supported. Use the bash tool with `cqlsh` to query Cassandra directly.",
      cockroachdb: "CockroachDB is not yet supported. It is PostgreSQL-compatible — try type: postgres instead.",
      timescaledb: "TimescaleDB is a PostgreSQL extension — use type: postgres instead.",
    }
    const hint = KNOWN_UNSUPPORTED[config.type.toLowerCase()]
    if (hint) {
      throw new Error(hint)
    }
    // altimate_change end
    throw new Error(`Unsupported database type: ${config.type}. Supported: ${Object.keys(DRIVER_MAP).join(", ")}`)
  }

  // Normalize field names first (camelCase → snake_case, dbt → canonical)
  // so credential resolution uses canonical names for keychain lookups
  let resolvedConfig = normalizeConfig(config)

  // Resolve credentials from keychain
  resolvedConfig = await resolveConfig(name, resolvedConfig)

  // altimate_change start — validate password is a string for drivers that require it
  // Prevents cryptic SASL/SCRAM errors from database drivers
  const PASSWORD_DRIVERS = new Set([
    "postgres",
    "postgresql",
    "redshift",
    "mysql",
    "mariadb",
    "sqlserver",
    "mssql",
    "fabric",
    "oracle",
    "snowflake",
    "clickhouse",
    "trino",
  ])
  if (
    PASSWORD_DRIVERS.has(resolvedConfig.type.toLowerCase()) &&
    !resolvedConfig.connection_string &&
    resolvedConfig.password != null &&
    typeof resolvedConfig.password !== "string"
  ) {
    throw new Error(
      `Database password must be a string for ${resolvedConfig.type}. ` +
        "Check your warehouse configuration or re-add the connection with warehouse.add.",
    )
  }
  // altimate_change end

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
      case "@altimateai/drivers/mongodb":
        mod = await import("@altimateai/drivers/mongodb")
        break
      case "@altimateai/drivers/clickhouse":
        mod = await import("@altimateai/drivers/clickhouse")
        break
      case "@altimateai/drivers/trino":
        mod = await import("@altimateai/drivers/trino")
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
  if (
    auth === "EXTERNALBROWSER" ||
    (typeof config.authenticator === "string" && /^https?:\/\/.+\.okta\.com/i.test(config.authenticator))
  )
    return "sso"
  if (auth === "OAUTH") return "oauth"
  if (config.access_token || config.token) return "token"
  if (config.password) return "password"
  const t = typeof config.type === "string" ? config.type.toLowerCase() : ""
  if (t === "duckdb" || t === "sqlite") return "file"
  if (t === "mongodb" || t === "mongo") return config.password ? "password" : "connection_string"
  return "unknown"
}

export function categorizeConnectionError(e: unknown): string {
  const msg = String(e).toLowerCase()
  if (msg.includes("not installed") || msg.includes("cannot find module")) return "driver_missing"
  // altimate_change start — categories for local-client faults
  // Checked before the generic "timeout"/"not found" rules below, which are
  // about the remote warehouse and would otherwise swallow these.
  if (msg.includes("did not finish opening")) {
    // A deadline the connection itself set is the connection's fault, and the
    // remedy is to raise or drop that setting. Reporting it as a broken client
    // — "stop and report, nothing about your config is wrong" — is the exact
    // mirror of the confusion this categorisation exists to remove. Only a
    // deadline the caller did not choose per-connection is infrastructure.
    return msg.includes("deadline was set on this connection") ? "config_error" : "driver_open_timeout"
  }
  // "locked by another process" is the DuckDB driver's own wrapper. The second
  // clause is DuckDB's raw text ("Could not set lock on file …: Conflicting
  // lock is held"), matched here as well so a lock that reaches this function
  // unwrapped is still classified rather than falling through to "other". Both
  // halves of that clause are required: "could not set lock" on its own is
  // generic enough to appear in an unrelated remote error, and claiming it
  // would tell the user to close a local process over a remote fault.
  if (
    msg.includes("locked by another process") ||
    (msg.includes("could not set lock") && msg.includes("conflicting lock"))
  )
    return "store_locked"
  // altimate_change end
  if (msg.includes("password") || msg.includes("authentication") || msg.includes("unauthorized") || msg.includes("jwt"))
    return "auth_failed"
  if (msg.includes("timeout") || msg.includes("timed out")) return "timeout"
  if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("network")) return "network_error"
  if (msg.includes("config") || msg.includes("not found") || msg.includes("missing")) return "config_error"
  return "other"
}

// altimate_change start — distinguish infrastructure faults from config faults
/**
 * Categories where the fault is in this machine, not the connection's config
 * and not the remote warehouse. A caller cannot fix these by correcting
 * credentials, and a harness must not score them as a task failure.
 */
const INFRASTRUCTURE_CATEGORIES = new Set(["driver_missing", "driver_open_timeout", "store_locked"])

/**
 * The subset of the above that clears on its own once another process lets go.
 * Still infrastructure — nothing about the connection's config is wrong — but
 * the right response is to close the conflicting connection and retry, not to
 * stop and report a broken install.
 */
const RECOVERABLE_CATEGORIES = new Set(["store_locked"])

export function isInfrastructureFailure(category: string): boolean {
  return INFRASTRUCTURE_CATEGORIES.has(category)
}

export function isRecoverableFailure(category: string): boolean {
  return RECOVERABLE_CATEGORIES.has(category)
}
// altimate_change end

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
    throw new Error(`Connection "${name}" not found. Available: ${Array.from(configs.keys()).join(", ") || "(none)"}`)
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
          error: Telemetry.maskString(String(e)).slice(0, 500),
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
    const type = typeof config.type === "string" ? config.type.toLowerCase() : ""
    warehouses.push({
      name,
      type: config.type,
      database:
        type === "trino"
          ? ((config.catalog as string | undefined) ?? (config.database as string | undefined))
          : (config.database as string | undefined),
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

/** Test a connection by running a simple query. */
export async function test(
  name: string,
): Promise<{
  connected: boolean
  error?: string
  error_category?: string
  infrastructure?: boolean
  recoverable?: boolean
}> {
  try {
    const connector = await get(name)
    const config = configs.get(name)
    const dbType = config?.type?.toLowerCase()
    if (dbType === "mongodb" || dbType === "mongo") {
      // MongoDB doesn't support SQL — use the standard ping command
      await connector.execute(
        JSON.stringify({
          command: "ping",
        }),
      )
    } else {
      await connector.execute("SELECT 1")
    }
    return { connected: true }
  } catch (e) {
    // altimate_change start — report *why* the test failed, not just that it did
    const category = categorizeConnectionError(e)
    return {
      connected: false,
      error: String(e),
      error_category: category,
      infrastructure: isInfrastructureFailure(category),
      recoverable: isRecoverableFailure(category),
    }
    // altimate_change end
  }
}

/** Add a new connection and persist to global config. */
export async function add(
  name: string,
  config: ConnectionConfig,
): Promise<{ success: boolean; name: string; type: string; error?: string }> {
  try {
    ensureLoaded()

    // Normalize field names before saving so sensitive fields under alias
    // names (e.g., keyfileJson → credentials_json) are properly detected
    // altimate_change start — a relative store path means "relative to where
    // the user typed this"; persist it absolute so the saved global config is
    // not silently re-pointed by the next invocation's working directory.
    const normalized = resolveStorePaths({ [name]: normalizeConfig(config) }, projectRoot())[name]
    // altimate_change end

    // Store credentials in keychain, get sanitized config
    const { sanitized, warnings } = await saveConnection(name, normalized)

    // Save to global config file
    const globalPath = globalConfigPath()
    const dir = path.dirname(globalPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const existing = loadFromFile(globalPath)
    existing[name] = sanitized
    fs.writeFileSync(globalPath, JSON.stringify(existing, null, 2), "utf-8")

    // In-memory: keep normalized config (with credentials) so the current
    // session can connect even when keytar is unavailable. Only the disk
    // file uses the sanitized version (credentials stripped).
    configs.set(name, normalized)

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

    const result: { success: boolean; name: string; type: string; warnings?: string[] } = {
      success: true,
      name,
      type: config.type,
    }
    if (warnings.length > 0) {
      result.warnings = warnings
    }
    return result
  } catch (e) {
    return { success: false, name, type: config.type ?? "unknown", error: String(e) }
  }
}

/** Remove a connection from global config. */
export async function remove(name: string): Promise<{ success: boolean; error?: string }> {
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

// altimate_change start — a way to release native handles without reloading
/**
 * Close every cached connector and drop it from the cache.
 *
 * `reset()` cannot do this: it is synchronous, and `close()` is not. Callers
 * that create real connectors (tests, and `reload()` below) must await this,
 * otherwise the native handle behind each connector stays open — on Windows
 * that also blocks deleting the file underneath it.
 */
export async function closeAll(): Promise<void> {
  for (const [, connector] of connectors) {
    try {
      await connector.close()
    } catch {
      // ignore
    }
  }
  connectors.clear()
}
// altimate_change end

/** Reload all configs and clear cached connectors. */
export async function reload(): Promise<void> {
  await closeAll()
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
export function setConfigs(newConfigs: Record<string, ConnectionConfig>): void {
  configs.clear()
  for (const [name, config] of Object.entries(newConfigs)) {
    configs.set(name, config)
  }
  loaded = true
}
