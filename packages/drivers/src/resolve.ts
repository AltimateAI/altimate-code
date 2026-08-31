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
export function repairCwdPrefixedPath(candidate: string, cwd = safeCwd()): string | undefined {
  if (!candidate || !cwd || fs.existsSync(candidate)) return undefined
  if (!candidate.startsWith(cwd)) return undefined
  // POSIX concatenation yields `<cwd>/usr/…`, whose remainder carries the
  // separator. Windows has no separator to carry: `C:\work` + `C:\global\…`
  // concatenates to `C:\workC:\global\…`, and a join-shaped `C:\work\C:\global\…`
  // leaves a stray leading separator on the remainder. Try each shape and
  // accept only a remainder that is absolute and exists, so a near-miss such
  // as cwd `/work` against `/workspace/…` contributes nothing.
  const rest = candidate.slice(cwd.length)
  for (const remainder of rest.startsWith(path.sep) ? [rest, rest.slice(1)] : [rest]) {
    if (!remainder || !path.isAbsolute(remainder)) continue
    if (fs.existsSync(remainder)) return remainder
  }
  return undefined
}

/**
 * `process.cwd()` throws ENOENT when the working directory has been removed out
 * from under the process. Every caller here is formatting an error or repairing
 * a path, where throwing would replace the driver failure the caller is trying
 * to report with an unrelated ENOENT — losing the actual diagnosis.
 */
function safeCwd(): string | undefined {
  try {
    return process.cwd()
  } catch {
    return undefined
  }
}

/**
 * The `node_modules` content `driverSearchRoots()` deliberately refuses to
 * search: the working directory tree, and the project and ancestor
 * `node_modules` above it.
 */
function workspaceScope(): { cwd: string | undefined; ancestors: string[] } {
  const cwd = safeCwd()
  if (!cwd) return { cwd: undefined, ancestors: [] }
  const resolved = realPath(cwd)
  return { cwd: resolved, ancestors: nodeModulesUpward(resolved).map(realPath) }
}

/**
 * Absolute *real* path, falling back to the lexical one when the link cannot be
 * followed.
 *
 * The containment check below must compare real paths. `isDirectory` follows
 * symlinks, so a symlinked `node_modules` whose lexical path sits outside the
 * working directory but whose target sits inside it would pass a lexical
 * exclusion and be imported — reintroducing the workspace-controlled code the
 * exclusion exists to keep out.
 */
function realPath(candidate: string): string {
  try {
    return fs.realpathSync(path.resolve(candidate))
  } catch {
    return path.resolve(candidate)
  }
}

/**
 * Preserve order, drop repeats. A harvested root often names a directory the
 * inferred roots already cover, and listing it twice makes the searched-location
 * count in the failure message overstate where we actually looked.
 */
function dedupeRoots(roots: readonly string[]): string[] {
  return [...new Set(roots)]
}

/**
 * Every `node_modules` directory enclosing `candidate`, innermost first.
 *
 * All of them, not just the innermost: a quoted path often runs through a
 * driver's own dependency — `/opt/node_modules/duckdb/node_modules/node-addon-api/…`
 * — where the innermost root holds the dependency and the *outer* one holds the
 * driver we are actually looking for. Returning only the innermost left the
 * driver unfindable in exactly the nested case.
 *
 * `sep` is a parameter so the Windows behaviour is testable from a POSIX host.
 * It matters because Windows quotes both `C:\…` and `C:/…` in errors, while the
 * marker is built from the platform separator — a forward-slash path would
 * never match a backslash marker, and nothing would be harvested at all.
 * Rewriting separators is length-preserving, so the slice offsets still hold.
 */
