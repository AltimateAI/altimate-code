/**
 * Resolution and on-demand installation for optional warehouse SDKs.
 *
 * Warehouse SDKs (`snowflake-sdk`, `pg`, `@google-cloud/bigquery`, …) are
 * optional dependencies: they are marked external in the binary build and
 * installed per warehouse, on demand. Two things broke that arrangement.
 *
 * 1. A bare `import("snowflake-sdk")` inside the compiled Bun binary resolves
 *    against bunfs, which has no `node_modules`. An SDK the user had already
 *    installed alongside the CLI or into managed storage was invisible to the runtime,
 *    which then reported it as "not installed".
 * 2. The curl install's self-upgrade re-runs the install script, which rebuilds
 *    `~/.altimate/bin`. Anything installed into that directory by hand is lost
 *    on the next upgrade.
 *
 * So: search real directories on disk rather than trusting the ambient module
 * resolver, and install into a directory under the XDG data dir that no
 * upgrade path touches.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawn } from "node:child_process"
import { performance } from "node:perf_hooks"

/**
 * Quote a path for a copy-pasteable shell command on the current platform.
 *
 * cmd.exe and PowerShell do not understand POSIX single-quoting, so a path with
 * spaces printed the POSIX way is not runnable on Windows.
 */
export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return /^[A-Za-z0-9_.:\\/@-]+$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`
  }
  return /^[A-Za-z0-9_./@:-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/** Every driver in this package and the npm packages it needs at runtime. */
export const DRIVER_PACKAGES = {
  postgres: ["pg"],
  redshift: ["pg"],
  snowflake: ["snowflake-sdk"],
  bigquery: ["@google-cloud/bigquery"],
  databricks: ["@databricks/sql"],
  mysql: ["mysql2"],
  sqlserver: ["mssql"],
  oracle: ["oracledb"],
  duckdb: ["duckdb"],
  mongodb: ["mongodb"],
  clickhouse: ["@clickhouse/client"],
  trino: ["trino-client"],
} as const satisfies Record<string, readonly string[]>

export type DriverName = keyof typeof DRIVER_PACKAGES

/** Human-facing driver labels, used in error text. */
const DRIVER_LABELS: Record<DriverName, string> = {
  postgres: "PostgreSQL",
  redshift: "Redshift",
  snowflake: "Snowflake",
  bigquery: "BigQuery",
  databricks: "Databricks",
  mysql: "MySQL",
  sqlserver: "SQL Server",
  oracle: "Oracle",
  duckdb: "DuckDB",
  mongodb: "MongoDB",
  clickhouse: "ClickHouse",
  trino: "Trino",
}

export function driverLabel(driver: DriverName): string {
  return DRIVER_LABELS[driver]
}

/**
 * Raised when a driver's SDK cannot be found anywhere on the search path.
 *
 * Carries the searched roots so callers can tell a user with a genuinely
 * missing package apart from one whose package is installed somewhere we never
 * looked — the two failure modes were indistinguishable before.
 */
export class DriverNotInstalledError extends Error {
  readonly driver: DriverName
  readonly packages: readonly string[]
  readonly searched: readonly string[]

  constructor(driver: DriverName, packages: readonly string[], searched: readonly string[]) {
    const label = DRIVER_LABELS[driver]
    super(
      `${label} driver not installed.\n` +
        `Install it with the warehouse_install_driver tool, or run:\n` +
        `  npm install --prefix ${shellQuote(driverInstallDir())} ${packages.join(" ")}\n` +
        `Searched ${searched.length} location${searched.length === 1 ? "" : "s"}: ${searched.join(", ")}`,
    )
    this.name = "DriverNotInstalledError"
    this.driver = driver
    this.packages = packages
    this.searched = searched
  }
}

/**
 * Base of the XDG data dir, mirroring the `xdg-basedir` package that
 * `@opencode-ai/core`'s global paths use. Duplicated rather than imported:
 * importing core from here would pull in a module that creates directories as
 * an import side effect, and this package is also consumed standalone.
 */
function xdgDataHome(): string {
  const explicit = process.env["XDG_DATA_HOME"]
  if (explicit) return explicit
  return path.join(homeDir(), ".local", "share")
}

function homeDir(): string {
  // Honoured by the test suite to redirect global state away from the real home.
  return process.env["OPENCODE_TEST_HOME"] ?? os.homedir()
}

/**
 * Directory that on-demand driver installs are written to.
 *
 * Deliberately under the XDG data dir rather than `~/.altimate/bin`: the curl
 * installer owns that directory and rebuilds it on every self-upgrade, which is
 * how hand-installed drivers were being wiped.
 */
export function driverInstallDir(): string {
  const override = process.env["ALTIMATE_DRIVER_DIR"]
  if (override) return override
  return path.join(xdgDataHome(), "altimate-code", "drivers")
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

/** Collect every `node_modules` directory from `start` up to the filesystem root. */
function nodeModulesUpward(start: string): string[] {
  const found: string[] = []
  let current = path.resolve(start)
  for (;;) {
    const candidate = path.join(current, "node_modules")
    if (isDirectory(candidate)) found.push(candidate)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return found
}

/**
 * Repair a path that had the working directory concatenated onto an
 * already-absolute path, e.g. `<cwd>/usr/lib/node_modules/…` for a package
 * that really lives at `/usr/lib/node_modules/…`.
 *
 * Observed from a globally installed CLI (`npm install -g`, package tree under
 * `/usr/lib/node_modules/altimate-code`) run from an unrelated directory: the
 * runtime's own resolution reported
 * `ENOENT … open '<cwd>/usr/lib/node_modules/altimate-code/node_modules/duckdb/package.json'`
 * while the file existed at that path without the `<cwd>` prefix.
 *
 * Deliberately conservative — it fires only when the named path is absent, is
 * genuinely prefixed by the working directory, and the de-prefixed remainder
 * exists. That last check is what keeps a legitimately nested
 * `<cwd>/node_modules/…` from being mangled.
 */
export function repairCwdPrefixedPath(candidate: string, cwd = process.cwd()): string | undefined {
  if (!candidate || fs.existsSync(candidate)) return undefined
  if (!candidate.startsWith(cwd + path.sep)) return undefined
  const remainder = candidate.slice(cwd.length)
  if (!path.isAbsolute(remainder)) return undefined
  return fs.existsSync(remainder) ? remainder : undefined
}

/**
 * `node_modules` directories named by an error the runtime raised while trying
 * to resolve a package itself.
 *
 * When ambient resolution fails it often names the exact absolute location it
 * was reaching for. That location is better evidence than anything we can
 * infer, so it is worth searching — after repairing a concatenated working
 * directory, which is the failure this exists for. Returns roots only when they
 * exist on disk, so a nonsense path contributes nothing.
 */
export function searchRootsFromError(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error)
  const roots: string[] = []
  // Absolute paths the runtime quoted, POSIX or Windows.
  for (const match of message.matchAll(/['"`]((?:\/|[A-Za-z]:[\\/])[^'"`\n]+)['"`]/g)) {
    const named = match[1]
    if (!named) continue
    for (const candidate of [named, repairCwdPrefixedPath(named)]) {
      if (!candidate) continue
      // Walk back to the enclosing node_modules directory.
      const marker = `${path.sep}node_modules${path.sep}`
      const at = candidate.lastIndexOf(marker)
      if (at === -1) continue
      const root = candidate.slice(0, at + marker.length - 1)
      if (isDirectory(root) && !roots.includes(root)) roots.push(root)
    }
  }
  return roots
}

