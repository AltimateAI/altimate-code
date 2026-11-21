/**
 * dbt package installation that is safe to run from many `altimate-dbt`
 * processes at once.
 *
 * Why this exists: `@altimateai/dbt-integration` runs `dbt deps` unconditionally
 * the first time an adapter parses the manifest (its
 * `installDepsOnProjectInitialization` setting, which `adapter.ts` now turns
 * off). `dbt deps` deletes and re-extracts every package directory, so two
 * `altimate-dbt` processes started together (the finish-time validators start
 * several) could leave `dbt_packages/<pkg>/dbt_project.yml` missing or half
 * written, which makes every later dbt command fail with "No dbt_project.yml
 * found". Installation is now (1) skipped when the installed packages already
 * satisfy what the project declares, and (2) serialised by a cross-process
 * lock with a stale-owner story when it is needed.
 *
 * State lives under `<project>/target/.altimate-dbt/`:
 *   packages.lock/        mkdir-based lock; owner.json inside; mtime = heartbeat
 *   packages.lock.break/  short-lived guard so only one process breaks a stale lock
 *   packages.stamp.json   fingerprint of the declaration files + package dirs of the last good install
 *   packages.dirty        present while an install is running or after one did not finish
 */

import { execFile } from "child_process"
import { createHash, randomUUID } from "crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "fs"
import { hostname } from "os"
import { isAbsolute, join, relative, resolve } from "path"
import { parse as parseYaml } from "yaml"
import { bufferLog } from "./log-buffer"
import { buildDbtEnv, resolveDbt } from "./dbt-resolve"

const STATE_DIR = join("target", ".altimate-dbt")
const DECLARATION_FILES = ["packages.yml", "dependencies.yml", "package-lock.yml"] as const
const DEFAULT_INSTALL_PATH = "dbt_packages"

/** A lock whose heartbeat is older than this (or whose owner process is gone) may be broken. */
export const DEFAULT_STALE_MS = 30_000
const DEFAULT_HEARTBEAT_MS = 2_000
/** Upper bound on waiting for another process's install before giving up on the lock. */
const DEFAULT_MAX_WAIT_MS = 10 * 60_000
const DEPS_TIMEOUT_MS = 5 * 60_000
const BREAK_GUARD_STALE_MS = 30_000

export interface LockOptions {
  staleMs?: number
  heartbeatMs?: number
  maxWaitMs?: number
}

/** Thrown when another process holds the package install lock for longer than we are willing to wait. */
export class PackageLockTimeoutError extends Error {}

export type EnsureAction = "none" | "skipped" | "skipped-after-wait" | "installed"

