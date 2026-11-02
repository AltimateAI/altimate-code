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
import { forgetCredentials, notRemovedWarning, resolveConfig, saveConnection } from "./credential-store"
// altimate_change start — the shared home, which honours the test-isolation override
import { Global } from "@/global"
// altimate_change end
// altimate_change start — tunnels are owned by the connect attempt that opened them; instance disposal hook
import { openTunnel, extractSshConfig, type TunnelHandle } from "./ssh-tunnel"
import { registerDisposer } from "@/effect/instance-registry"
// altimate_change end
import type { WarehouseInfo } from "../types"
import { Telemetry } from "../../../telemetry"
import * as SignInNotice from "./sign-in-notice"
import * as ReconnectLog from "./reconnect-log"
import { fileLog } from "@/altimate/util/file-log"
// altimate_change start — implicit session-scoped `scratch` warehouse
import { SCRATCH_CONFIG, SCRATCH_DESCRIPTION, SCRATCH_NAME, closeScratch, getScratch, isScratch } from "./scratch"
// altimate_change end

// altimate_change start — registry state per project directory
/**
 * One project's registry. A server serves several project directories from one process (each request carries its
 * own `Instance.directory`), so configs, connectors, in-flight connects and the load latch are kept per project:
 * project A never sees project B's project-local entries, and switching projects never closes another project's
 * connectors. The global file and `ALTIMATE_CODE_CONN_*` env are shared sources merged into each project's state.
 */
interface State {
  /** The project directory this state was loaded for. */
  dir: string
  /** In-memory config store. */
  configs: Map<string, ConnectionConfig>
  /** Cached connector instances. */
  connectors: Map<string, Connector>
  /** SSH tunnels of cached connectors, owned by the attempt that created each connector. */
  tunnels: Map<string, TunnelHandle>
  /** In-flight connects. An attempt is current only while it occupies its name's slot. */
  pending: Map<string, Attempt>
  /** Whether this state has been loaded from its sources. */
  loaded: boolean
}

/**
 * One connect attempt. Its SSH tunnel is its own handle, never looked up by name, so a superseded attempt can only
 * close the tunnel it opened. Dropping the attempt from `pending` (reload, remove, add, dispose, reset) closes that
 * tunnel and makes the attempt discard whatever it finishes creating.
 */
interface Attempt {
  promise?: Promise<Connector>
  tunnel?: TunnelHandle
}

function createState(dir: string): State {
  return { dir, configs: new Map(), connectors: new Map(), tunnels: new Map(), pending: new Map(), loaded: false }
}

/** Registry state per resolved project directory. */
const states = new Map<string, State>()

/** Invalidate the in-flight connect for `name`, closing the tunnel it opened. Synchronous. */
function dropAttempt(s: State, name: string): void {
  const attempt = s.pending.get(name)
  s.pending.delete(name)
  attempt?.tunnel?.close()
}

/** Synchronously detach the cached connector and tunnel for `name`; returns a task that closes them. */
function detachCached(s: State, name: string): () => Promise<void> {
  const connector = s.connectors.get(name)
  const tunnel = s.tunnels.get(name)
  s.connectors.delete(name)
  s.tunnels.delete(name)
  return async () => {
    // The tunnel is closed first so a hanging connector close cannot keep it open.
    tunnel?.close()
    await connector?.close().catch(() => {})
  }
}

let disposerRegistered = false
/**
 * Close a project's connectors, in-flight connects and tunnels when its instance is disposed (`/instance/dispose`,
 * config updates, reload). Its configs stay: they may hold session-only credentials from `warehouse_add` (no OS
 * credential store), which must last for the process, and a populated registry is never re-read anyway.
 */
function ensureDisposer(): void {
  if (disposerRegistered) return
  disposerRegistered = true
  registerDisposer(async (directory) => {
    const s = states.get(path.resolve(directory))
    if (s) await closeState(s)
  })
}