/**
 * Directories to search for an optional SDK, most specific first.
 *
 * The managed install dir comes first so a driver we installed wins over a
 * stale copy elsewhere on the machine.
 */
export function driverSearchRoots(): string[] {
  const roots: string[] = []

  const push = (dir: string | undefined) => {
    if (!dir) return
    const resolved = path.resolve(dir)
    if (isDirectory(resolved) && !roots.includes(resolved)) roots.push(resolved)
  }

  // 1. Drivers this CLI installed on demand.
  push(path.join(driverInstallDir(), "node_modules"))

  // 2. Alongside the npm wrapper. bin/altimate exports ALTIMATE_BIN_DIR, which
  //    is where a global `npm install -g altimate-code` puts its dependencies.
  const binDir = process.env["ALTIMATE_BIN_DIR"]
  if (binDir) for (const dir of nodeModulesUpward(binDir)) push(dir)

  // 3. NODE_PATH, which the npm wrapper populates and users may also set.
  const nodePath = process.env["NODE_PATH"]
  if (nodePath) for (const entry of nodePath.split(path.delimiter)) push(entry)

  // Project and ancestor node_modules are deliberately not searched. They are
  // workspace-controlled executable content; importing a matching SDK during a
  // warehouse read/test would bypass the permission boundary and can expose
  // resolved credentials. Use the consent-gated managed installer instead.

  // 4. Around the running executable. For `npm install -g` this is the global
  //    root, which is what makes a globally installed SDK resolvable.
  try {
    for (const dir of nodeModulesUpward(path.dirname(fs.realpathSync(process.execPath)))) push(dir)
  } catch {
    // execPath may not be resolvable (bunfs); the roots above still apply.
  }

  // 5. Around this package itself. When the drivers package is installed as a
  //    dependency, an SDK hoisted next to it resolves at require time but was
  //    invisible to the roots above, so `isDriverInstalled` reported a working
  //    driver as missing and the readiness note nagged about installing it.
  try {
    for (const dir of nodeModulesUpward(path.dirname(fileURLToPath(import.meta.url)))) push(dir)
  } catch {
    // No module URL under some bundlers; the roots above still apply.
  }

  return roots
}

