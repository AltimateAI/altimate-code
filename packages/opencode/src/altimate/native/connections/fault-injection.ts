/**
 * Fault-injection orchestrator — runs the cooperative Rust state machine
 * (`FaultInjectionSession`) against a sandbox copy of a dbt project's warehouse.
 *
 * The Rust engine never touches a database or dbt. It emits one action at a
 * time — run this SQL, prepare a sandbox, rebuild these models, run these tests
 * — and this file performs it and steps the engine with the result. Same shape
 * as `data-diff.ts`, with dbt and a sandbox added.
 *
 * Safety contract: nothing here writes to the user's database, dbt `target/`
 * or `logs/`. Everything runs on copies inside a work directory that is removed
 * on success, failure and interrupt.
 *
 * Engine loading: production uses the `@altimateai/altimate-core` package.
 * DEVELOPMENT ONLY: set `ALTIMATE_CORE_DEV_PATH` to a locally built
 * altimate-core Node binding (the `crates/altimate-core-node` directory, its
 * `index.js`, or the `.node` file) to run against an unpublished engine. The
 * override is honoured by local and branch builds only; a published release ignores it.
 */

import * as fs from "fs"
import * as fsp from "fs/promises"
import * as os from "os"
import * as path from "path"
import { spawn } from "child_process"
import { createRequire } from "module"
import type { Connector } from "@altimateai/drivers/types"
import { InstallationChannel, isPublishableChannel } from "@opencode-ai/core/installation/version"
import type {
  DbtFaultInjectionParams,
  DbtFaultInjectionProgress,
  DbtFaultInjectionResult,
  FaultInjectionNodeInfo,
} from "../types"

// ---------------------------------------------------------------------------
// Engine protocol (mirrors crates/altimate-core/src/fault_injection/types.rs)
// ---------------------------------------------------------------------------

export type SqlTarget = "Baseline" | "Sandbox"

export interface FaultSqlTask {
  id: string
  target: SqlTarget
  sql: string
  expected_shape: "SingleRow" | "RowSet" | "Statement"
}

export type FaultAction =
  | {
      type: "ExecuteSql"
      id: string
      phase: string
      producer_id?: string
      fault_id?: string
      sequential: boolean
      tasks: FaultSqlTask[]
    }
  | { type: "PrepareSandbox"; id: string; purpose: "control" | "fault"; producer_id: string; fault_id?: string }
  | {
      type: "RebuildNodes"
      id: string
      producer_id: string
      fault_id?: string
      node_ids: string[]
      select: string[]
      exclude: string[]
      full_refresh: boolean
    }
  | { type: "RunTests"; id: string; producer_id: string; fault_id?: string; test_ids: string[]; select: string[] }
  | { type: "Done"; report: Record<string, any> }
  | { type: "Error"; message: string }

export type PerformableAction = Exclude<FaultAction, { type: "Done" } | { type: "Error" }>

export interface FaultSqlResponse {
  id: string
  rows?: (string | null)[][]
  error?: string
  relation_missing?: boolean
}

export interface NodeStatus {
  unique_id: string
  status: string
}

export type FaultStepResult =
  | { type: "Sql"; id: string; responses: FaultSqlResponse[] }
  | { type: "Ok"; id: string }
  | { type: "NodeResults"; id: string; results: NodeStatus[] }
  | { type: "Failed"; id: string; message: string; timed_out?: boolean }

export interface RelationColumns {
  database?: string
  schema: string
  name: string
  relation_type: "table" | "view"
  columns: Array<{ name: string; data_type: string }>
}

/** The NAPI class, reduced to what the driver calls. JSON strings in and out. */
export interface FaultInjectionSessionLike {
  start(): string
  step(resultJson: string): string
  report(): string
}

export type FaultInjectionSessionCtor = new (specJson: string) => FaultInjectionSessionLike

// ---------------------------------------------------------------------------
// Engine loading
// ---------------------------------------------------------------------------

/**
 * First `@altimateai/altimate-core` release that exports `FaultInjectionSession`.
 * The class was added after 0.7.0; update this if the release that ships it is
 * numbered differently.
 */
export const FAULT_INJECTION_MIN_CORE_VERSION = "0.8.0"

/** Development-only override: path to a locally built altimate-core Node binding. */
export const CORE_DEV_PATH_ENV = "ALTIMATE_CORE_DEV_PATH"

export interface LoadedEngine {
  Session: FaultInjectionSessionCtor
  /** "package" in production; "dev-override" when ALTIMATE_CORE_DEV_PATH is set. */
  source: "package" | "dev-override"
  path?: string
}

function installedCoreVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    return require("@altimateai/altimate-core/package.json").version as string
  } catch {
    return undefined
  }
}

/**
 * Load `FaultInjectionSession`. Throws an Error whose message is meant for the
 * user; never crashes the process.
 */
export async function loadFaultInjectionEngine(
  env: NodeJS.ProcessEnv = process.env,
  // Published releases ("latest", "beta") never honour the override; local and branch builds do.
  allowDevOverride: boolean = !isPublishableChannel(InstallationChannel),
  importCore: () => Promise<unknown> = () => import("@altimateai/altimate-core"),
): Promise<LoadedEngine> {
  const override = env[CORE_DEV_PATH_ENV]
  // Loading a native addon from a path in the environment is for development builds only.
  if (override && allowDevOverride) {
    const resolved = path.resolve(override)
    let entry = resolved
    try {
      if (fs.statSync(resolved).isDirectory()) entry = path.join(resolved, "index.js")
    } catch {
      throw new Error(`${CORE_DEV_PATH_ENV} points at "${resolved}", which does not exist.`)
    }
    let mod: any
    try {
      mod = createRequire(import.meta.url)(entry)
    } catch (e) {
      throw new Error(`${CORE_DEV_PATH_ENV}: could not load "${entry}": ${errorText(e)}`)
    }
    const Session = mod?.FaultInjectionSession
    if (typeof Session !== "function") {
      throw new Error(`${CORE_DEV_PATH_ENV}: "${entry}" does not export FaultInjectionSession.`)
    }
    return { Session, source: "dev-override", path: entry }
  }

  let core: any
  try {
    core = await importCore()
  } catch (e) {
    throw new Error(`altimate-core NAPI module unavailable: ${errorText(e)}`)
  }
  const Session = core?.FaultInjectionSession ?? core?.default?.FaultInjectionSession
  if (typeof Session !== "function") {
    const installed = installedCoreVersion()
    throw new Error(
      `Fault injection needs @altimateai/altimate-core ${FAULT_INJECTION_MIN_CORE_VERSION} or newer` +
        ` (the installed version${installed ? `, ${installed},` : ""} has no FaultInjectionSession).` +
        ` Upgrade altimate-code to a release that bundles it.` +
        (override ? ` ${CORE_DEV_PATH_ENV} is set but a published release does not honour it.` : ""),
    )
  }
  return { Session, source: "package" }
}

let engineAvailability: Promise<boolean> | undefined