/**
 * Set by setConfigs() (tests, benchmarks): one injected registry that every project uses until reset() or load(),
 * so a test that injects outside an instance still sees its configs from inside one. load() only deactivates it,
 * so connectors it cached stay reachable by closeAll().
 */
let injectedState: State | undefined
let injectionActive = false

/** The registry state the current request uses: the injected one while active, else its project's. */
function state(): State {
  if (injectionActive && injectedState) return injectedState
  return projectState()
}

/** The registry state of the project the current request is working in. */
function projectState(): State {
  const dir = path.resolve(projectRoot())
  let s = states.get(dir)
  if (!s) {
    ensureDisposer()
    s = createState(dir)
    states.set(dir, s)
  }
  return s
}

/** Every state that may hold connectors, for process-wide teardown. */
function allStates(): State[] {
  return injectedState ? [...states.values(), injectedState] : [...states.values()]
}
// altimate_change end

const SCRATCH_NAME_CONFLICT =
  `Connection "${SCRATCH_NAME}" conflicts with the reserved built-in scratch warehouse name. ` +
  'Rename its connection key to another name (for example "source_scratch") in ' +
  '~/.altimate-code/connections.json or the project .altimate-code/connections.json, ' +
  'or rename ALTIMATE_CODE_CONN_SCRATCH to ALTIMATE_CODE_CONN_SOURCE_SCRATCH, then reload connections.'

// ---------------------------------------------------------------------------
// Config file paths
// ---------------------------------------------------------------------------