/** Split a specifier such as `mysql2/promise` into its package name. */
export function packageNameOf(specifier: string): string {
  const segments = specifier.split("/")
  if (specifier.startsWith("@")) return segments.slice(0, 2).join("/")
  return segments[0]!
}

/**
 * Absolute path to `specifier` if it is installed under any search root.
 *
 * Returns the resolved entry file, or the package directory when the package is
 * present but exports no CommonJS entry that `require.resolve` can name.
 */
export function resolveOptionalPackage(specifier: string, roots = driverSearchRoots()): string | undefined {
  const pkg = packageNameOf(specifier)
  const require = createRequire(pathToFileURL(path.join(process.cwd(), "noop.js")).href)

  for (const root of roots) {
    const pkgDir = path.join(root, pkg)
    if (!isDirectory(pkgDir)) continue
    // A directory without a manifest is not an installed package — an
    // interrupted or half-deleted install leaves one behind. Treating it as
    // installed made `isDriverInstalled` report true for an empty directory,
    // so the install path refused to run and the driver could never be repaired.
    if (!fs.existsSync(path.join(pkgDir, "package.json"))) continue

    try {
      return require.resolve(specifier, { paths: [root] })
    } catch {
      // ESM-only packages expose no require-resolvable entry. Read the entry
      // out of the manifest instead, and only accept a file that exists.
      const entry = entryFromManifest(pkgDir, specifier, pkg)
      if (entry) return entry
      // Nothing importable here. Keep searching the remaining roots rather
      // than returning a path the caller cannot import.
      continue
    }
  }

  return undefined
}

/**
 * Entry file for `specifier` derived from its package manifest, or undefined
 * when nothing resolvable exists on disk.
 */
function entryFromManifest(pkgDir: string, specifier: string, pkg: string): string | undefined {
  const subpath = specifier.slice(pkg.length).replace(/^\//, "")

  const candidates: string[] = []
  if (subpath) {
    // A subpath such as `mysql2/promise` usually maps to a physical file.
    candidates.push(
      path.join(pkgDir, subpath),
      path.join(pkgDir, `${subpath}.js`),
      path.join(pkgDir, `${subpath}.mjs`),
      path.join(pkgDir, `${subpath}.cjs`),
      path.join(pkgDir, subpath, "index.js"),
    )
  } else {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"))
      for (const field of ["module", "main"]) {
        const value = manifest?.[field]
        if (typeof value === "string") candidates.push(path.join(pkgDir, value))
      }
    } catch {
      // Unreadable or malformed manifest — fall through to the index probes.
    }
    candidates.push(path.join(pkgDir, "index.js"), path.join(pkgDir, "index.mjs"), path.join(pkgDir, "index.cjs"))
  }

  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate)
      if (stat.isFile()) return candidate
      if (stat.isDirectory()) {
        for (const index of ["index.js", "index.mjs", "index.cjs"]) {
          const nested = path.join(candidate, index)
          if (fs.existsSync(nested)) return nested
        }
      }
    } catch {
      // Candidate does not exist; try the next one.
    }
  }

  return undefined
}

/**
 * Import an optional warehouse SDK.
 *
 * Tries the ambient resolver first so development, the monorepo, and any
 * already-working install behave exactly as before, then falls back to
 * searching real directories.
 *
 * @throws {DriverNotInstalledError} when the package is genuinely absent.
 */