/**
 * Whether the engine provides `FaultInjectionSession`. Cached so the native module
 * is loaded once; an injected loader bypasses the cache. Never throws.
 */
export function isFaultInjectionEngineAvailable(load?: typeof loadFaultInjectionEngine): Promise<boolean> {
  if (load) return load().then(() => true, () => false)
  engineAvailability ??= loadFaultInjectionEngine().then(() => true, () => false)
  return engineAvailability
}

/** Test hook: forget the cached availability result. */
export function resetFaultInjectionEngineAvailability(): void {
  engineAvailability = undefined
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export class FaultInjectionInterrupted extends Error {
  constructor() {
    super("interrupted")
    this.name = "FaultInjectionInterrupted"
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new FaultInjectionInterrupted()
}

/**
 * Render one driver value as exact text. Checksums are HUGEINT and arrive as
 * BigInt — `toString()` keeps every digit, `Number()` would not.
 */
export function renderValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === "string") return value
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

const ERROR_TEXT_LIMIT = 500

// ---------------------------------------------------------------------------
// Sandbox strategy — one per warehouse
// ---------------------------------------------------------------------------

/**
 * Everything warehouse-specific: how the baseline and the sandbox come to be,
 * how SQL reaches each, and how dbt is pointed at them. DuckDB copies a file;
 * a cloud warehouse would clone a schema or database.
 */
export interface SandboxStrategy {
  /** dbt adapter type this strategy serves. */
  readonly warehouse: string
  /** `SqlDialect` name passed to the engine. */
  readonly dialect: string
  /** The user's database, which is never written. For messages. */
  readonly original: string
  /**
   * Create the baseline copy and the dbt profiles for both copies. Must throw
   * unless it can establish that everything dbt and this process will write is
   * a copy.
   */
  setup(): Promise<void>
  /** Directory holding the `profiles.yml` that points dbt at `target`. */
  profilesDir(target: SqlTarget): string
  /**
   * Throw when the parsed project would visibly read or write something other
   * than the copied warehouse. Called before anything is built.
   */
  assertManifestIsolated(manifest: Record<string, any>): void
  /** Run one statement and return the driver's rows. */
  execute(target: SqlTarget, sql: string): Promise<unknown[][]>
  /** True when the error is a catalog error: a relation the query reads does not exist. */
  isRelationMissing(error: unknown): boolean
  /** Columns of every relation in the baseline, in ordinal order. */
  listRelations(): Promise<RelationColumns[]>
  /** Discard any previous sandbox and make a fresh copy of the baseline. */
  prepareSandbox(): Promise<void>
  /** Drop every handle this process holds on `target`, so dbt can open it. */
  release(target: SqlTarget): Promise<void>
  /**
   * Whether the user's database still looks as it did before the run. "unknown"
   * when the run ended before it was first examined.
   */
  verifyOriginalUntouched(): Promise<{ status: "unchanged" | "unknown" } | { status: "changed"; detail: string }>
  /** Close connections. The work directory is removed by the caller. */
  close(): Promise<void>
}

export interface SandboxContext {
  /** The user's project directory; relative database paths resolve against it. */
  projectDir: string
  /** Scratch directory owned by this run. */
  workDir: string
  profileName: string
  targetName: string
  /** The selected output of the user's profile, env_var() already resolved where possible. */
  output: Record<string, unknown>
  /** The same output exactly as written in profiles.yml. */
  rawOutput: Record<string, unknown>
}

type SandboxFactory = (ctx: SandboxContext) => SandboxStrategy

const SANDBOX_STRATEGIES: Record<string, SandboxFactory> = {
  duckdb: (ctx) => new DuckDbSandbox(ctx),
}

/** Warehouses fault injection can sandbox today. */
export function supportedWarehouses(): string[] {
  return Object.keys(SANDBOX_STRATEGIES)
}

/** Resolve the strategy for a dbt adapter type, or throw before any work is done. */
export function resolveSandboxFactory(adapterType: string): SandboxFactory {
  const factory = SANDBOX_STRATEGIES[adapterType.toLowerCase()]
  if (!factory) {
    throw new Error(
      `Fault injection does not support ${adapterType} yet. It currently works on ` +
        `${supportedWarehouses().join(", ")} projects only, because it needs a private copy of the warehouse to corrupt.`,
    )
  }
  return factory
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function sqlIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** Profile keys that make dbt-duckdb read or write something other than the one database file. */
const DUCKDB_UNSAFE_PROFILE_KEYS = ["attach", "plugins", "remote", "is_ducklake"]

/**
 * DuckDB: the baseline and the sandbox are file copies.
 *
 * Both copies keep the original file name, each in its own directory, because
 * DuckDB names the catalog after the file and compiled dbt SQL carries that
 * catalog name.
 *
 * This process never opens a copy directly. Each side has an in-memory DuckDB
 * that ATTACHes the file and DETACHes it again before dbt runs. DETACH releases
 * the file lock immediately; closing a node-duckdb handle only releases it when
 * the handle is garbage collected, which is too late for the dbt process that
 * needs the file next.
 */
export class DuckDbSandbox implements SandboxStrategy {
  readonly warehouse = "duckdb"
  readonly dialect = "duckdb"
  readonly original: string

  private readonly fileName: string
  private readonly catalog: string
  private readonly baselinePath: string
  private readonly sandboxPath: string
  private readonly connectors: Partial<Record<SqlTarget, Connector>> = {}
  private readonly attached: Record<SqlTarget, boolean> = { Baseline: false, Sandbox: false }
  private originalStat?: { size: number; mtimeMs: number }

  constructor(private readonly ctx: SandboxContext) {
    const configured = ctx.output.path
    if (typeof configured !== "string" || configured === "") {
      throw new Error(`The dbt target "${ctx.targetName}" has no DuckDB "path"; nothing to copy.`)
    }
    if (configured.includes("{{")) {
      throw new Error(
        `Could not resolve the DuckDB path of dbt target "${ctx.targetName}" ("${configured}"). ` +
          `Set the environment variables it reads and retry.`,
      )
    }
    if (configured === ":memory:" || /^(md|motherduck):/i.test(configured) || /^[a-z][a-z0-9+.-]*:\/\//i.test(configured)) {
      throw new Error(
        `Refusing to run: the dbt target "${ctx.targetName}" uses "${configured}", which is not a local DuckDB file ` +
          `that can be copied. Fault injection only runs on a copy.`,
      )
    }
    for (const key of DUCKDB_UNSAFE_PROFILE_KEYS) {
      const value = ctx.rawOutput[key]
      const empty = value === undefined || value === null || value === false || (Array.isArray(value) && value.length === 0)
      if (!empty) {
        throw new Error(
          `Refusing to run: the dbt target "${ctx.targetName}" sets "${key}", so dbt would reach data outside ` +
            `the database file and fault injection cannot establish that it only touches a copy.`,
        )
      }
    }
    // dbt-duckdb resolves a relative path against the directory dbt runs in.
    this.original = path.resolve(ctx.projectDir, configured)
    this.fileName = path.basename(this.original)
    // dbt-duckdb calls the database after the file (minus its extension) unless the profile names it.
    const named = ctx.output.database
    this.catalog = typeof named === "string" && named !== "" ? named : this.fileName.replace(/\.[^.]*$/, "")
    if (["memory", "temp", "system"].includes(this.catalog.toLowerCase())) {
      throw new Error(
        `Refusing to run: a DuckDB database called "${this.catalog}" collides with a catalog DuckDB reserves, ` +
          `so the copy cannot be attached under the name the compiled SQL uses. Rename ${this.fileName}.`,
      )
    }
    this.baselinePath = path.join(ctx.workDir, "baseline", this.fileName)
    this.sandboxPath = path.join(ctx.workDir, "sandbox", this.fileName)
  }

  profilesDir(target: SqlTarget): string {
    return path.join(this.ctx.workDir, target === "Baseline" ? "profiles-baseline" : "profiles-sandbox")
  }

  assertManifestIsolated(manifest: Record<string, any>): void {
    const enabled = (node: any) => node?.config?.enabled !== false
    const nodes = Object.values<any>(manifest.nodes ?? {}).filter(enabled)
    const refuse = (what: string, names: string[]) =>
      new Error(
        `Refusing to run: ${what} (${names.slice(0, 5).join(", ")}${names.length > 5 ? ", ..." : ""}). ` +
          `Fault injection cannot establish that this would only touch the copy of the database.`,
      )

    const external = nodes.filter((n) => n.resource_type === "model" && n.config?.materialized === "external")
    if (external.length > 0) {
      throw refuse(
        `${external.length} model(s) use the "external" materialization, which writes files outside the database`,
        external.map((n) => n.name),
      )
    }

    // Everything dbt builds or reads must live in the one database that was copied.
    const elsewhere = [...nodes, ...Object.values<any>(manifest.sources ?? {}).filter(enabled)].filter(
      (n) =>
        ["model", "seed", "snapshot", "source"].includes(n.resource_type) &&
        typeof n.database === "string" &&
        n.database !== "" &&
        n.database.toLowerCase() !== this.catalog.toLowerCase(),
    )
    if (elsewhere.length > 0) {
      throw refuse(
        `${elsewhere.length} relation(s) live in a database other than "${this.catalog}"`,
        elsewhere.map((n) => `${n.name} in ${n.database}`),
      )
    }

    // Hooks and on-run-start/end operations are the usual way to reach outside the database.
    const reachesOutside = /\b(attach|copy|export\s+database)\b/i
    const hookSql = (n: any): string[] =>
      [...(n.config?.["pre-hook"] ?? []), ...(n.config?.["post-hook"] ?? [])].map((h: any) =>
        typeof h === "string" ? h : String(h?.sql ?? ""),
      )
    const risky = nodes.filter((n) =>
      n.resource_type === "operation"
        ? reachesOutside.test(String(n.raw_code ?? n.raw_sql ?? ""))
        : hookSql(n).some((sql) => reachesOutside.test(sql)),
    )
    if (risky.length > 0) {
      throw refuse(
        `${risky.length} hook(s) run ATTACH, COPY or EXPORT DATABASE, which can read or write files outside the database`,
        risky.map((n) => n.name),
      )
    }
  }

  private copyPath(target: SqlTarget): string {
    return target === "Baseline" ? this.baselinePath : this.sandboxPath
  }

  async setup(): Promise<void> {
    let stat: fs.Stats
    try {
      stat = await fsp.stat(this.original)
    } catch {
      throw new Error(
        `DuckDB file not found: ${this.original}. Build the project first (dbt build) so there is a database to copy.`,
      )
    }
    if (!stat.isFile()) throw new Error(`DuckDB path is not a file: ${this.original}`)
    if (fs.existsSync(`${this.original}.wal`)) {
      throw new Error(
        `Refusing to run: ${this.original}.wal exists, so the database has uncommitted changes or is open in ` +
          `another process. Close it and retry; a copy taken now could be inconsistent.`,
      )
    }
    this.originalStat = { size: stat.size, mtimeMs: stat.mtimeMs }

    await fsp.mkdir(path.dirname(this.baselinePath), { recursive: true })
    await fsp.mkdir(path.dirname(this.sandboxPath), { recursive: true })
    await fsp.copyFile(this.original, this.baselinePath, fs.constants.COPYFILE_FICLONE)
    await this.assertIsCopy(this.baselinePath)

    for (const target of ["Baseline", "Sandbox"] as const) {
      await this.writeProfile(target)
    }

    // Fail now, not after a baseline build, if the driver is missing or cannot read the file.
    await this.execute("Baseline", "SELECT 1")
    await this.release("Baseline")
  }

  /** Throw unless `copy` is a distinct file inside the work directory. */
  private async assertIsCopy(copy: string): Promise<void> {
    const refuse = (why: string) =>
      new Error(`Refusing to run: cannot establish that ${copy} is a private copy of ${this.original} (${why}).`)
    const [work, realCopy, realOriginal] = await Promise.all([
      fsp.realpath(this.ctx.workDir),
      fsp.realpath(copy),
      fsp.realpath(this.original),
    ])
    if (realCopy === realOriginal) throw refuse("both resolve to the same path")
    if (!realCopy.startsWith(work + path.sep)) throw refuse("the copy is outside the work directory")
    if (realOriginal.startsWith(work + path.sep)) throw refuse("the original is inside the work directory")
    const [a, b] = await Promise.all([fsp.stat(realOriginal), fsp.stat(realCopy)])
    if (a.dev === b.dev && a.ino === b.ino) throw refuse("both are the same file on disk")
  }

  /** The user's output with only the path and thread count replaced. */
  private async writeProfile(target: SqlTarget): Promise<void> {
    const { default: YAML } = await import("yaml")
    const settings =
      this.ctx.rawOutput.settings && typeof this.ctx.rawOutput.settings === "object"
        ? (this.ctx.rawOutput.settings as Record<string, unknown>)
        : {}
    const configOptions =
      this.ctx.rawOutput.config_options && typeof this.ctx.rawOutput.config_options === "object"
        ? (this.ctx.rawOutput.config_options as Record<string, unknown>)
        : undefined
    // DuckDB spills to temp_directory under memory pressure. Keep the spill files in the work
    // directory (removed on exit) rather than in whatever location the user's profile names.
    const tempDir = path.join(this.ctx.workDir, "duckdb-temp", target.toLowerCase())
    const redirect = (o: Record<string, unknown>) => ("temp_directory" in o ? { ...o, temp_directory: tempDir } : o)
    const output = {
      ...this.ctx.rawOutput,
      type: "duckdb",
      path: this.copyPath(target),
      // Single-threaded: row order in rebuilt models must not depend on scheduling.
      threads: 1,
      settings: redirect({ ...settings, threads: 1 }),
      ...(configOptions ? { config_options: redirect(configOptions) } : {}),
    }
    const dir = this.profilesDir(target)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(
      path.join(dir, "profiles.yml"),
      YAML.stringify({ [this.ctx.profileName]: { target: this.ctx.targetName, outputs: { [this.ctx.targetName]: output } } }),
      { mode: 0o600 },
    )
  }

  private async connector(target: SqlTarget): Promise<Connector> {
    const existing = this.connectors[target]
    if (existing) return existing
    const { connect } = await import("@altimateai/drivers/duckdb")
    const connector = await connect({ type: "duckdb", path: ":memory:" })
    await connector.connect()
    await connector.execute("SET threads = 1")
    this.connectors[target] = connector
    return connector
  }

  /**
   * Drop the in-memory instance for `target`. Used when its state is no longer
   * known (a failed ATTACH, USE or DETACH); the next statement starts from a
   * fresh instance instead of running against the wrong catalog.
   */
  private async discard(target: SqlTarget): Promise<void> {
    const connector = this.connectors[target]
    delete this.connectors[target]
    this.attached[target] = false
    if (!connector) return
    try {
      await connector.execute("USE memory")
      await connector.execute(`DETACH ${sqlIdent(this.catalog)}`)
    } catch {
      // already detached, or never attached
    }
    try {
      await connector.close()
    } catch {
      // best effort
    }
  }

  async execute(target: SqlTarget, sql: string): Promise<unknown[][]> {
    if (!this.attached[target]) {
      const file = this.copyPath(target)
      await this.assertIsCopy(file)
      const connector = await this.connector(target)
      const mode = target === "Baseline" ? " (READ_ONLY)" : ""
      try {
        await connector.execute(`ATTACH ${sqlString(file)} AS ${sqlIdent(this.catalog)}${mode}`)
        await connector.execute(`USE ${sqlIdent(this.catalog)}`)
      } catch (e) {
        await this.discard(target)
        throw e
      }
      this.attached[target] = true
    }
    const connector = await this.connector(target)
    // noLimit: the driver otherwise appends LIMIT 1001 to every SELECT.
    // The driver keys each row by column name, so two result columns with the
    // same name would collapse into one. The engine's SQL never repeats an
    // expression in a select list; a new engine query must keep that property.
    const result = await connector.execute(sql, undefined, undefined, { noLimit: true })
    return result.rows
  }

  isRelationMissing(error: unknown): boolean {
    // Anywhere at a line start: the driver may prefix DuckDB's text with its own explanation.
    return /(^|\n)\s*(Error: )?Catalog Error:/i.test(errorText(error))
  }

  async listRelations(): Promise<RelationColumns[]> {
    const kinds = new Map<string, "table" | "view">()
    for (const [schema, table, kind] of await this.execute(
      "Baseline",
      "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_catalog = current_database()",
    )) {
      kinds.set(`${schema}\u0000${table}`, kind === "VIEW" ? "view" : "table")
    }
    const relations = new Map<string, RelationColumns>()
    for (const [catalog, schema, table, column, dataType] of await this.execute(
      "Baseline",
      "SELECT table_catalog, table_schema, table_name, column_name, data_type FROM information_schema.columns " +
        "WHERE table_catalog = current_database() ORDER BY table_schema, table_name, ordinal_position",
    )) {
      const key = `${schema}\u0000${table}`
      let relation = relations.get(key)
      if (!relation) {
        relation = {
          database: String(catalog),
          schema: String(schema),
          name: String(table),
          relation_type: kinds.get(key) ?? "table",
          columns: [],
        }
        relations.set(key, relation)
      }
      relation.columns.push({ name: String(column), data_type: String(dataType) })
    }
    return [...relations.values()]
  }

  async prepareSandbox(): Promise<void> {
    await this.release("Sandbox")
    await fsp.rm(this.sandboxPath, { force: true })
    await fsp.rm(`${this.sandboxPath}.wal`, { force: true })
    if (fs.existsSync(`${this.baselinePath}.wal`)) {
      throw new Error("the baseline copy has a pending write-ahead log; it cannot be copied consistently")
    }
    await fsp.copyFile(this.baselinePath, this.sandboxPath, fs.constants.COPYFILE_FICLONE)
    await this.assertIsCopy(this.sandboxPath)
  }

  async release(target: SqlTarget): Promise<void> {
    if (!this.attached[target]) return
    const connector = this.connectors[target]
    if (!connector) return
    try {
      await connector.execute("USE memory")
      await connector.execute(`DETACH ${sqlIdent(this.catalog)}`)
      this.attached[target] = false
    } catch (e) {
      // The file may still be attached and locked. Never reuse this instance.
      await this.discard(target)
      throw e
    }
  }

  async verifyOriginalUntouched(): Promise<{ status: "unchanged" | "unknown" } | { status: "changed"; detail: string }> {
    if (!this.originalStat) return { status: "unknown" }
    try {
      const now = await fsp.stat(this.original)
      if (now.size !== this.originalStat.size || now.mtimeMs !== this.originalStat.mtimeMs) {
        return { status: "changed", detail: `${this.original} changed during the run (its size or modification time differs)` }
      }
      return { status: "unchanged" }
    } catch (e) {
      return { status: "changed", detail: `${this.original} could not be re-checked: ${errorText(e)}` }
    }
  }

  async close(): Promise<void> {
    for (const target of ["Baseline", "Sandbox"] as const) {
      try {
        await this.release(target)
      } catch {
        // the file is about to be deleted; a failed DETACH changes nothing
      }
      try {
        await this.connectors[target]?.close()
      } catch {
        // best effort
      }
      delete this.connectors[target]
    }
  }
}

// ---------------------------------------------------------------------------
// dbt
// ---------------------------------------------------------------------------

export interface DbtOutcome {
  exitCode: number | null
  /** Per-node status from run_results.json, or null when dbt wrote none. */
  results: NodeStatus[] | null
  /** Tail of dbt's output, for error messages. */
  tail: string
  timedOut: boolean
}

export interface DbtRunner {
  /** Run `dbt <args>` against the baseline or sandbox copy. Rejects with FaultInjectionInterrupted on abort. */
  run(target: SqlTarget, args: string[], signal?: AbortSignal): Promise<DbtOutcome>
  /** Directory dbt writes `manifest.json` and `run_results.json` to for `target`. */
  targetPath(target: SqlTarget): string
}

const DEFAULT_DBT_TIMEOUT_MS = 900_000
const TAIL_BYTES = 4_000
const KILL_GRACE_MS = 3_000

/**
 * dbt global flags that can also be set through the environment and that change
 * what a rebuild builds, reads or writes. A run must not inherit them.
 */
const DBT_FLAG_ENV = [
  "DBT_DEFER",
  "DBT_DEFER_STATE",
  "DBT_STATE",
  "DBT_FAVOR_STATE",
  "DBT_FAIL_FAST",
  "DBT_WARN_ERROR",
  "DBT_WARN_ERROR_OPTIONS",
  "DBT_FULL_REFRESH",
  "DBT_EMPTY",
  "DBT_SAMPLE",
  "DBT_STORE_FAILURES",
  "DBT_INDIRECT_SELECTION",
  "DBT_RESOURCE_TYPES",
  "DBT_EXCLUDE_RESOURCE_TYPES",
  "DBT_WRITE_JSON",
  "DBT_TARGET",
  "DBT_PROFILE",
  "DBT_PROJECT_DIR",
]

/** dbt processes in flight, killed if the process exits under them. */
const liveChildren = new Set<import("child_process").ChildProcess>()

/** Signal dbt and anything it started. dbt runs in its own process group on POSIX. */
function killTree(child: import("child_process").ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    // already gone
  }
}

export interface DbtRunnerOptions {
  dbtPath: string
  env: Record<string, string | undefined>
  /** The directory dbt runs in and reads the project from. */
  projectDir: string
  workDir: string
  dbtProfile: string
  dbtTarget: string
  timeoutMs?: number
  profilesDir(target: SqlTarget): string
}

/** dbt through the CLI, with target and log paths inside the work directory. */
export function createDbtRunner(options: DbtRunnerOptions): DbtRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DBT_TIMEOUT_MS
  const targetPath = (target: SqlTarget) =>
    path.join(options.workDir, target === "Baseline" ? "target-baseline" : "target-sandbox")
  const logPath = path.join(options.workDir, "logs")

  return {
    targetPath,
    run(target, args, signal) {
      if (signal?.aborted) return Promise.reject(new FaultInjectionInterrupted())
      const [subcommand, ...rest] = args
      const profiles = options.profilesDir(target)
      const targetDir = targetPath(target)
      const resultsFile = path.join(targetDir, "run_results.json")
      fs.rmSync(resultsFile, { force: true })
      const argv = [
        "--no-use-colors",
        subcommand,
        "--project-dir",
        options.projectDir,
        "--profiles-dir",
        profiles,
        "--profile",
        options.dbtProfile,
        "--target",
        options.dbtTarget,
        "--target-path",
        targetDir,
        "--log-path",
        logPath,
        ...rest,
      ]
      const env: Record<string, string | undefined> = {
        ...options.env,
        DBT_PROFILES_DIR: profiles,
        DBT_TARGET_PATH: targetDir,
        DBT_LOG_PATH: logPath,
        DBT_SEND_ANONYMOUS_USAGE_STATS: "false",
      }
      for (const name of DBT_FLAG_ENV) delete env[name]
      return new Promise<DbtOutcome>((resolve, reject) => {
        const child = spawn(options.dbtPath, argv, {
          cwd: options.projectDir,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          // Own process group, so a wrapper script's children are stopped with it.
          detached: process.platform !== "win32",
        })
        liveChildren.add(child)
        let tail = ""
        const keep = (chunk: Buffer) => {
          tail = (tail + chunk.toString("utf-8")).slice(-TAIL_BYTES)
        }
        child.stdout?.on("data", keep)
        child.stderr?.on("data", keep)

        let timedOut = false
        let aborted = false
        let killTimer: ReturnType<typeof setTimeout> | undefined
        const stop = () => {
          killTree(child, "SIGTERM")
          killTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS)
        }
        const timer = setTimeout(() => {
          timedOut = true
          stop()
        }, timeoutMs)
        const onAbort = () => {
          aborted = true
          stop()
        }
        signal?.addEventListener("abort", onAbort, { once: true })
        const settle = () => {
          clearTimeout(timer)
          if (killTimer) clearTimeout(killTimer)
          signal?.removeEventListener("abort", onAbort)
          liveChildren.delete(child)
        }

        child.on("error", (e) => {
          settle()
          reject(e)
        })
        child.on("close", (code) => {
          settle()
          if (aborted || signal?.aborted) return reject(new FaultInjectionInterrupted())
          if (timedOut) {
            return resolve({ exitCode: code, results: null, tail: `dbt ${subcommand} timed out after ${timeoutMs}ms`, timedOut })
          }
          let results: NodeStatus[] | null = null
          try {
            const parsed = JSON.parse(fs.readFileSync(resultsFile, "utf-8"))
            results = (parsed.results as Array<Record<string, unknown>>).map((r) => ({
              unique_id: String(r.unique_id),
              status: String(r.status),
            }))
          } catch {
            results = null
          }
          resolve({ exitCode: code, results, tail, timedOut })
        })
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Performing actions
// ---------------------------------------------------------------------------

export interface PerformDeps {
  sandbox: Pick<SandboxStrategy, "execute" | "isRelationMissing" | "prepareSandbox" | "release">
  dbt: Pick<DbtRunner, "run">
  signal?: AbortSignal
}

function failed(id: string, e: unknown, timedOut = false): FaultStepResult {
  return {
    type: "Failed",
    id,
    message: errorText(e).slice(0, ERROR_TEXT_LIMIT),
    ...(timedOut ? { timed_out: true } : {}),
  }
}

async function executeSql(
  action: Extract<FaultAction, { type: "ExecuteSql" }>,
  deps: PerformDeps,
): Promise<FaultStepResult> {
  const responses: FaultSqlResponse[] = []
  for (const task of action.tasks) {
    throwIfAborted(deps.signal)
    try {
      const rows = await deps.sandbox.execute(task.target, task.sql)
      responses.push({
        id: task.id,
        rows: task.expected_shape === "Statement" ? [] : rows.map((row) => row.map(renderValue)),
      })
    } catch (e) {
      responses.push({
        id: task.id,
        error: errorText(e).slice(0, ERROR_TEXT_LIMIT),
        // Only a catalog error means "the relation is gone"; anything else is a real failure.
        ...(deps.sandbox.isRelationMissing(e) ? { relation_missing: true } : {}),
      })
      // A sequential batch stops at the first error; later tasks are omitted.
      if (action.sequential) break
    }
  }
  return { type: "Sql", id: action.id, responses }
}

async function runDbtAction(
  id: string,
  args: string[],
  expected: number,
  what: string,
  deps: PerformDeps,
): Promise<FaultStepResult> {
  try {
    // dbt needs the file lock this process may still hold on the sandbox.
    await deps.sandbox.release("Sandbox")
  } catch (e) {
    return failed(id, `could not release the sandbox before ${what}: ${errorText(e)}`)
  }
  let outcome: DbtOutcome
  try {
    outcome = await deps.dbt.run("Sandbox", args, deps.signal)
  } catch (e) {
    if (e instanceof FaultInjectionInterrupted) throw e
    return failed(id, e)
  }
  if (outcome.timedOut) return failed(id, outcome.tail || `${what} timed out`, true)
  if (outcome.results === null) {
    // dbt wrote no run_results.json. That is only fine when nothing was expected to run.
    if (outcome.exitCode !== 0 || expected > 0) {
      return failed(id, `${what} produced no results (exit ${outcome.exitCode}): ${outcome.tail.slice(-ERROR_TEXT_LIMIT)}`)
    }
    return { type: "NodeResults", id, results: [] }
  }
  return { type: "NodeResults", id, results: outcome.results }
}

/** Perform one engine action and return the result to step the session with. */
export async function performAction(action: PerformableAction, deps: PerformDeps): Promise<FaultStepResult> {
  throwIfAborted(deps.signal)
  switch (action.type) {
    case "ExecuteSql":
      return executeSql(action, deps)
    case "PrepareSandbox":
      try {
        await deps.sandbox.prepareSandbox()
        return { type: "Ok", id: action.id }
      } catch (e) {
        return failed(action.id, e)
      }
    case "RebuildNodes": {
      // An empty selector would make dbt rebuild the whole project.
      if (action.select.length === 0) return { type: "NodeResults", id: action.id, results: [] }
      const args = [
        "run",
        "--threads",
        "1",
        ...(action.full_refresh ? ["--full-refresh"] : []),
        "--select",
        ...action.select,
        ...(action.exclude.length > 0 ? ["--exclude", ...action.exclude] : []),
      ]
      return runDbtAction(action.id, args, action.node_ids.length, "dbt run", deps)
    }
    case "RunTests": {
      if (action.select.length === 0) return { type: "NodeResults", id: action.id, results: [] }
      const args = ["test", "--threads", "1", "--select", ...action.select]
      return runDbtAction(action.id, args, action.test_ids.length, "dbt test", deps)
    }
  }
}

// ---------------------------------------------------------------------------
// The cooperative loop
// ---------------------------------------------------------------------------

/** A run that needs more actions than this is a bug, not a big project. */
const MAX_ACTIONS = 1_000_000

export interface DriveOptions {
  signal?: AbortSignal
  onProgress?: (event: DbtFaultInjectionProgress) => void
}

export interface DriveOutcome {
  /** The final report; absent when the engine stopped with an error. */
  report?: Record<string, any>
  error?: string
  actions: Record<string, number>
  /** Wall-clock per fault id, over every action that belonged to it. */
  perFaultMs: Record<string, number>
}

/**
 * Step a session to completion: take an action, perform it, feed the result
 * back. Throws FaultInjectionInterrupted when the signal aborts.
 */
export async function driveFaultInjectionSession(
  session: FaultInjectionSessionLike,
  deps: PerformDeps,
  options: DriveOptions = {},
): Promise<DriveOutcome> {
  const actions: Record<string, number> = {}
  const perFaultMs: Record<string, number> = {}
  const started = new Set<string>()
  let action = JSON.parse(session.start()) as FaultAction

  for (let steps = 0; steps < MAX_ACTIONS; steps++) {
    if (action.type === "Done") return { report: action.report, actions, perFaultMs }
    if (action.type === "Error") return { error: action.message ?? "Unknown engine error", actions, perFaultMs }
    if (!["ExecuteSql", "PrepareSandbox", "RebuildNodes", "RunTests"].includes(action.type)) {
      return { error: `Unexpected action type: ${(action as { type: string }).type}`, actions, perFaultMs }
    }
    throwIfAborted(options.signal ?? deps.signal)

    actions[action.type] = (actions[action.type] ?? 0) + 1
    if (action.type === "PrepareSandbox" && options.onProgress) {
      const key = action.fault_id ?? `control:${action.producer_id}`
      if (!started.has(key)) {
        started.add(key)
        const summary = (JSON.parse(session.report()) as Record<string, any>).summary ?? {}
        options.onProgress(
          action.fault_id
            ? {
                kind: "fault",
                fault_id: action.fault_id,
                index: [...started].filter((k) => !k.startsWith("control:")).length,
                total: Number(summary.selected ?? 0),
              }
            : { kind: "control", producer_id: action.producer_id },
        )
      }
    }

    const began = Date.now()
    const result = await performAction(action, deps)
    if (action.fault_id) perFaultMs[action.fault_id] = (perFaultMs[action.fault_id] ?? 0) + (Date.now() - began)
    action = JSON.parse(session.step(JSON.stringify(result))) as FaultAction
  }
  return { error: `Exceeded ${MAX_ACTIONS} actions; the session is not converging.`, actions, perFaultMs }
}

// ---------------------------------------------------------------------------
// dbt project and profile
// ---------------------------------------------------------------------------

/** Resolve `{{ env_var('NAME') }}` and `{{ env_var('NAME', 'default') }}`; anything else is left as written. */
function resolveEnvVars(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") {
    return value.replace(
      /\{\{\s*env_var\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]*)['"]\s*)?\)\s*\}\}/g,
      (whole, name: string, fallback?: string) => env[name] ?? fallback ?? whole,
    )
  }
  if (Array.isArray(value)) return value.map((v) => resolveEnvVars(v, env))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveEnvVars(v, env)]))
  }
  return value
}