export function globalConfigPath(): string {
  // altimate_change start — the same home Global.Path uses, so the test preload's OPENCODE_TEST_HOME keeps the
  // suite out of the developer's real connections (Bun caches os.homedir(), so changing HOME does not).
  return path.join(Global.Path.home, ".altimate-code", "connections.json")
  // altimate_change end
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
 * It is also the key of the per-project registry state (see `state()`).
 */
function projectRoot(): string {
  try {
    return Instance.directory
  } catch {
    return process.cwd()
  }
}
// altimate_change end

export function localConfigPath(): string {
  // altimate_change start — resolve against the project, not the launch cwd
  return localConfigPathFor(projectRoot())
  // altimate_change end
}

// altimate_change start — one definition of a project's connections file
function localConfigPathFor(projectDir: string): string {
  return path.join(projectDir, ".altimate-code", "connections.json")
}
// altimate_change end

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

// altimate_change start — exported so user-facing hints name the variable the loader reads
export const CONN_ENV_PREFIX = "ALTIMATE_CODE_CONN_"
// altimate_change end

function loadFromEnv(): Record<string, ConnectionConfig> {
  const result: Record<string, ConnectionConfig> = {}
  const prefix = CONN_ENV_PREFIX

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

// altimate_change start — load into one project's state
/** Read the sources into `s`. Local overrides global; env overrides both. */
function loadInto(s: State): void {
  const configs = s.configs
  configs.clear()

  // absolutize store paths against the directory that declared them, so a later process.chdir() (--dir) cannot
  // move the store. `s.dir` is the project this state belongs to.
  const base = s.dir
  const global = resolveStorePaths(loadFromFile(globalConfigPath()), path.dirname(globalConfigPath()))
  const local = resolveStorePaths(loadFromFile(localConfigPathFor(base)), base)
  const env = resolveStorePaths(loadFromEnv(), base)

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

  if (configs.has(SCRATCH_NAME)) Log.Default.warn(SCRATCH_NAME_CONFLICT)
  s.loaded = true
}

/** Load the current project's connection configs from their sources, ending any setConfigs() injection. */
export function load(): void {
  injectionActive = false
  loadInto(projectState())
}

/**
 * Load only an explicit connections file (`mcp serve --connections`), resolving stores relative to that file. Like
 * setConfigs(), the file becomes the one registry every project uses and is never re-read from project sources.
 */
export async function loadFile(file: string): Promise<void> {
  await closeAll()
  const absolute = path.resolve(file)
  const parsed: unknown = JSON.parse(await fs.promises.readFile(absolute, "utf8"))
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Connections file must contain an object keyed by connection name")
  }
  for (const [name, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || typeof value.type !== "string") {
      throw new Error(`Invalid connection: ${name}`)
    }
  }
  setConfigs(resolveStorePaths(parsed as Record<string, ConnectionConfig>, path.dirname(absolute)))
  if (state().configs.has(SCRATCH_NAME)) Log.Default.warn(SCRATCH_NAME_CONFLICT)
  censusSent = false
}

/** Ensure the current project's configs are loaded; returns its state. */
function ensureLoaded(): State {
  const s = state()
  if (!s.loaded) loadInto(s)
  // A connections file created after an empty answer (the `warehouse_list` hint) must be seen. Re-read only while
  // this project's registry is empty: there is nothing to replace or close, and a populated registry never changes
  // under a running session. An injected registry (setConfigs) is never re-read.
  else if (s.configs.size === 0 && s !== injectedState) loadInto(s)
  return s
}
// altimate_change end

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
export function canonicalType(type: unknown): string | null {
  // A hand-edited connection may carry a non-string type; it maps to no driver rather than throwing.
  if (typeof type !== "string" || !type) return null
  const driverPath = DRIVER_MAP[type.toLowerCase()]
  if (!driverPath) return null
  return driverPath.slice(driverPath.lastIndexOf("/") + 1)
}
// altimate_change end

// altimate_change start — the attempt owns the SSH tunnel it opens
const SUPERSEDED = (name: string) =>
  new Error(`Connection "${name}" was reloaded or removed while it was connecting. Retry the request.`)

async function createConnector(
  name: string,
  config: ConnectionConfig,
  attempt: Attempt,
  isCurrent: () => boolean,
): Promise<Connector> {
  // altimate_change end
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
    // altimate_change start — a superseded attempt opens nothing; a tunnel that finishes opening after its attempt
    // was dropped is closed by its own handle (dropAttempt closed it already) and never published
    if (!isCurrent()) throw SUPERSEDED(name)
    attempt.tunnel = openTunnel(sshConfig)
    const tunnelInfo = await attempt.tunnel.ready
    if (!isCurrent()) {
      attempt.tunnel.close()
      throw SUPERSEDED(name)
    }
    // altimate_change end
    // Rewrite host/port to use the local tunnel
    resolvedConfig = {
      ...resolvedConfig,
      host: "127.0.0.1",
      port: tunnelInfo.localPort,
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
    // altimate_change start — this attempt's own tunnel, never another attempt's
    attempt.tunnel?.close()
    // altimate_change end
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
  // altimate_change start — the driver's own wording for an SSO sign-in nobody
  // completed and for a login that never answered; both also contain words the
  // generic rules below match ("network", "sign-in"), and mean something else.
  if (msg.includes("browser sign-in") && msg.includes("was not completed")) return "sso_not_completed"
  if (msg.includes("did not accept the connection")) return "connect_timeout"
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

// altimate_change start — the account a sign-in notice is reported under (see SignInNotice.rememberOrigin)
function accountOf(config: ConnectionConfig | undefined): string {
  return typeof config?.account === "string" ? config.account : ""
}
// altimate_change end

// altimate_change start — connection names without the census `list()` sends (used by `debug bundle`)
export function names(): string[] {
  return [...ensureLoaded().configs.keys()]
}
// altimate_change end

/** Get a connector instance (creates lazily). */
export async function get(name: string): Promise<Connector> {
  // altimate_change start — captured once, so a connect that finishes later lands in the project that started it
  const s = ensureLoaded()
  const { configs, connectors, tunnels, pending } = s
  // altimate_change end
  if (isScratch(name)) {
    if (configs.has(name)) throw new Error(SCRATCH_NAME_CONFLICT)
    return getScratch()
  }

  const cached = connectors.get(name)
  if (cached) {
    // altimate_change start — a reused connection can reconnect and ask for a browser sign-in; route it here
    SignInNotice.rememberOrigin(accountOf(configs.get(name)))
    // altimate_change end
    return cached
  }

  // If a connector is already being created, await the same Promise
  // altimate_change start — the slot holds the attempt
  const inflight = pending.get(name)?.promise
  if (inflight) return inflight
  // altimate_change end

  const config = configs.get(name)
  if (!config) {
    throw new Error(`Connection "${name}" not found. Available: ${Array.from(configs.keys()).join(", ") || "(none)"}`)
  }

  const startTime = Date.now()
  const authMethod = detectAuthMethod(config)
  // altimate_change start — make connection attempts visible. Recorded BEFORE
  // connecting: an attempt that hangs or takes the process down never reaches
  // the outcome event below, so without this it leaves no trace at all.
  SignInNotice.install()
  SignInNotice.rememberOrigin(accountOf(config))
  ReconnectLog.install()
  ReconnectLog.remember(accountOf(config), name)
  fileLog("INFO", "warehouse-connect", "connecting", { name, type: config.type, auth: authMethod })
  try {
    Telemetry.track({
      type: "warehouse_connect_started",
      timestamp: startTime,
      session_id: Telemetry.getContext().sessionId,
      warehouse_type: config.type ?? "unknown",
      auth_method: authMethod,
    })
  } catch {}
  // altimate_change end
  // altimate_change start — this attempt occupies the slot before any await; reload()/remove()/add()/dispose drop it
  const attempt: Attempt = {}
  pending.set(name, attempt)
  const current = () => pending.get(name) === attempt
  // altimate_change end
  const promise = (async () => {
    try {
      // altimate_change start — the attempt closes only the tunnel it opened
      const connector = await createConnector(name, config, attempt, current)
      try {
        await connector.connect()
      } catch (connectErr) {
        // If connect() fails after tunnel was started, clean up the tunnel (first, so a hanging close cannot hold it)
        attempt.tunnel?.close()
        await connector.close().catch(() => {})
        throw connectErr
      }
      // reload()/remove()/add() dropped this attempt while it was connecting: its config is gone or replaced, so
      // it must not be cached over the current one.
      if (!current()) {
        attempt.tunnel?.close()
        await connector.close().catch(() => {})
        throw SUPERSEDED(name)
      }
      connectors.set(name, connector)
      if (attempt.tunnel) tunnels.set(name, attempt.tunnel)
      // altimate_change end
      fileLog("INFO", "warehouse-connect", "connected", { name, type: config.type, auth: authMethod, duration_ms: Date.now() - startTime })
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
    } catch (caught) {
      // altimate_change start — an attempt dropped by reload/remove/add/dispose fails with whatever its closed tunnel
      // or socket raised; report it as superseded (with the retry hint), not as a broken connection
      const e = current() ? caught : SUPERSEDED(name)
      // altimate_change end
      fileLog("WARN", "warehouse-connect", "connect failed", {
        name,
        type: config?.type,
        auth: authMethod,
        duration_ms: Date.now() - startTime,
        category: categorizeConnectionError(e),
        error: Telemetry.maskString(String(e)).slice(0, 500),
      })
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
      // altimate_change start — a newer attempt for this name may already own the slot
      if (current()) pending.delete(name)
      // altimate_change end
    }
  })()

  // altimate_change start
  attempt.promise = promise
  // altimate_change end
  return promise
}

/** Whether a one-time warehouse census has been sent this session. */
let censusSent = false

/** List all configured connections. */
export function list(): { warehouses: (WarehouseInfo & { conflict?: string })[] } {
  // altimate_change start — the current project's registry
  const { configs } = ensureLoaded()
  // altimate_change end
  const warehouses: (WarehouseInfo & { conflict?: string })[] = []
  for (const [name, config] of configs) {
    const type = typeof config.type === "string" ? config.type.toLowerCase() : ""
    warehouses.push({
      name,
      type: config.type,
      database:
        type === "trino"
          ? ((config.catalog as string | undefined) ?? (config.database as string | undefined))
          : (config.database as string | undefined),
      ...(isScratch(name) ? { conflict: SCRATCH_NAME_CONFLICT } : {}),
    })
  }

  // altimate_change start — surface the implicit scratch warehouse. Appended LAST and only when a real
  // warehouse exists, so `list()[0]` (the default-warehouse convention) and the "nothing configured"
  // states are unchanged for every caller.
  if (warehouses.length > 0 && !configs.has(SCRATCH_NAME)) {
    warehouses.push({ name: SCRATCH_NAME, type: SCRATCH_CONFIG.type, database: SCRATCH_DESCRIPTION })
  }
  // altimate_change end

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
    // altimate_change start — the same project's state get() used
    const s = state()
    const connector = await get(name)
    const config = s.configs.get(name)
    // altimate_change end
    const dbType = config?.type?.toLowerCase()
    if (dbType === "mongodb" || dbType === "mongo") {
      // MongoDB doesn't support SQL — use the standard ping command
      await connector.execute(
        JSON.stringify({
          command: "ping",
        }),
      )
    } else {
      await connector.execute(
        "SELECT 1", undefined, undefined,
        canonicalType(dbType) === "postgres" ? { readOnly: true } : undefined,
      )
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
): Promise<{ success: boolean; name: string; type: string; error?: string; warnings?: string[] }> {
  // altimate_change start — `scratch` is reserved for the implicit session warehouse
  if (isScratch(name)) {
    return { success: false, name, type: config?.type ?? "unknown", error: `"${SCRATCH_NAME}" is a reserved warehouse name.` }
  }
  // altimate_change end
  try {
    // altimate_change start — act on the current project's state, captured before any await
    const s = ensureLoaded()
    const { configs } = s
    // altimate_change end

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

    // altimate_change start — only now that the new config is on disk: drop secrets an earlier config under this
    // name stored and this one no longer uses (an old private key would outrank a new sign-in method).
    const notRemoved = await forgetCredentials(name, normalized)
    if (notRemoved.length > 0) warnings.push(notRemovedWarning(name, notRemoved))
    // altimate_change end

    // In-memory: keep normalized config (with credentials) so the current
    // session can connect even when keytar is unavailable. Only the disk
    // file uses the sanitized version (credentials stripped).
    configs.set(name, normalized)
    // altimate_change start — in the same synchronous step: a connect still in flight for the old config must not be
    // cached over the new one, and the old connector's tunnel closes with it
    dropAttempt(s, name)
    const release = detachCached(s, name)
    await release()
    // altimate_change end

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
export async function remove(name: string): Promise<{ success: boolean; error?: string; warnings?: string[] }> {
  // altimate_change start
  if (isScratch(name)) return { success: false, error: `"${SCRATCH_NAME}" is built in and cannot be removed.` }
  // altimate_change end
  try {
    // altimate_change start — act on the current project's state, captured before any await
    const s = ensureLoaded()
    // A connect still in flight for this name will finish and keep its name in use; forgetting it now would let a
    // later reconnect on that account be put down to another connection that shares it.
    const inflight = s.pending.has(name)
    const projectConfigPath = localConfigPath()
    // One synchronous step before any await. The global file is written first, so a failed write leaves this
    // project's state untouched. Then the in-flight connect is invalidated (and its tunnel closed), the config is
    // gone so no connect or empty-registry re-read can bring it back, and the cached connector and tunnel are
    // detached. Only a file that holds the entry is rewritten (a missing global directory is not an error).
    const globalPath = globalConfigPath()
    const existing = loadFromFile(globalPath)
    if (Object.hasOwn(existing, name)) {
      delete existing[name]
      fs.writeFileSync(globalPath, JSON.stringify(existing, null, 2), "utf-8")
    }
    dropAttempt(s, name)
    s.configs.delete(name)
    const release = detachCached(s, name)
    await release()
    if (!inflight) ReconnectLog.forget(name)
    // altimate_change end

    // altimate_change start — remove its secrets from the OS credential store too. Entries are keyed by name
    // only, so they are kept while an env var or the local config of a project this process serves still defines a
    // connection by that name (see forgetCredentials); the served set is read now, after the awaits above. (Own
    // properties only: a connection named "constructor" must not count as defined.)
    // Open instances may not have performed a warehouse operation yet, so states alone is incomplete.
    const projectDirs = new Set([...states.keys(), ...Instance.directories()])
    const projectConfigPaths = [projectConfigPath, ...[...projectDirs].map(localConfigPathFor)]
    const stillDefined =
      projectConfigPaths.some((file) => Object.hasOwn(loadFromFile(file), name)) || Object.hasOwn(loadFromEnv(), name)
    const notRemoved = stillDefined ? [] : await forgetCredentials(name)
    if (notRemoved.length > 0) return { success: true, warnings: [notRemovedWarning(name, notRemoved)] }
    // altimate_change end

    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

// altimate_change start — a way to release native handles without reloading
/** Close one project's cached connectors and their SSH tunnels, and drop its in-flight connects. */
async function closeState(s: State): Promise<void> {
  // Detach everything synchronously, so nothing started during the awaits below is dropped or reuses a closing
  // connector. In-flight attempts are invalidated and their tunnels closed by their own handles.
  for (const name of [...s.pending.keys()]) dropAttempt(s, name)
  const releases = [...s.connectors.keys()].map((name) => detachCached(s, name))
  // Started together: each release closes its tunnel synchronously, so one hanging connector close holds no tunnel.
  await Promise.all(releases.map((release) => release()))
}

/**
 * Close every project's cached connectors (and the scratch warehouse) and drop them from the cache — process-wide
 * teardown.
 *
 * `reset()` cannot do this: it is synchronous, and `close()` is not. Callers
 * that create real connectors (tests) must await this,
 * otherwise the native handle behind each connector stays open — on Windows
 * that also blocks deleting the file underneath it.
 */
export async function closeAll(): Promise<void> {
  await closeScratch()
  for (const s of allStates()) await closeState(s)
}
// altimate_change end

/** Reload the current project's configs and clear its cached connectors; other projects are untouched. */
export async function reload(): Promise<void> {
  // altimate_change start — only this project's connectors. The new configs are in place before the first await,
  // so no connect can start against the old ones while the old connectors close.
  const s = state()
  const target = projectState()
  const closing = closeState(s)
  injectionActive = false
  loadInto(target)
  await closing
  // altimate_change end
}

/** Get the raw config for a connection (for testing). */
export function getConfig(name: string): ConnectionConfig | undefined {
  // altimate_change start — the current project's registry
  const { configs } = ensureLoaded()
  // altimate_change end
  if (isScratch(name) && !configs.has(name)) return { ...SCRATCH_CONFIG }
  return configs.get(name)
}

/** Reset the registry state of every project (for testing). */
export function reset(): void {
  // altimate_change start — invalidate in-flight connects first, so none is cached into a dropped state
  for (const s of allStates()) for (const name of [...s.pending.keys()]) dropAttempt(s, name)
  states.clear()
  injectedState = undefined
  injectionActive = false
  // altimate_change end
  censusSent = false
}

/**
 * Set configs directly (for testing without file system). Every project uses them until reset() or load().
 */
export function setConfigs(newConfigs: Record<string, ConnectionConfig>): void {
  // altimate_change start — one injected state shared by every project; its cached connectors are kept, as before
  injectedState ??= createState("")
  injectionActive = true
  const configs = injectedState.configs
  // altimate_change end
  configs.clear()
  for (const [name, config] of Object.entries(newConfigs)) {
    configs.set(name, config)
  }
  // altimate_change start
  injectedState.loaded = true
  // altimate_change end
}