export async function loadOptionalDriver(
  driver: DriverName,
  specifier: string,
  importer: (spec: string) => Promise<any> = (spec) => import(/* @vite-ignore */ spec),
): Promise<any> {
  try {
    return await importer(specifier)
  } catch (ambientError) {
    const ambientBroken = !isModuleNotFound(ambientError, specifier)
    // Search the location the runtime itself named first. When ambient
    // resolution fails it frequently quotes the absolute path it was reaching
    // for, and that beats anything we can infer — including the case where it
    // concatenated the working directory onto an already-absolute path.
    const roots = [...searchRootsFromError(ambientError), ...driverSearchRoots()]
    const resolved = resolveOptionalPackage(specifier, roots)

    if (!resolved) {
      // Nothing was found anywhere, so there is no location to name. Saying
      // "found at <specifier>" here would report the bare specifier as though
      // it were a place on disk, which reads as a load failure at a known path
      // and sends the reader looking for a file that was never located.
      if (ambientBroken) throw ambientLoadFailure(driver, ambientError, describeSearched(roots))
      throw new DriverNotInstalledError(driver, DRIVER_PACKAGES[driver], roots)
    }

    try {
      return await importer(pathToFileURL(resolved).href)
    } catch (loadError) {
      // On disk but will not load — a half-installed copy, or a native addon
      // built for another platform. When an ambient copy was also broken,
      // report that one: it is the copy the runtime would normally pick.
      if (ambientBroken) {
        // Both copies are unusable. Lead with the ambient one — it is the copy
        // the runtime would normally pick — but name the on-disk path we also
        // tried, rather than passing the specifier off as a location.
        throw ambientLoadFailure(
          driver,
          ambientError,
          `A copy at ${resolved} was also tried and failed to load: ` +
            (loadError instanceof Error ? loadError.message : String(loadError)),
        )
      }
      throw loadFailure(driver, resolved, loadError)
    }
  }
}

/**
 * True when `error` means **`specifier` itself** could not be resolved.
 *
 * A package that loads but whose own dependency tree is incomplete raises the
 * same error shape — `Cannot find package 'pg-protocol' from '…/pg/lib/
 * connection.js'` — for a driver that is very much installed. Treating that as
 * "not installed" sends the user to reinstall something already present. So
 * when the runtime names the module it could not find, only a name matching
 * what we asked for counts as missing.
 */
export function isModuleNotFound(error: unknown, specifier?: string): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const named = /Cannot find (?:module|package)\s+['"]([^'"]+)['"]/i.exec(message)

  if (named && specifier) {
    const missing = named[1]!
    return missing === specifier || missing === packageNameOf(specifier)
  }

  const code = (error as { code?: string } | null)?.code
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true
  return /Cannot find (module|package)/i.test(message)
}

function loadFailure(driver: DriverName, where: string, error: unknown): Error {
  return new Error(
    `${DRIVER_LABELS[driver]} driver found at ${where} but failed to load: ` +
      `${error instanceof Error ? error.message : String(error)}`,
  )
}

/**
 * The ambient import failed for a reason other than "not installed".
 *
 * We do not know where that copy lives — the runtime resolved it, not us — so
 * the specifier must not be reported as though it were a location on disk. The
 * previous wording, `found at duckdb but failed to load`, read as a load
 * failure at a known path for a package that had in fact never been located,
 * and sent readers looking for a file that was not there.
 */
function ambientLoadFailure(driver: DriverName, error: unknown, detail: string): Error {
  return new Error(
    `${DRIVER_LABELS[driver]} driver failed to load from the default module resolution: ` +
      `${error instanceof Error ? error.message : String(error)}\n${detail}${loadDiagnostics(error)}`,
  )
}

/**
 * Context a reader needs to tell a resolution fault apart from a broken
 * package, appended to load failures.
 *
 * Driver-load failures have twice been diagnosed from the error text alone and
 * twice been diagnosed wrong, because the text named a path without saying what
 * the process's own view of the filesystem was. The expensive question each
 * time was "is this absolute path being re-anchored to the working directory?"
 * — which is answerable on the spot, and only from inside the failing process.
 */