export interface EnsureResult {
  action: EnsureAction
  /** Why an install was (or was not) needed. */
  reason: string
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const jitter = (base: number) => base + Math.floor(Math.random() * base)

// ---------------------------------------------------------------------------
// Declared vs installed
// ---------------------------------------------------------------------------

interface Declared {
  /** Hub packages carry a predictable install directory name; others do not. */
  hubDir?: string
}

function readYaml(path: string): unknown {
  try {
    return parseYaml(readFileSync(path, "utf-8"))
  } catch {
    return undefined
  }
}

function projectInstallPath(root: string): string | undefined {
  const cfg = readYaml(join(root, "dbt_project.yml")) as Record<string, unknown> | undefined
  const raw = cfg?.["packages-install-path"]
  if (typeof raw !== "string" || raw.length === 0) return resolve(root, DEFAULT_INSTALL_PATH)
  if (!raw.includes("{{") && !raw.includes("{%")) return resolve(root, raw)

  // Resolve dbt's common env_var form without guessing the result of other Jinja.
  const envVar = /^\s*{{\s*env_var\s*\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*(?:,\s*(['"])(.*?)\3\s*)?\)\s*}}\s*$/.exec(raw)
  if (!envVar) return
  const value = process.env[envVar[2]!] ?? envVar[4]
  if (value) return resolve(root, value)
}

/** Check current declarations as well as the lock, which can lag the project. */
function declaredPackages(root: string): Declared[] {
  const packages = new Map<string, Declared>()
  for (const file of ["package-lock.yml", "packages.yml", "dependencies.yml"]) {
    const doc = readYaml(join(root, file)) as { packages?: unknown } | undefined
    if (!Array.isArray(doc?.packages)) continue
    for (const entry of doc.packages) {
      if (!entry || typeof entry !== "object") continue
      const spec = entry as Record<string, unknown>
      if (typeof spec.package === "string") {
        packages.set(`hub:${spec.package}`, { hubDir: spec.package.split("/").pop() ?? spec.package })
      } else {
        const kind = ["local", "git", "tarball", "private"].find((key) => typeof spec[key] === "string")
        const identity = kind ? JSON.stringify([kind, spec[kind], spec.subdirectory ?? ""]) : JSON.stringify(spec)
        packages.set(identity, {})
      }
    }
  }
  return [...packages.values()]
}

/** Directories under the install path that look like a complete package. */
function completePackageDirs(installPath: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>()
  if (!existsSync(installPath)) return out
  for (const name of readdirSync(installPath)) {
    if (name.startsWith(".")) continue
    const dir = join(installPath, name)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue // dangling symlink
    }
    const projectFile = join(dir, "dbt_project.yml")
    if (!existsSync(projectFile)) continue
    // A truncated or half-written file is not a complete package.
    const project = readYaml(projectFile)
    if (!project || typeof project !== "object" || Array.isArray(project)) continue
    const v = (project as { version?: unknown }).version
    out.set(name, v === undefined ? undefined : String(v))
  }
  return out
}

/** Every directory directly under the install path, complete or not. Plain files and dangling links are not packages. */
function allPackageDirs(installPath: string): string[] {
  if (!existsSync(installPath)) return []
  return readdirSync(installPath).filter((n) => {
    if (n.startsWith(".")) return false
    try {
      return statSync(join(installPath, n)).isDirectory()
    } catch {
      return false
    }
  })
}

const PACKAGE_ENV_VAR = /\benv_var\s*\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1/g

function declarationContents(root: string) {
  return DECLARATION_FILES.flatMap((file) => {
    const path = join(root, file)
    return existsSync(path) ? [{ file, text: readFileSync(path, "utf8") }] : []
  })
}

function fingerprint(
  root: string,
  installPath: string,
  declarations = declarationContents(root),
): string {
  const h = createHash("sha256")
  // The install path decides which directories hold the packages, so a change of it invalidates the stamp.
  // Relative to the project when inside it, so reaching the same project through a symlink gives
  // the same fingerprint; a path outside the project is kept as written.
  const rel = relative(root, installPath)
  h.update(rel.startsWith("..") || isAbsolute(rel) ? installPath : rel).update("\0")
  for (const { file, text } of declarations) {
    h.update(file).update("\0").update(text).update("\0")
    for (const match of text.matchAll(PACKAGE_ENV_VAR)) {
      const name = match[2]!
      h.update(JSON.stringify([name, process.env[name]])).update("\0")
    }
  }
  return h.digest("hex")
}

function stateDir(root: string): string {
  return join(root, STATE_DIR)
}

interface Stamp {
  fingerprint: string
  packages: string[]
}

function readStamp(root: string): Stamp | undefined {
  try {
    return JSON.parse(readFileSync(join(stateDir(root), "packages.stamp.json"), "utf-8")) as Stamp
  } catch {
    return undefined
  }
}

export interface SatisfiedResult {
  ok: boolean
  reason: string
}

/**
 * Do the installed packages satisfy what the project declares? Read-only and
 * cheap; this is what lets the common case skip `dbt deps` entirely.
 */
export function packagesSatisfied(root: string): SatisfiedResult {
  const declared = declaredPackages(root)
  if (declared.length === 0) return { ok: true, reason: "no packages declared" }
  if (existsSync(join(stateDir(root), "packages.dirty")))
    return { ok: false, reason: "a previous or concurrent install has not finished" }

  const installPath = projectInstallPath(root)
  if (!installPath) return { ok: false, reason: "packages-install-path cannot be determined before dbt runs" }
  const installed = completePackageDirs(installPath)
  const incomplete = allPackageDirs(installPath).filter((n) => !installed.has(n))
  if (incomplete.length > 0) return { ok: false, reason: `incomplete package directory: ${incomplete.join(", ")}` }

  const declarations = declarationContents(root)
  const stamp = readStamp(root)
  if (stamp) {
    if (stamp.fingerprint !== fingerprint(root, installPath, declarations))
      return { ok: false, reason: "package declarations changed since the last install" }
    const gone = stamp.packages.filter((p) => !installed.has(p))
    if (gone.length > 0) return { ok: false, reason: `installed package missing: ${gone.join(", ")}` }
    return { ok: true, reason: "installed packages match the last install of these declarations" }
  }

  if (declarations.some(({ text }) => !text.matchAll(PACKAGE_ENV_VAR).next().done)) {
    return { ok: false, reason: "environment-dependent packages have no install stamp" }
  }

  // A lock older than the declarations, or an installation older than either,
  // may represent a different set of versions even if the directory names match.
  const declaredAt = Math.max(
    ...["packages.yml", "dependencies.yml"].map((file) => statSync(join(root, file), { throwIfNoEntry: false })?.mtimeMs ?? 0),
  )
  const lockedAt = statSync(join(root, "package-lock.yml"), { throwIfNoEntry: false })?.mtimeMs ?? 0
  const installedAt = statSync(installPath, { throwIfNoEntry: false })?.mtimeMs
  if (lockedAt && declaredAt > lockedAt) return { ok: false, reason: "packages.yml is newer than package-lock.yml" }
  if (installedAt !== undefined && (declaredAt > installedAt || lockedAt > installedAt + 1000)) {
    return { ok: false, reason: "package declarations are newer than the installed package directory" }
  }

  // No stamp: packages were installed by something else (image build, `dbt deps` by hand).
  // Hub packages can be verified by name. The version is not compared: the `version:` in an
  // installed hub package's dbt_project.yml is not kept in step with its release (a package
  // locked at 1.3.0 can report 0.1.0), so comparing it would reinstall on every start.
  let unverifiable = 0
  for (const d of declared) {
    if (!d.hubDir) {
      unverifiable++
      continue
    }
    if (!installed.has(d.hubDir)) return { ok: false, reason: `package ${d.hubDir} is not installed` }
  }
  const nonHubInstalled = [...installed.keys()].filter((n) => !declared.some((d) => d.hubDir === n)).length
  if (nonHubInstalled < unverifiable) return { ok: false, reason: "fewer non-hub packages installed than declared" }
  return { ok: true, reason: "installed packages satisfy the declarations" }
}

// ---------------------------------------------------------------------------
// Cross-process lock
// ---------------------------------------------------------------------------

interface Owner {
  pid: number
  host: string
  token: string
  startedAt: number
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

function readOwner(lockDir: string): Owner | undefined {
  try {
    return JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf-8")) as Owner
  } catch {
    return undefined
  }
}

function lockIsStale(lockDir: string, staleMs: number): boolean {
  let mtime: number
  try {
    mtime = statSync(lockDir).mtimeMs
  } catch {
    return false // already gone
  }
  const owner = readOwner(lockDir)
  if (owner && owner.host === hostname() && owner.pid !== process.pid && !pidAlive(owner.pid)) return true
  return Date.now() - mtime > staleMs
}

/** Remove a stale lock. A guard directory makes sure only one process does it at a time. */
function breakStaleLock(lockDir: string, staleMs: number, observedToken: string | undefined): void {
  const guard = `${lockDir}.break`
  try {
    mkdirSync(guard)
  } catch {
    try {
      if (Date.now() - statSync(guard).mtimeMs > BREAK_GUARD_STALE_MS) rmSync(guard, { recursive: true, force: true })
    } catch {}
    return
  }
  try {
    // Re-check under the guard: the lock may have been released and re-taken since we looked.
    // A new owner has a new token, so only the lock we judged stale is removed.
    if (readOwner(lockDir)?.token === observedToken && lockIsStale(lockDir, staleMs)) {
      bufferLog(`[dbt-tools] breaking stale package lock ${lockDir}`)
      rmSync(lockDir, { recursive: true, force: true })
    }
  } finally {
    rmSync(guard, { recursive: true, force: true })
  }
}

async function acquire(root: string, opts: Required<LockOptions>): Promise<() => void> {
  const dir = stateDir(root)
  const lockDir = join(dir, "packages.lock")
  mkdirSync(dir, { recursive: true })
  const deadline = Date.now() + opts.maxWaitMs
  for (;;) {
    try {
      mkdirSync(lockDir)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
      if (lockIsStale(lockDir, opts.staleMs)) breakStaleLock(lockDir, opts.staleMs, readOwner(lockDir)?.token)
      if (Date.now() > deadline) throw new PackageLockTimeoutError(`timed out after ${opts.maxWaitMs}ms waiting for the package install lock at ${lockDir}`)
      await sleep(jitter(50))
    }
  }
  const owner: Owner = { pid: process.pid, host: hostname(), token: randomUUID(), startedAt: Date.now() }
  writeFileSync(join(lockDir, "owner.json"), JSON.stringify(owner))
  const beat = setInterval(() => {
    try {
      if (readOwner(lockDir)?.token !== owner.token) {
        bufferLog("[dbt-tools] package install lock was taken over; continuing without it")
        clearInterval(beat)
        return
      }
      const now = new Date()
      utimesSync(lockDir, now, now)
    } catch {}
  }, opts.heartbeatMs)
  beat.unref()
  return () => {
    clearInterval(beat)
    // Only remove the lock if it is still ours. Releasing is best-effort: a failure to delete
    // must not replace the result of the install that already finished.
    try {
      if (readOwner(lockDir)?.token === owner.token) rmSync(lockDir, { recursive: true, force: true })
    } catch (e) {
      bufferLog(`[dbt-tools] could not release the package lock: ${String(e)}`)
    }
  }
}

function withDefaults(o?: LockOptions): Required<LockOptions> {
  return {
    staleMs: o?.staleMs ?? DEFAULT_STALE_MS,
    heartbeatMs: o?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    maxWaitMs: o?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
  }
}

/** Run `fn` while holding the project's package lock. */
export async function withPackagesLock<T>(root: string, fn: () => Promise<T>, opts?: LockOptions): Promise<T> {
  const release = await acquire(root, withDefaults(opts))
  try {
    return await fn()
  } finally {
    release()
  }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

// dbt writes package-lock.yml during deps. The project declarations and the
// destination it read must stay stable while the installer is running.
function installInputs(root: string, installPath: string, declarations = declarationContents(root)): string {
  return fingerprint(root, installPath, declarations.filter(({ file }) => file !== "package-lock.yml"))
}

/**
 * Run an install while holding the lock, bracketed by the `dirty` marker so a
 * crash or failure mid-install is noticed (and repaired) by the next caller.
 * Caller must already hold the lock.
 */
async function installUnderLock<T>(root: string, install: () => Promise<T>, record: boolean): Promise<T> {
  const dir = stateDir(root)
  const dirty = join(dir, "packages.dirty")
  mkdirSync(dir, { recursive: true }) // `dbt clean` may have removed target/ while we waited
  writeFileSync(dirty, JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
  const originalPath = projectInstallPath(root)
  const inputsBefore = originalPath && installInputs(root, originalPath)
  const result = await install()
  const installPath = projectInstallPath(root)
  const stampFile = join(dir, "packages.stamp.json")
  if (!installPath) {
    // An explicit deps command can resolve Jinja itself. Its output is authoritative
    // when we cannot inspect the resulting directory.
    rmSync(stampFile, { force: true })
    if (!failedCommand(result)) rmSync(dirty, { force: true })
    return result
  }
  const declarationsAfter = declarationContents(root)
  if (inputsBefore !== installInputs(root, installPath, declarationsAfter)) {
    // The install may have consumed the earlier declarations. Leave the dirty
    // marker so the next adapter-backed command repairs the current inputs.
    rmSync(stampFile, { force: true })
    return result
  }
  const complete = [...completePackageDirs(installPath).keys()]
  const broken = allPackageDirs(installPath).filter((n) => !complete.includes(n))
  // An explicit install (record = false) returns dbt's own failure result instead, so the
  // caller can show dbt's message rather than this one; the dirty marker stays for the next check.
  const incomplete = declaredPackages(root).length > 0 && (complete.length === 0 || broken.length > 0)
  if (incomplete && record) {
    throw new Error(`dbt deps finished but the package directory is incomplete${broken.length ? `: ${broken.join(", ")}` : ""}`)
  }
  if (record || (!incomplete && commandExitCode(result) === 0)) {
    writeFileSync(stampFile, JSON.stringify({ fingerprint: fingerprint(root, installPath, declarationsAfter), packages: complete } satisfies Stamp))
  } else {
    // An explicit install may return no exit status. The next call verifies
    // the directories rather than trusting the old stamp.
    rmSync(stampFile, { force: true })
  }
  if (!incomplete && !failedCommand(result)) rmSync(dirty, { force: true })
  return result
}

function commandExitCode(result: unknown): number | undefined {
  if (result && typeof result === "object" && "exitCode" in result && typeof result.exitCode === "number") {
    return result.exitCode
  }
}

function failedCommand(result: unknown): boolean {
  if (!result || typeof result !== "object") return false
  const exitCode = commandExitCode(result)
  if (exitCode !== undefined) return exitCode !== 0
  const output = result as { stderr?: string; stdout?: string }
  // Older engines can omit the status. dbt also emits progress on stderr, so
  // that stream by itself does not establish a failure.
  return /Encountered an error|(?:Compilation|Parsing|Runtime|Database) Error/i.test(
    `${output.stderr ?? ""}\n${output.stdout ?? ""}`,
  )
}

/**
 * Make sure the declared packages are installed. Installs at most once per
 * change of declarations, however many processes ask at the same time.
 */
export async function ensurePackages(
  root: string,
  install: () => Promise<unknown>,
  opts?: LockOptions,
): Promise<EnsureResult> {
  if (declaredPackages(root).length === 0) return { action: "none", reason: "no packages declared" }
  if (!projectInstallPath(root)) {
    const reason = "Could not resolve packages-install-path before dbt runs. Use altimate-dbt deps to install packages for this project."
    bufferLog(`[dbt-tools] ${reason}`)
    return { action: "none", reason }
  }
  const fast = packagesSatisfied(root)
  if (fast.ok) return { action: "skipped", reason: fast.reason }

  const waitedFor = existsSync(join(stateDir(root), "packages.lock"))
  return withPackagesLock(
    root,
    async () => {
      // Another process may have finished the install while we waited.
      const again = packagesSatisfied(root)
      if (again.ok) return { action: "skipped-after-wait" as const, reason: waitedFor ? `${again.reason} (after waiting for the lock)` : again.reason }
      await installUnderLock(root, install, true)
      return { action: "installed" as const, reason: again.reason }
    },
    opts,
  )
}

/**
 * Run an explicit install request (`altimate-dbt deps`, `add-packages`) under the lock. The
 * library can report failure as a result. Stamp only a reported exit status of 0
 * with complete package directories.
 */
export async function installPackagesLocked<T>(root: string, install: () => Promise<T>, opts?: LockOptions): Promise<T> {
  return withPackagesLock(root, () => installUnderLock(root, install, false), opts)
}

/** An installer that shells out to `dbt deps` with the project's resolved dbt binary. */
export function dbtDepsInstaller(cfg: { pythonPath?: string; projectRoot: string }): () => Promise<void> {
  return () =>
    new Promise<void>((res, rej) => {
      const dbt = resolveDbt(cfg.pythonPath, cfg.projectRoot)
      execFile(
        dbt.path,
        ["deps"],
        { cwd: cfg.projectRoot, env: buildDbtEnv(dbt), timeout: DEPS_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
        (err, _stdout, stderr) => {
          if (err) rej(new Error(`dbt deps failed: ${String(stderr || err.message).slice(-500)}`))
          else res()
        },
      )
    })
}
