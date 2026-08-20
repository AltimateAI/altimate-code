/**
 * Resolution and on-demand installation for optional warehouse SDKs.
 *
 * Warehouse SDKs (`snowflake-sdk`, `pg`, `@google-cloud/bigquery`, …) are
 * optional dependencies: they are marked external in the binary build and
 * installed per warehouse, on demand. Two things broke that arrangement.
 *
 * 1. A bare `import("snowflake-sdk")` inside the compiled Bun binary resolves
 *    against bunfs, which has no `node_modules`. An SDK the user had already
 *    installed — globally, or into the project — was invisible to the runtime,
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
import { pathToFileURL } from "node:url"
import { spawn } from "node:child_process"

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
        `  npm install --prefix ${driverInstallDir()} ${packages.join(" ")}\n` +
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

  // 4. The project the user is working in, and every parent of it — covers a
  //    plain `npm install snowflake-sdk` in the dbt project.
  for (const dir of nodeModulesUpward(process.cwd())) push(dir)

  // 5. Around the running executable. For `npm install -g` this is the global
  //    root, which is what makes a globally installed SDK resolvable.
  try {
    for (const dir of nodeModulesUpward(path.dirname(fs.realpathSync(process.execPath)))) push(dir)
  } catch {
    // execPath may not be resolvable (bunfs); the roots above still apply.
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
export async function loadOptionalDriver(driver: DriverName, specifier: string): Promise<any> {
  try {
    return await import(/* @vite-ignore */ specifier)
  } catch (ambientError) {
    // Only a resolution failure means "look elsewhere". A package that resolves
    // ambiently but throws while loading is a broken install, and re-reporting
    // it as missing would send the user to install what they already have.
    if (!isModuleNotFound(ambientError)) throw loadFailure(driver, specifier, ambientError)

    const roots = driverSearchRoots()
    const resolved = resolveOptionalPackage(specifier, roots)
    if (!resolved) throw new DriverNotInstalledError(driver, DRIVER_PACKAGES[driver], roots)

    try {
      return await import(/* @vite-ignore */ pathToFileURL(resolved).href)
    } catch (loadError) {
      // On disk but will not load — a half-installed copy, or a native addon
      // built for another platform.
      throw loadFailure(driver, resolved, loadError)
    }
  }
}

/** True when `error` means the module could not be resolved, not that it failed while loading. */
export function isModuleNotFound(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true
  const message = error instanceof Error ? error.message : String(error)
  return /Cannot find (module|package)/i.test(message)
}

function loadFailure(driver: DriverName, where: string, error: unknown): Error {
  return new Error(
    `${DRIVER_LABELS[driver]} driver found at ${where} but failed to load: ` +
      `${error instanceof Error ? error.message : String(error)}`,
  )
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
    if (!isModuleNotFound(ambientError)) throw ambientError
    const resolved = resolveOptionalPackage(specifier)
    if (!resolved) return undefined
    return await import(/* @vite-ignore */ pathToFileURL(resolved).href)
  }
}

/** True when `driver`'s packages are all resolvable right now. */
export function isDriverInstalled(driver: DriverName, roots = driverSearchRoots()): boolean {
  return DRIVER_PACKAGES[driver].every((pkg) => resolveOptionalPackage(pkg, roots) !== undefined)
}

export interface InstallResult {
  readonly driver: DriverName
  readonly packages: readonly string[]
  readonly dir: string
  readonly installed: boolean
  readonly alreadyPresent: boolean
  readonly error?: string
}

function runNpm(args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    // npm ships as a shell script on POSIX and a .cmd on Windows; `shell: true`
    // lets the platform resolve whichever is present on PATH.
    const child = spawn("npm", args, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    let settled = false
    const finish = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, output: output.trim() })
    }
    const timer = setTimeout(() => {
      child.kill()
      output += `\nTimed out after ${Math.round(timeoutMs / 1000)}s.`
      finish(124)
    }, timeoutMs)
    child.stdout?.on("data", (chunk) => (output += String(chunk)))
    child.stderr?.on("data", (chunk) => (output += String(chunk)))
    child.on("error", (err) => {
      output += String(err instanceof Error ? err.message : err)
      finish(127)
    })
    child.on("close", (code) => finish(code ?? 1))
  })
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
export async function installOptionalDriver(
  driver: DriverName,
  options: { timeoutMs?: number } = {},
): Promise<InstallResult> {
  const packages = DRIVER_PACKAGES[driver]
  const dir = driverInstallDir()

  if (isDriverInstalled(driver)) {
    return { driver, packages, dir, installed: true, alreadyPresent: true }
  }

  try {
    fs.mkdirSync(dir, { recursive: true })
    const manifest = path.join(dir, "package.json")
    if (!fs.existsSync(manifest)) {
      // A private, versionless manifest keeps npm from warning on every install
      // and marks the directory as ours rather than a stray project.
      fs.writeFileSync(
        manifest,
        JSON.stringify({ name: "altimate-code-drivers", private: true, description: "Warehouse SDKs installed on demand by Altimate Code." }, null, 2) + "\n",
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

  const { code, output } = await runNpm(npmInstallArgs(packages), dir, options.timeoutMs ?? 180_000)

  if (code === 127) {
    return {
      driver,
      packages,
      dir,
      installed: false,
      alreadyPresent: false,
      error:
        `npm is not available on PATH, so ${DRIVER_LABELS[driver]} cannot be installed automatically. ` +
        `Install Node.js, then run: npm install --prefix ${dir} ${packages.join(" ")}`,
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

  // Confirm against the resolver rather than trusting npm's exit code — an
  // install that lands somewhere we do not search is not a working driver.
  if (!isDriverInstalled(driver)) {
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