function loadDiagnostics(error: unknown): string {
  const lines = [`cwd=${process.cwd()}`, `execPath=${process.execPath}`]
  const message = error instanceof Error ? error.message : String(error)
  for (const match of message.matchAll(/['"`]((?:\/|[A-Za-z]:[\\/])[^'"`\n]+)['"`]/g)) {
    const named = match[1]
    if (!named) continue
    const repaired = repairCwdPrefixedPath(named)
    if (repaired) {
      lines.push(
        `NOTE: "${named}" does not exist, but "${repaired}" does — the working ` +
          `directory appears to have been concatenated onto an absolute path.`,
      )
    }
  }
  return `\n(${lines.join("; ")})`
}

function describeSearched(searched: readonly string[]): string {
  return searched.length
    ? `It was not found in any searchable location. Searched ${searched.length} ` +
        `location${searched.length === 1 ? "" : "s"}: ${searched.join(", ")}`
    : "It was not found in any searchable location, and no driver directory exists yet."
}

/**
 * Import an optional package that is not a warehouse driver, returning
 * undefined when it is unavailable.
 *
 * Same bunfs problem as the drivers — a bare specifier cannot resolve inside
 * the compiled binary — but these callers have a legitimate fallback and must
 * not be handed an exception.
 */
export async function loadOptionalPackage(specifier: string): Promise<any | undefined> {
  try {
    return await import(/* @vite-ignore */ specifier)
  } catch (ambientError) {
    if (!isModuleNotFound(ambientError, specifier)) throw ambientError
    const resolved = resolveOptionalPackage(specifier, [
      ...searchRootsFromError(ambientError),
      ...driverSearchRoots(),
    ])
    if (!resolved) return undefined
    return await import(/* @vite-ignore */ pathToFileURL(resolved).href)
  }
}

/** True when `driver`'s packages are all resolvable right now. */
export function isDriverInstalled(driver: DriverName, roots = driverSearchRoots()): boolean {
  return DRIVER_PACKAGES[driver].every((pkg) => resolveOptionalPackage(pkg, roots) !== undefined)
}

/** Runs npm. Injectable so install behaviour can be tested without a registry. */
export type NpmRunner = (args: string[], cwd: string, timeoutMs: number) => Promise<{ code: number; output: string }>

export interface InstallOptions {
  timeoutMs?: number
  /** Rebuild even when the package resolves — the caller knows it does not load. */
  force?: boolean
  runNpm?: NpmRunner
}

export interface InstallResult {
  readonly driver: DriverName
  readonly packages: readonly string[]
  readonly dir: string
  readonly installed: boolean
  readonly alreadyPresent: boolean
  readonly error?: string
}

interface KillTreeResult {
  readonly verified: boolean
  readonly detail?: string
}

interface TaskkillResult {
  readonly code: number | null
  readonly detail?: string
  readonly timedOut?: boolean
}

type SpawnProcess = typeof spawn

interface KillTreeOptions {
  platform?: NodeJS.Platform
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  groupAlive?: (pid: number) => boolean
  processAlive?: (pid: number) => boolean
  signalGroup?: (pid: number, signal: NodeJS.Signals) => void
  taskkill?: (pid: number, timeoutMs: number) => Promise<TaskkillResult>
  termGraceMs?: number
  totalTimeoutMs?: number
  pollMs?: number
}

interface RunNpmOptions {
  spawnProcess?: SpawnProcess
  killTree?: (child: ReturnType<typeof spawn>) => Promise<KillTreeResult>
}

const KILL_TERM_GRACE_MS = 2_000
const KILL_TOTAL_TIMEOUT_MS = 5_000
const KILL_POLL_MS = 25

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but this user cannot signal it. Only ESRCH
    // proves absence; every other error stays conservative until the deadline.
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

function processGroupExists(pid: number): boolean {
  return processExists(-pid)
}

/** Run Windows' process-tree killer, including a bound for a hung taskkill. */
function runTaskkill(pid: number, timeoutMs: number, spawnProcess: SpawnProcess = spawn): Promise<TaskkillResult> {
  return new Promise((resolve) => {
    let settled = false
    let killer: ReturnType<typeof spawn> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: TaskkillResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    try {
      killer = spawnProcess("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      })
    } catch (error) {
      finish({ code: null, detail: error instanceof Error ? error.message : String(error) })
      return
    }

    killer.once("error", (error) => finish({ code: null, detail: error.message }))
    killer.once("close", (code) => finish({ code, detail: code === 0 ? undefined : `taskkill exited ${code}` }))
    timer = setTimeout(
      () => {
        try {
          killer?.kill()
        } catch {
          // The taskkill process may already be gone; the timeout remains the
          // authoritative result either way.
        }
        finish({ code: null, timedOut: true, detail: `taskkill did not exit within ${timeoutMs}ms` })
      },
      Math.max(0, timeoutMs),
    )
  })
}

async function waitUntilGone(alive: () => boolean, deadline: number, options: Required<KillTreeOptions>) {
  while (alive()) {
    const remaining = deadline - options.now()
    if (remaining <= 0) return false
    await options.sleep(Math.min(options.pollMs, remaining))
  }
  return true
}

/**
 * Terminate a spawned shell and everything it started.
 *
 * A child `exit` or `close` event proves only that the shell exited, not that
 * its descendants stopped. POSIX therefore polls the detached process group;
 * Windows trusts only a successful `taskkill /T /F`. Every path shares one
 * absolute deadline so a failed teardown cannot wedge the install queue.
 */
async function killTree(child: ReturnType<typeof spawn>, overrides: KillTreeOptions = {}): Promise<KillTreeResult> {
  const options: Required<KillTreeOptions> = {
    platform: process.platform,
    now: () => performance.now(),
    sleep,
    groupAlive: processGroupExists,
    processAlive: processExists,
    signalGroup: (pid, signal) => process.kill(-pid, signal),
    taskkill: (pid, timeoutMs) => runTaskkill(pid, timeoutMs),
    termGraceMs: KILL_TERM_GRACE_MS,
    totalTimeoutMs: KILL_TOTAL_TIMEOUT_MS,
    pollMs: KILL_POLL_MS,
    ...overrides,
  }
  const pid = child.pid
  if (pid === undefined) return { verified: true }
  const started = options.now()
  const deadline = started + Math.max(0, options.totalTimeoutMs)

  try {
    if (options.platform === "win32") {
      const result = await options.taskkill(pid, Math.max(0, deadline - options.now()))
      if (result.code === 0) return { verified: true }

      // A failed taskkill cannot verify the descendants. Kill and briefly wait
      // for the shell as a bounded fallback, but report the tree as unverified.
      try {
        child.kill("SIGKILL")
      } catch {
        // It may already have exited.
      }
      await waitUntilGone(() => options.processAlive(pid), deadline, options)
      return { verified: false, detail: result.detail ?? "taskkill failed" }
    }

    if (!options.groupAlive(pid)) return { verified: true }
    try {
      options.signalGroup(pid, "SIGTERM")
    } catch {
      try {
        child.kill("SIGTERM")
      } catch {
        // Liveness polling below remains authoritative.
      }
    }

    const termDeadline = Math.min(deadline, started + Math.max(0, options.termGraceMs))
    if (await waitUntilGone(() => options.groupAlive(pid), termDeadline, options)) return { verified: true }

    try {
      options.signalGroup(pid, "SIGKILL")
    } catch {
      try {
        child.kill("SIGKILL")
      } catch {
        // Liveness polling below remains authoritative.
      }
    }

    if (await waitUntilGone(() => options.groupAlive(pid), deadline, options)) return { verified: true }
    return {
      verified: false,
      detail: `process group ${pid} remained observable after ${Math.round(options.totalTimeoutMs)}ms`,
    }
  } catch (error) {
    return { verified: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

function runNpm(
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: RunNpmOptions = {},
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    // npm ships as a shell script on POSIX and a .cmd on Windows; `shell: true`
    // lets the platform resolve whichever is present on PATH. `detached` puts
    // the shell in its own process group on POSIX so a timeout can take the
    // whole group down.
    let child: ReturnType<typeof spawn>
    try {
      child = (options.spawnProcess ?? spawn)("npm", args, {
        cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      })
    } catch (error) {
      resolve({ code: 127, output: error instanceof Error ? error.message : String(error) })
      return
    }

    let output = ""
    let state: "running" | "terminating" | "settled" = "running"
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (code: number) => {
      if (state === "settled") return
      state = "settled"
      if (timer) clearTimeout(timer)
      resolve({ code, output: output.trim() })
    }

    timer = setTimeout(async () => {
      if (state !== "running") return
      state = "terminating"
      let cleanup: KillTreeResult
      try {
        cleanup = await (options.killTree ?? killTree)(child)
      } catch (error) {
        cleanup = { verified: false, detail: error instanceof Error ? error.message : String(error) }
      }
      output += `\nTimed out after ${Math.round(timeoutMs / 1000)}s.`
      if (!cleanup.verified)
        output += ` Process-tree cleanup could not be verified: ${cleanup.detail ?? "unknown error"}.`
      finish(124)
    }, timeoutMs)
    child.stdout?.on("data", (chunk) => (output += String(chunk)))
    child.stderr?.on("data", (chunk) => (output += String(chunk)))
    child.on("error", (error) => {
      if (state !== "running") return
      output += String(error instanceof Error ? error.message : error)
      finish(127)
    })
    child.on("close", (code) => {
      if (state !== "running") return
      finish(code ?? 1)
    })
  })
}

/** @internal — exported only for focused lifecycle and queue unit tests. */
export const _testing = { killTree, runNpm, runTaskkill, installOptionalDriver: installOptionalDriverInternal }

/**
 * Delete `packages` from the managed directory so a reinstall genuinely rebuilds
 * them. Best-effort: a path we cannot remove simply leaves npm to no-op, which
 * is the behaviour we already had.
 */
function removeInstalledPackages(dir: string, packages: readonly string[]): void {
  for (const pkg of packages) {
    try {
      fs.rmSync(path.join(dir, "node_modules", ...pkg.split("/")), { recursive: true, force: true })
    } catch {
      // Nothing to gain from failing the install over a stale directory.
    }
  }
}

/**
 * npm arguments for installing `packages` into the managed driver directory.
 *
 * `--save` is required, not incidental: with `--no-save` npm treats already
 * installed drivers as extraneous and prunes them on the next install.
 */
export function npmInstallArgs(packages: readonly string[]): string[] {
  return ["install", "--save", "--no-audit", "--no-fund", "--loglevel=error", ...packages]
}

/**
 * Install a driver's SDK into the managed driver directory.
 *
 * Installs must be recorded in the directory's own package.json. With
 * `--no-save`, npm treats every previously installed driver as extraneous and
 * prunes it: installing MySQL deleted Postgres, re-creating the very bug this
 * module exists to fix. Verified on npm 11.12.1 —
 * `added 12 packages, and removed 14 packages`.
 */
export function installOptionalDriver(driver: DriverName, options: InstallOptions = {}): Promise<InstallResult> {
  return installOptionalDriverInternal(driver, options)
}

async function installOptionalDriverInternal(
  driver: DriverName,
  options: InstallOptions = {},
  installed: (driver: DriverName) => boolean = isDriverInstalled,
): Promise<InstallResult> {
  const packages = DRIVER_PACKAGES[driver]
  const dir = driverInstallDir()

  // Serialize both readiness and mutation per directory. Checking readiness
  // before joining the queue let a caller return "already present" while a
  // forced repair ahead of it was deleting that same package.
  const pending = installsInFlight.get(dir)
  const run = Promise.resolve(pending)
    .catch(() => undefined)
    .then(() => {
      // `force` exists because the caller may know something this resolution
      // check cannot: that the package resolves but does not import.
      if (!options.force && installed(driver)) {
        return { driver, packages, dir, installed: true, alreadyPresent: true }
      }
      // Take the cross-process lock, then check readiness again. The peer that
      // held it has usually just installed the very thing we queued for, so
      // most contenders return "already present" instead of running a second
      // npm over the same tree — which is what produced the ENOTEMPTY races.
      return withInstallLock(dir, async (acquired) => {
        if (acquired && !options.force && installed(driver)) {
          return { driver, packages, dir, installed: true, alreadyPresent: true }
        }
        return performInstall(driver, packages, dir, options)
      })
    })
  installsInFlight.set(dir, run)
  try {
    return await run
  } finally {
    if (installsInFlight.get(dir) === run) installsInFlight.delete(dir)
  }
}

/** In-flight installs keyed by target directory (see the note above). */
const installsInFlight = new Map<string, Promise<InstallResult>>()

// ---------------------------------------------------------------------------
// Cross-process install lock
// ---------------------------------------------------------------------------

/**
 * `installsInFlight` serialises installs inside one process. It cannot see
 * other processes, and the managed driver directory is shared by all of them,
 * so N CLIs starting together each run `npm install` over the same tree:
 *
 *     npm install failed (exit 217) … ENOTEMPTY …
 *       rmdir /root/.local/share/altimate-code/drivers/node_modules/duckdb/…
 *
 * That is not benchmark-specific — any concurrent use of the CLI hits it.
 *
 * `mkdir` is atomic and fails with EEXIST when the directory exists, on both
 * POSIX and Windows, which makes a lock directory the portable primitive here.
 * The lock lives beside the install directory rather than inside it so npm
 * never sees it as stray package content.
 */
function installLockPath(dir: string): string {
  return `${dir.replace(/[\\/]+$/, "")}.lock`
}

interface LockHolder {
  pid: number
  hostname: string
  /** Absent when the owner file is malformed; age then falls back to mtime. */
  startedAt?: number
}

function readLockHolder(lockDir: string): LockHolder | undefined {
  try {
    const raw = fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return undefined
    const holder = parsed as Partial<LockHolder>
    if (typeof holder.pid !== "number") return undefined
    return {
      pid: holder.pid,
      hostname: typeof holder.hostname === "string" ? holder.hostname : "",
      startedAt: typeof holder.startedAt === "number" ? holder.startedAt : undefined,
    }
  } catch {
    return undefined
  }
}

/**
 * True when a lock cannot belong to a live install any more: its owner is gone,
 * or it has outlived any plausible npm run. Both checks are needed — a killed
 * process leaves no signal beyond its absence, and a lock from another host
 * (shared home directory) can only be judged by age.
 */
function isStaleLock(lockDir: string, holder: LockHolder | undefined, maxAgeMs: number): boolean {
  if (holder && holder.hostname === os.hostname() && !processExists(holder.pid)) return true
  const startedAt = holder?.startedAt
  if (typeof startedAt === "number" && Date.now() - startedAt > maxAgeMs) return true
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs > maxAgeMs
  } catch {
    // Vanished between checks — someone else released it, so it is not stale.
    return false
  }
}

/**
 * Run `fn` while holding an exclusive lock on `dir`, across processes.
 *
 * On timeout the work runs anyway rather than failing. A driver install that
 * races is recoverable — npm is largely idempotent here and the readiness check
 * afterwards is authoritative — whereas refusing to install because a lock
 * could not be taken turns a slow peer into a hard failure.
 */
export async function withInstallLock<T>(
  dir: string,
  fn: (acquired: boolean) => Promise<T>,
  options: { timeoutMs?: number; staleAfterMs?: number; pollMs?: number } = {},
): Promise<T> {
  const lockDir = installLockPath(dir)
  const timeoutMs = options.timeoutMs ?? 240_000
  const staleAfterMs = options.staleAfterMs ?? 300_000
  const pollMs = options.pollMs ?? 100
  const deadline = Date.now() + timeoutMs
  let acquired = false

  for (;;) {
    try {
      fs.mkdirSync(lockDir, { recursive: false })
      acquired = true
      break
    } catch (e) {
      // Anything but "already held" — an unwritable parent, say — means we
      // cannot lock at all, so proceed unlocked rather than block forever.
      const code = e && typeof e === "object" && "code" in e ? (e as { code?: unknown }).code : undefined
      if (code !== "EEXIST") break
      if (isStaleLock(lockDir, readLockHolder(lockDir), staleAfterMs)) {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true })
        } catch {
          // Another process won the cleanup; fall through and retry.
        }
        continue
      }
      if (Date.now() >= deadline) break
      await sleep(pollMs)
    }
  }

  if (acquired) {
    try {
      fs.writeFileSync(
        path.join(lockDir, "owner.json"),
        JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: Date.now() } satisfies LockHolder),
      )
    } catch {
      // Diagnostics only — the lock is the directory, not the file in it.
    }
  }

  try {
    return await fn(acquired)
  } finally {
    if (acquired) {
      try {
        fs.rmSync(lockDir, { recursive: true, force: true })
      } catch {
        // Leaving it behind is safe: the next contender ages it out as stale.
      }
    }
  }
}

async function performInstall(
  driver: DriverName,
  packages: readonly string[],
  dir: string,
  options: InstallOptions,
): Promise<InstallResult> {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const manifest = path.join(dir, "package.json")
    if (!fs.existsSync(manifest)) {
      // A private, versionless manifest keeps npm from warning on every install
      // and marks the directory as ours rather than a stray project.
      fs.writeFileSync(
        manifest,
        JSON.stringify(
          {
            name: "altimate-code-drivers",
            private: true,
            description: "Warehouse SDKs installed on demand by Altimate Code.",
          },
          null,
          2,
        ) + "\n",
      )
    }
  } catch (e) {
    return {
      driver,
      packages,
      dir,
      installed: false,
      alreadyPresent: false,
      error: `Could not create the driver directory ${dir}: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  // A repair has to delete the broken copy first. npm compares the manifest to
  // what is on disk, not the health of it, so with the package already recorded
  // it answers "up to date" and rewrites nothing — verified on npm 11.12.1
  // against a deliberately corrupted `pg`. `--force` does not change that; it
  // forces *fetching*, not overwriting an already-satisfied dependency.
  if (options.force) removeInstalledPackages(dir, packages)

  const npm = options.runNpm ?? runNpm
  const { code, output } = await npm(npmInstallArgs(packages), dir, options.timeoutMs ?? 180_000)

  if (code === 127) {
    return {
      driver,
      packages,
      dir,
      installed: false,
      alreadyPresent: false,
      error:
        `npm is not available on PATH, so ${DRIVER_LABELS[driver]} cannot be installed automatically. ` +
        `Install Node.js, then run: npm install --prefix ${shellQuote(dir)} ${packages.join(" ")}`,
    }
  }

  if (code !== 0) {
    return {
      driver,
      packages,
      dir,
      installed: false,
      alreadyPresent: false,
      error: `npm install failed (exit ${code}) for ${packages.join(", ")}: ${output || "no output"}`,
    }
  }

  // Confirm the target, not every ambient root. A broken project/NODE_PATH copy
  // can still resolve and is exactly what sends callers down the force-repair
  // path; letting it satisfy this check makes a no-op npm exit report success.
  if (!isDriverInstalled(driver, [path.join(dir, "node_modules")])) {
    return {
      driver,
      packages,
      dir,
      installed: false,
      alreadyPresent: false,
      error: `npm reported success but ${packages.join(", ")} is still not resolvable from ${dir}.`,
    }
  }

  return { driver, packages, dir, installed: true, alreadyPresent: false }
}