export function enclosingNodeModulesRoots(candidate: string, sep: string = path.sep): string[] {
  const normalized = sep === "\\" ? candidate.replace(/\//g, "\\") : candidate
  const marker = `${sep}node_modules${sep}`
  const roots: string[] = []
  for (let at = normalized.lastIndexOf(marker); at !== -1; at = normalized.lastIndexOf(marker, at - 1)) {
    roots.push(normalized.slice(0, at + marker.length - 1))
    if (at === 0) break
  }
  return roots
}

/** True when `root` is workspace-controlled and must not be imported from. */
function isWorkspaceRoot(root: string, scope: { cwd: string | undefined; ancestors: string[] }): boolean {
  // Real paths on both sides: a symlink pointing into the workspace must not
  // slip past a purely lexical comparison.
  const resolved = realPath(root)
  if (scope.ancestors.includes(resolved)) return true
  // Fail closed. With no working directory there is nothing to compare against,
  // and treating that as "not workspace content" would admit every root an error
  // happens to name — turning the one case where the process cannot see its own
  // filesystem into the case with no boundary at all.
  if (!scope.cwd) return true
  const rel = path.relative(scope.cwd, resolved)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
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
 *
 * Workspace-controlled roots are never returned. `driverSearchRoots()` refuses
 * project and ancestor `node_modules` because importing a matching SDK during a
 * warehouse read/test would bypass the permission boundary and can expose
 * resolved credentials; mining a path out of an error message must not become a
 * way around that invariant.
 */
/**
 * Absolute paths a runtime quoted inside an error message.
 *
 * Three absolute shapes, and the third is the one that is easy to leave out:
 * POSIX `/…`, a drive letter `C:\…`, and a UNC share `\\server\share\…`. A
 * Windows error naming a driver on a share yields no roots at all without it,
 * so a driver stays unfindable even though the error named its exact location.
 */
export function quotedAbsolutePaths(message: string): string[] {
  const found: string[] = []
  const pattern = /['"`]((?:\/|[A-Za-z]:[\\/]|\\\\[^\\/'"`\n]+[\\/])[^'"`\n]+)['"`]/g
  for (const match of message.matchAll(pattern)) {
    const named = match[1]
    if (named) found.push(named)
  }
  return found
}

export function searchRootsFromError(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error)
  const scope = workspaceScope()
  const roots: string[] = []
  for (const named of quotedAbsolutePaths(message)) {
    for (const candidate of [named, repairCwdPrefixedPath(named)]) {
      if (!candidate) continue
      // Walk back to every enclosing node_modules directory, innermost first.
      for (const root of enclosingNodeModulesRoots(candidate)) {
        if (!isDirectory(root)) continue
        if (isWorkspaceRoot(root, scope)) continue
        if (!roots.includes(root)) roots.push(root)
      }
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
  // The anchor only has to be some absolute file URL — resolution is driven by
  // the explicit `paths` below, not by this base. So it must not be the one
  // thing that can throw: process.cwd() raises ENOENT when the working
  // directory has been removed, and letting that escape here replaces every
  // driver diagnosis with an unrelated uv_cwd error.
  const anchor = safeCwd() ?? os.tmpdir()
  const require = createRequire(pathToFileURL(path.join(anchor, "noop.js")).href)

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
/**
 * Load an already-resolved package from its own absolute location.
 *
 * `import(pathToFileURL(abs))` is not enough. The ESM loader reads the
 * package's manifest to decide the module's type and exports, and in a compiled
 * binary that lookup has been observed resolving against the *process working
 * directory* rather than the module's own directory — measured twice
 * independently, from a global install run under `--dir`:
 *
 *   ENOENT ... open '<cwd>/usr/lib/.../duckdb/package.json'
 *
 * while the file exists at that path without the `<cwd>` prefix. Supplying that
 * concatenated path is sufficient to make the load succeed, and running with
 * cwd `/` — which makes the concatenation a no-op — clears it too.
 *
 * A CommonJS require anchored at the resolved file makes every nested lookup,
 * the manifest included, relative to the driver's own directory, so the working
 * directory is never an input. The drivers we load this way are CommonJS; an
 * ESM-only package still needs the loader, so that path remains as a fallback
 * and is taken only for the error that specifically means "this is ESM".
 *
 * `process.chdir()` around the load would also neutralise the concatenation and
 * is deliberately not used: it is global mutable state, and these loads happen
 * under concurrency, so it would corrupt resolution for unrelated work
 * non-deterministically — worse than the fault it patches.
 */
function requireFromLocation(resolved: string): unknown {
  const requireFrom = createRequire(pathToFileURL(resolved).href)
  return requireFrom(resolved)
}

/** True when a require failed only because the target is an ES module. */
function isRequireOfEsm(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined
  if (code === "ERR_REQUIRE_ESM") return true
  const message = error instanceof Error ? error.message : String(error)
  return /require\(\) of ES Module|Cannot use import statement outside a module|Unexpected token 'export'/i.test(message)
}

/**
 * Load from `resolved`, preferring the cwd-independent path.
 *
 * The injected `importer` is still used for the ESM fallback so tests keep a
 * seam over the loader.
 */
async function loadFromLocation(resolved: string, importer: (spec: string) => Promise<any>): Promise<any> {
  try {
    return requireFromLocation(resolved)
  } catch (requireError) {
    if (!isRequireOfEsm(requireError)) throw requireError
    return await importer(pathToFileURL(resolved).href)
  }
}

export async function loadOptionalDriver(
  driver: DriverName,
  specifier: string,
  importer: (spec: string) => Promise<any> = (spec) => import(/* @vite-ignore */ spec),
): Promise<any> {
  try {
    return await importer(specifier)
  } catch (ambientError) {
    const ambientBroken = !isModuleNotFound(ambientError, specifier)
    // Trusted roots first, then the location the runtime itself named. When
    // ambient resolution fails it frequently quotes the absolute path it was
    // reaching for — including the case where it concatenated the working
    // directory onto an already-absolute path — and that is the only evidence
    // available when nothing else resolves. But it is evidence about wherever
    // the runtime happened to point, which may be a stale or broken copy, so it
    // must not preempt the managed installation: `driverSearchRoots()` puts the
    // driver we installed first precisely so it wins over a stale copy
    // elsewhere. Appending keeps that order and still recovers the failure this
    // exists for, because a harvested root is reached whenever the roots ahead
    // of it resolve nothing.
    const roots = dedupeRoots([...driverSearchRoots(), ...searchRootsFromError(ambientError)])
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
      return await loadFromLocation(resolved, importer)
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
  // A deleted working directory makes process.cwd() throw. This runs while a
  // driver failure is being formatted, so letting that escape would replace the
  // fault the reader needs with an unrelated ENOENT from the reporting path.
  const cwd = safeCwd()
  const lines = [`cwd=${cwd ?? "<unavailable>"}`, `execPath=${process.execPath}`]
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
    const resolved = resolveOptionalPackage(
      specifier,
      dedupeRoots([...driverSearchRoots(), ...searchRootsFromError(ambientError)]),
    )
    if (!resolved) return undefined
    return await loadFromLocation(resolved, (spec) => import(/* @vite-ignore */ spec))
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
      return withInstallLock(
        dir,
        async (acquired) => {
          if (acquired && !options.force && installed(driver)) {
            return { driver, packages, dir, installed: true, alreadyPresent: true }
          }
          return performInstall(driver, packages, dir, options)
        },
        // Outlast one peer's install. A lock wait shorter than the install it is
        // waiting on means a contender gives up while the holder's npm is still
        // running and then installs unlocked over the same tree, which is the
        // race this lock exists to stop. The two timeouts were independent
        // constants, so raising the install timeout alone silently broke it.
        { timeoutMs: (options.timeoutMs ?? 180_000) + 60_000 },
      )
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
export function installLockPath(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "")
  const separator = dir.includes("\\") ? "\\" : "/"
  // Trailing separators are stripped so `<dir>/` and `<dir>` agree on one lock.
  // A filesystem root is the exception: stripping there destroys the root, and
  // the result names something *outside* the directory being locked, so two
  // processes installing into the same place take different locks. Roots keep
  // their separator and the lock goes inside them.
  //
  //   /                ->  /.lock                 not the relative .lock
  //   C:\              ->  C:\.lock              not drive-relative C:.lock
  //   \\server\share\  ->  \\server\share\.lock  not a *different share*
  if (isFilesystemRoot(trimmed)) return `${trimmed}${separator}.lock`
  return `${trimmed}.lock`
}

/**
 * True when `candidate` — trailing separators already stripped — names a
 * filesystem root rather than a directory inside one.
 *
 * The UNC case is the one that is easy to miss: a share root is a root in
 * exactly the way a drive letter is, and appending `.lock` to it names an
 * unrelated share rather than anything under the directory being locked.
 */
function isFilesystemRoot(candidate: string): boolean {
  if (candidate === "") return true // POSIX "/" strips to ""
  if (/^[A-Za-z]:$/.test(candidate)) return true // "C:\" strips to "C:"
  return /^\\\\[^\\/]+\\[^\\/]+$/.test(candidate) // "\\server\share"
}

/**
 * The atomically-created lock itself, which lives *inside* the container
 * `installLockPath()` names.
 *
 * Two directories rather than one so every path this mechanism writes sits
 * under a single approved prefix. Stale recovery renames the held lock aside
 * before deleting it, and that destination has to be somewhere the install tool
 * asked permission for; a sibling of the container would be outside the
 * `<dir>.lock/*` pattern the tool brokers.
 */
function heldLockPath(dir: string): string {
  return path.join(installLockPath(dir), "held")
}

interface LockHolder {
  pid: number
  hostname: string
  /** Absent when the owner file is malformed; age then falls back to mtime. */
  startedAt?: number
  /** Identifies one acquisition, so a holder only ever releases its own lock. */
  token?: string
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
      token: typeof holder.token === "string" ? holder.token : undefined,
    }
  } catch {
    return undefined
  }
}

/**
 * True when a lock cannot belong to a live install any more.
 *
 * The two signals are not interchangeable, and which one applies depends on
 * whether liveness is decidable at all:
 *
 * - **Owner on this host.** Liveness is decidable, so it is the only thing that
 *   counts. Age must *not* also apply here: npm can legitimately run longer
 *   than any duration we pick — a native build such as `oracledb` or `duckdb`,
 *   or a caller that raised its own install timeout — and breaking a live
 *   owner's lock puts two `npm install` runs over the same tree, which is the
 *   exact corruption this lock exists to prevent.
 * - **No readable owner, or an owner on another host** (a shared home
 *   directory). Liveness cannot be established, so age is the only signal
 *   available and the lock ages out.
 */
function isStaleLock(
  lockDir: string,
  holder: LockHolder | undefined,
  maxAgeMs: number,
  hardMaxAgeMs: number,
): boolean {
  const age = lockAgeMs(lockDir, holder)
  if (holder && holder.hostname === os.hostname()) {
    if (!processExists(holder.pid)) return true
    // `processExists` answers "some process holds this pid", not "our installer
    // is still running": a crashed owner's pid can be recycled by an unrelated
    // long-lived process, and liveness alone would then keep the lock forever,
    // making every later install wait out its timeout and run unlocked. So a
    // live same-host owner is protected, but only up to a backstop far beyond
    // any real npm run — long enough never to interrupt an install, short
    // enough that a recycled pid cannot wedge the directory permanently.
    return age !== undefined && age > hardMaxAgeMs
  }
  // No readable owner, or an owner on another host sharing a home directory.
  // Liveness is not decidable, so age is the only signal there is.
  return age !== undefined && age > maxAgeMs
}

/** How long the lock has been held, by owner record or directory mtime. */
function lockAgeMs(lockDir: string, holder: LockHolder | undefined): number | undefined {
  const startedAt = holder?.startedAt
  if (typeof startedAt === "number") return Date.now() - startedAt
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs
  } catch {
    // Vanished between checks — someone else released it, so it is not stale.
    return undefined
  }
}

/** True when two owner records describe the same acquisition. */
function sameHolder(a: LockHolder | undefined, b: LockHolder | undefined): boolean {
  if (!a || !b) return a === b
  return a.pid === b.pid && a.hostname === b.hostname && a.startedAt === b.startedAt && a.token === b.token
}

/**
 * Take ownership of a lock judged stale, atomically, and remove it.
 *
 * Two processes can both judge the same lock stale. If each simply deleted the
 * pathname, the first would delete the dead lock and acquire a fresh one, and
 * the second would then delete *that* live lock and acquire its own — putting
 * both inside the critical section, which is the failure the lock exists to
 * prevent. `rename` is atomic: exactly one process can move a given directory,
 * and only that process goes on to delete it. The loser's rename fails and it
 * simply retries against whatever state now exists.
 */
function claimStaleLock(lockDir: string, judged: LockHolder | undefined): boolean {
  // The staleness verdict was formed before this call, and the owner can have
  // released the lock and a peer re-taken it since. Renaming blindly would move
  // a *live* lock aside and put two installs over the same tree. Check the owner
  // record still matches the one judged stale before touching anything.
  if (!sameHolder(judged, readLockHolder(lockDir))) return false

  const claimed = path.join(path.dirname(lockDir), `stale-${process.pid}-${Date.now().toString(36)}`)
  try {
    fs.renameSync(lockDir, claimed)
  } catch {
    // Another process claimed it first, the owner released it, or the parent
    // does not permit rename. Nothing of ours to clean up.
    return false
  }

  // The check above narrows the window but cannot close it — nothing makes
  // "read the owner" and "rename" one operation. So confirm what was actually
  // moved, and put it back if a peer had re-taken the lock in between.
  if (!sameHolder(judged, readLockHolder(claimed))) {
    try {
      fs.renameSync(claimed, lockDir)
      return false
    } catch {
      // Cannot restore — a third process has already re-created the lock. Fall
      // through and remove what we moved rather than leaking it.
    }
  }

  try {
    fs.rmSync(claimed, { recursive: true, force: true })
  } catch {
    // The rename already made the lock unreachable, so a leftover directory
    // costs nothing but disk.
  }
  return true
}

/**
 * Release a lock this process acquired, but only while it is still ours.
 *
 * A lock we hold can be broken as stale and re-taken by a peer while `fn` is
 * still running — an install that outlives `staleAfterMs` on a machine whose
 * owner record is unreadable, say. Removing it by pathname would then delete
 * the successor's live lock and admit a third process. The token is written
 * when the lock is taken, so a mismatch means the directory is somebody else's.
 */
function releaseInstallLock(lockDir: string, token: string, ino: number | undefined): void {
  const holder = readLockHolder(lockDir)
  if (holder?.token !== undefined) {
    if (holder.token !== token) return
  } else if (ino !== undefined) {
    // No token to compare against. There is a real window for this: the lock
    // directory is created before `owner.json` is written, so a successor that
    // re-took the lock in between holds a live lock carrying no token, and
    // removing it by pathname would admit a third process. The directory's own
    // identity settles it — a different inode is a different lock.
    try {
      if (fs.statSync(lockDir).ino !== ino) return
    } catch {
      return
    }
  }
  try {
    fs.rmSync(lockDir, { recursive: true, force: true })
  } catch {
    // Leaving it behind is safe: the next contender ages it out as stale.
  }
}

/**
 * A value that changes when the lock changes hands.
 *
 * The owner's token when it published one; otherwise the lock directory's own
 * identity, which a fresh `mkdir` changes even when the owner file is missing
 * or unreadable. `undefined` means we could not tell, and the caller then
 * treats the holder as unchanged rather than inventing progress.
 */
function lockIdentity(lockDir: string, holder: LockHolder | undefined): string | undefined {
  if (holder?.token) return holder.token
  try {
    const stat = fs.statSync(lockDir)
    return `${stat.ino}:${stat.mtimeMs}`
  } catch {
    return undefined
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
  options: { timeoutMs?: number; staleAfterMs?: number; hardStaleAfterMs?: number; pollMs?: number } = {},
): Promise<T> {
  const lockDir = heldLockPath(dir)
  const timeoutMs = options.timeoutMs ?? 240_000
  const staleAfterMs = options.staleAfterMs ?? 300_000
  const hardStaleAfterMs = options.hardStaleAfterMs ?? Math.max(staleAfterMs, 3_600_000)
  const pollMs = options.pollMs ?? 100
  let deadline = Date.now() + timeoutMs
  // The budget is per *holder*, not per wait. Every process counts its deadline
  // from its own start, so a single budget only ever outlasts one peer: with
  // three or more contenders the last one's deadline expires part-way through
  // somebody else's install and it falls through to an unlocked performInstall
  // — the concurrent npm mutation this lock exists to prevent. Seeing the lock
  // change hands is proof the queue is moving rather than wedged, so each new
  // holder gets its own budget. Extensions are capped so a machine that keeps
  // feeding in contenders cannot block a caller indefinitely.
  const maxHandovers = 32
  let handovers = 0
  let lastHolder: string | undefined
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  let acquired = false
  let ino: number | undefined

  // The container must exist before the atomic mkdir inside it can land. On a
  // cold machine nothing has created the XDG data directory yet —
  // `performInstall` is the first thing that does, and it runs *after* this — so
  // a non-recursive mkdir would fail ENOENT, take the "cannot lock" branch, and
  // drop every caller straight into an unlocked install. That is precisely the
  // cold-start stampede this lock exists to prevent.
  try {
    fs.mkdirSync(path.dirname(lockDir), { recursive: true })
  } catch {
    // Genuinely unwritable. The acquire below then fails too and we proceed
    // unlocked, which is the documented degradation.
  }

  for (;;) {
    try {
      fs.mkdirSync(lockDir, { recursive: false })
      acquired = true
      try {
        ino = fs.statSync(lockDir).ino
      } catch {
        // Identity check is skipped on release; the token check still applies.
      }
      break
    } catch (e) {
      // Anything but "already held" — an unwritable parent, say — means we
      // cannot lock at all, so proceed unlocked rather than block forever.
      const code = e && typeof e === "object" && "code" in e ? (e as { code?: unknown }).code : undefined
      if (code !== "EEXIST") break
      const holder = readLockHolder(lockDir)
      const identity = lockIdentity(lockDir, holder)
      if (identity !== undefined && identity !== lastHolder) {
        if (lastHolder !== undefined && handovers < maxHandovers) {
          handovers++
          deadline = Date.now() + timeoutMs
        }
        lastHolder = identity
      }
      if (isStaleLock(lockDir, holder, staleAfterMs, hardStaleAfterMs)) {
        // A claim can fail persistently — a lock owned by another user, or a
        // container that permits inspection but not rename. Retrying such a
        // claim without yielding spins at full CPU and never reaches the
        // deadline, so only a claim that actually succeeded skips the wait.
        if (claimStaleLock(lockDir, holder)) continue
      }
      if (Date.now() >= deadline) break
      await sleep(pollMs)
    }
  }

  if (acquired) {
    try {
      fs.writeFileSync(
        path.join(lockDir, "owner.json"),
        JSON.stringify({
          pid: process.pid,
          hostname: os.hostname(),
          startedAt: Date.now(),
          token,
        } satisfies LockHolder),
      )
    } catch {
      // Diagnostics only — the lock is the directory, not the file in it.
    }
  }

  try {
    return await fn(acquired)
  } finally {
    if (acquired) releaseInstallLock(lockDir, token, ino)
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