export interface DbtTargetInfo {
  profileName: string
  targetName: string
  adapterType: string
  output: Record<string, unknown>
  rawOutput: Record<string, unknown>
  profilesFile: string
}

/** Read the profile and target a dbt project would use, in dbt's lookup order. */
export async function readDbtTarget(
  projectDir: string,
  options: { profilesDir?: string; target?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<DbtTargetInfo> {
  const env = options.env ?? process.env
  const { default: YAML } = await import("yaml")
  const projectFile = path.join(projectDir, "dbt_project.yml")
  if (!fs.existsSync(projectFile)) {
    throw new Error(`No dbt_project.yml in ${projectDir}. Run this inside a dbt project or pass its directory.`)
  }
  const project = YAML.parse(await fsp.readFile(projectFile, "utf-8")) as Record<string, unknown> | null
  const profileName = String(env.DBT_PROFILE || resolveEnvVars(project?.profile ?? "", env))
  if (!profileName) throw new Error(`${projectFile} does not name a profile.`)

  const candidates = [
    options.profilesDir,
    env.DBT_PROFILES_DIR,
    projectDir,
    path.join(os.homedir(), ".dbt"),
  ].filter((d): d is string => Boolean(d))
  const profilesFile = candidates
    .map((dir) => path.join(path.resolve(dir), "profiles.yml"))
    .find((file) => fs.existsSync(file))
  if (!profilesFile) {
    throw new Error(`No profiles.yml found (looked in ${candidates.join(", ")}).`)
  }
  const profiles = YAML.parse(await fsp.readFile(profilesFile, "utf-8")) as Record<string, any> | null
  const profile = profiles?.[profileName]
  if (!profile || typeof profile !== "object") {
    throw new Error(`Profile "${profileName}" is not defined in ${profilesFile}.`)
  }
  const targetName = String(options.target ?? (env.DBT_TARGET || resolveEnvVars(profile.target ?? "default", env)))
  const rawOutput = profile.outputs?.[targetName]
  if (!rawOutput || typeof rawOutput !== "object") {
    throw new Error(`Target "${targetName}" is not defined for profile "${profileName}" in ${profilesFile}.`)
  }
  const output = resolveEnvVars(rawOutput, env) as Record<string, unknown>
  const adapterType = String(output.type ?? "")
  if (!adapterType) throw new Error(`Target "${targetName}" in ${profilesFile} has no "type".`)
  return { profileName, targetName, adapterType, output, rawOutput, profilesFile }
}

/** Map a model, seed, snapshot or source name to the unique ids the engine calls producers. */
export function resolveProducers(manifest: Record<string, any>, name: string): string[] {
  const wanted = name.trim()
  const ids: string[] = []
  for (const [id, node] of Object.entries<any>(manifest.nodes ?? {})) {
    if (!["model", "seed", "snapshot"].includes(node?.resource_type)) continue
    if (id === wanted || node.name === wanted) ids.push(id)
  }
  for (const [id, source] of Object.entries<any>(manifest.sources ?? {})) {
    if (id === wanted || source.name === wanted || `${source.source_name}.${source.name}` === wanted) ids.push(id)
  }
  return ids
}

/** Names and file locations of the nodes a report refers to, for rendering. */
function collectNodeInfo(manifest: Record<string, any>, report: Record<string, any>): Record<string, FaultInjectionNodeInfo> {
  const ids = new Set<string>()
  for (const result of (report.results ?? []) as Array<Record<string, any>>) {
    ids.add(result.producer_id)
    if (result.proposed_test?.node_id) ids.add(result.proposed_test.node_id)
    for (const changed of result.changed_relations ?? []) ids.add(changed.unique_id)
    for (const id of [...(result.failed_tests ?? []), ...(result.build_errors ?? [])]) ids.add(id)
  }
  for (const control of (report.controls ?? []) as Array<Record<string, any>>) ids.add(control.producer_id)
  const info: Record<string, FaultInjectionNodeInfo> = {}
  for (const id of ids) {
    const node = manifest.nodes?.[id] ?? manifest.sources?.[id]
    if (!node) continue
    info[id] = {
      name: String(node.name),
      resource_type: String(node.resource_type),
      ...(node.source_name ? { source_name: String(node.source_name) } : {}),
      ...(node.package_name ? { package_name: String(node.package_name) } : {}),
      ...(typeof node.patch_path === "string" ? { patch_path: node.patch_path.replace(/^[^:]*:\/\//, "") } : {}),
      ...(typeof node.original_file_path === "string" ? { original_file_path: node.original_file_path } : {}),
    }
  }
  return info
}

// ---------------------------------------------------------------------------
// Work directory lifetime
// ---------------------------------------------------------------------------

/** Work directories of runs in flight, removed synchronously if the process exits under them. */
const liveWorkDirs = new Set<string>()
let exitHookInstalled = false

function trackWorkDir(dir: string): void {
  liveWorkDirs.add(dir)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on("exit", () => {
    for (const child of liveChildren) killTree(child, "SIGKILL")
    for (const live of liveWorkDirs) {
      try {
        fs.rmSync(live, { recursive: true, force: true })
      } catch {
        // nothing more can be done while exiting
      }
    }
  })
}

async function removeWorkDir(dir: string): Promise<boolean> {
  try {
    await fsp.rm(dir, { recursive: true, force: true })
  } catch {
    // reported through the return value
  }
  const removed = !fs.existsSync(dir)
  // Left in the set when removal failed, so the exit hook tries once more.
  if (removed) liveWorkDirs.delete(dir)
  return removed
}

/** Top-level entries of a project that dbt does not need and that must not be copied. */
const PROJECT_COPY_SKIP = new Set([".git", "target", "logs", "node_modules", "profiles.yml", ".user.yml"])

/**
 * Copy the project into the work directory. dbt then runs in the copy, so
 * nothing it writes with a relative path (target/, logs/, a hook's export)
 * can land in the user's project.
 */
async function copyProject(projectDir: string, dest: string, workDir: string): Promise<void> {
  const [root, work] = await Promise.all([fsp.realpath(projectDir), fsp.realpath(workDir)])
  await fsp.cp(root, dest, {
    recursive: true,
    mode: fs.constants.COPYFILE_FICLONE,
    filter: (source) => {
      if (source === work || source.startsWith(work + path.sep)) return false
      const relative = path.relative(root, source)
      if (relative === "") return true
      if (!relative.includes(path.sep) && PROJECT_COPY_SKIP.has(relative)) return false
      if (/\.(duckdb|wal)$/i.test(source)) return false
      // A Python virtualenv, whatever it is called.
      if (fs.existsSync(path.join(source, "pyvenv.cfg"))) return false
      return true
    },
  })
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/** Test seams. Production passes none. */
export interface FaultInjectionDeps {
  loadEngine?: typeof loadFaultInjectionEngine
  resolveDbt?: (projectDir: string) => Promise<{ path: string; version: string; env: Record<string, string | undefined> }>
}

async function resolveDbtBinary(
  projectDir: string,
): Promise<{ path: string; version: string; env: Record<string, string | undefined> }> {
  const { resolveDbt, validateDbt, buildDbtEnv } = await import("../../../../../dbt-tools/src/dbt-resolve")
  const resolved = resolveDbt(undefined, projectDir)
  const valid = validateDbt(resolved)
  if (!valid) {
    throw new Error(
      `dbt is not runnable (tried ${resolved.path}, found via ${resolved.source}). ` +
        `Install dbt-core with the project's adapter, or set ALTIMATE_DBT_PATH to the dbt executable.`,
    )
  }
  if (valid.isFusion) {
    throw new Error(`Fault injection needs dbt-core; ${resolved.path} is dbt Fusion. Set ALTIMATE_DBT_PATH to a dbt-core executable.`)
  }
  return { path: resolved.path, version: valid.version, env: buildDbtEnv(resolved) }
}

function describeDbtFailure(what: string, outcome: DbtOutcome): string {
  const bad = (outcome.results ?? []).filter((r) => ["error", "fail", "runtime error"].includes(r.status))
  const nodes = bad.length
    ? ` ${bad.length} node(s) failed: ${bad
        .slice(0, 8)
        .map((r) => `${r.unique_id} (${r.status})`)
        .join(", ")}${bad.length > 8 ? ", ..." : ""}.`
    : ""
  const tail = outcome.tail.trim().split("\n").slice(-12).join("\n")
  return `${what} (exit ${outcome.exitCode}).${nodes}${tail ? `\n${tail}` : ""}`
}

export async function runFaultInjection(
  params: DbtFaultInjectionParams,
  deps: FaultInjectionDeps = {},
): Promise<DbtFaultInjectionResult> {
  const startedAt = Date.now()
  const signal = params.signal
  const progress = (event: DbtFaultInjectionProgress) => {
    try {
      params.on_progress?.(event)
    } catch {
      // progress reporting must never break the run
    }
  }
  const stage = (message: string) => progress({ kind: "stage", message })
  const projectDir = path.resolve(params.project_dir ?? process.cwd())
  const fail = (error: string, extra: Partial<DbtFaultInjectionResult> = {}): DbtFaultInjectionResult => ({
    success: false,
    error,
    project_dir: projectDir,
    ...extra,
  })

  // Everything that can be checked without copying or building is checked first.
  let target: DbtTargetInfo
  let factory: SandboxFactory
  let engine: LoadedEngine
  let dbt: { path: string; version: string; env: Record<string, string | undefined> }
  try {
    target = await readDbtTarget(projectDir, { profilesDir: params.profiles_dir, target: params.target })
    factory = resolveSandboxFactory(target.adapterType)
    engine = await (deps.loadEngine ?? loadFaultInjectionEngine)()
    dbt = await (deps.resolveDbt ?? resolveDbtBinary)(projectDir)
  } catch (e) {
    return fail(errorText(e))
  }

  let workDir: string
  try {
    const parent = path.resolve(params.work_dir ?? os.tmpdir())
    await fsp.mkdir(parent, { recursive: true })
    workDir = await fsp.mkdtemp(path.join(parent, "altimate-fault-injection-"))
    trackWorkDir(workDir)
  } catch (e) {
    return fail(`Could not create a work directory: ${errorText(e)}`)
  }

  let sandbox: SandboxStrategy | undefined
  const base: Partial<DbtFaultInjectionResult> = {
    project_dir: projectDir,
    warehouse: target.adapterType.toLowerCase(),
    work_dir: workDir,
    dbt: { path: dbt.path, version: dbt.version },
    engine: { source: engine.source, ...(engine.path ? { path: engine.path } : {}) },
  }
  let result: DbtFaultInjectionResult

  try {
    sandbox = factory({
      projectDir,
      workDir,
      profileName: target.profileName,
      targetName: target.targetName,
      output: target.output,
      rawOutput: target.rawOutput,
    })
    base.database = sandbox.original
    stage(`Copying ${sandbox.original} and the project to ${workDir}`)
    await sandbox.setup()
    throwIfAborted(signal)
    const projectCopy = path.join(workDir, "project")
    await copyProject(projectDir, projectCopy, workDir)
    throwIfAborted(signal)

    const runner = createDbtRunner({
      dbtPath: dbt.path,
      env: dbt.env,
      projectDir: projectCopy,
      workDir,
      dbtProfile: target.profileName,
      dbtTarget: target.targetName,
      timeoutMs: params.dbt_timeout_ms,
      profilesDir: (t) => sandbox!.profilesDir(t),
    })
    const readManifest = async () =>
      JSON.parse(await fsp.readFile(path.join(runner.targetPath("Baseline"), "manifest.json"), "utf-8")) as Record<string, any>
    /** A dbt step of the setup. An interrupt or a timeout is reported as such, not as a project failure. */
    const setupDbt = async (args: string[]): Promise<DbtOutcome> => {
      const outcome = await runner.run("Baseline", args, signal)
      throwIfAborted(signal)
      if (outcome.timedOut) throw new Error(`${outcome.tail}. Raise the dbt timeout or run on a smaller project.`)
      return outcome
    }

    // Parse before anything is built: a project that visibly reaches outside the database is refused.
    stage("Parsing the project")
    const parsed = await setupDbt(["parse"])
    if (parsed.exitCode !== 0) throw new Error(describeDbtFailure("The project does not parse: dbt parse failed", parsed))
    sandbox.assertManifestIsolated(await readManifest())

    // Rebuild the baseline copy now, the way every sandbox is rebuilt later:
    // from scratch. Models that read the clock, and incremental models, would
    // otherwise differ from the sandbox with no fault injected. Tests are left
    // out: they change no data, and a failing one would make dbt skip the
    // models below it. The control runs find tests that already fail.
    stage("Building the baseline copy (dbt build)")
    const buildStarted = Date.now()
    const built = await setupDbt([
      "build",
      "--threads",
      "1",
      "--full-refresh",
      "--exclude",
      "resource_type:test",
      "resource_type:unit_test",
    ])
    const baselineBuildMs = Date.now() - buildStarted
    if (built.results === null) {
      throw new Error(describeDbtFailure("The project does not build: dbt build wrote no results", built))
    }
    if (built.results.some((r) => ["error", "runtime error", "fail", "skipped"].includes(r.status))) {
      throw new Error(
        describeDbtFailure("The project does not build on a clean copy, so there is no baseline to compare against", built),
      )
    }

    stage("Compiling the project")
    const compiled = await setupDbt(["compile", "--threads", "1"])
    if (compiled.exitCode !== 0) throw new Error(describeDbtFailure("dbt compile failed", compiled))
    const manifest = await readManifest()
    sandbox.assertManifestIsolated(manifest)

    const config: Record<string, unknown> = { budget: params.budget ?? 20 }
    if (params.seed !== undefined) config.seed = params.seed
    if (params.model) {
      const producers = resolveProducers(manifest, params.model)
      if (producers.length === 0) {
        throw new Error(`No model, seed, snapshot or source named "${params.model}" in this project.`)
      }
      config.producers = producers
    }

    const relations = await sandbox.listRelations()
    let session: FaultInjectionSessionLike
    try {
      session = new engine.Session(JSON.stringify({ manifest, relations, dialect: sandbox.dialect, config }))
    } catch (e) {
      throw new Error(`Failed to create FaultInjectionSession: ${errorText(e)}`)
    }

    stage("Injecting faults")
    const runStarted = Date.now()
    const outcome = await driveFaultInjectionSession(
      session,
      { sandbox, dbt: runner, signal },
      { signal, onProgress: progress },
    )
    const timing = {
      total_ms: 0,
      baseline_build_ms: baselineBuildMs,
      setup_ms: runStarted - startedAt,
      run_ms: Date.now() - runStarted,
      per_fault_ms: outcome.perFaultMs,
      actions: outcome.actions,
    }
    if (!outcome.report) {
      result = fail(outcome.error ?? "Unknown engine error", { ...base, timing })
    } else {
      const report = outcome.report
      result = {
        ...base,
        success: true,
        budget: Number(config.budget),
        report,
        nodes: collectNodeInfo(manifest, report),
        timing,
      }
    }
  } catch (e) {
    result =
      e instanceof FaultInjectionInterrupted
        ? fail("Interrupted before the run finished.", { ...base, interrupted: true })
        : fail(errorText(e), base)
  }

  // Cleanup runs on success, failure and interrupt alike.
  if (sandbox) {
    try {
      await sandbox.close()
    } catch {
      // the work directory is removed regardless
    }
    const original = await sandbox.verifyOriginalUntouched()
    if (original.status === "unchanged") result.original_unchanged = true
    if (original.status === "changed") {
      result.original_unchanged = false
      result.success = false
      result.error =
        `${original.detail}. Fault injection only writes to copies; check what else was using the file.` +
        (result.error ? ` (Run error: ${result.error})` : "")
    }
  }
  result.work_dir_removed = await removeWorkDir(workDir)
  if (result.timing) result.timing.total_ms = Date.now() - startedAt
  else result.timing = { total_ms: Date.now() - startedAt }
  return result
}
