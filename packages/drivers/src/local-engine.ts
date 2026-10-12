/**
 * Supervised helper process that owns one local database handle, so a runaway
 * query can be stopped for certain.
 *
 * `bun:sqlite` calls block their thread and expose no interrupt, and the legacy
 * `duckdb` binding's `interrupt()` is a documented no-op. A `Worker` does not
 * help: `terminate()` left a blocking SQLite call at 100% CPU, and the duckdb
 * addon aborts Bun when loaded in a Worker. Killing a process stops the work
 * and releases its file locks (measured: see test/fixtures/cancel-probe.ts).
 *
 * Guarantees:
 *  - One process per connection owns the handle, PRAGMAs and session state, so
 *    `:memory:` stores, temp tables and transactions work as they did in-process.
 *  - Calls run one at a time in arrival order. The deadline covers execution
 *    only (not time queued behind another call), so a caller is never cancelled
 *    by someone else's timeout: a timed-out call kills the process, and every
 *    queued call then runs on a fresh process.
 *  - After a kill the handle is reopened with the same arguments and open deadline on the next
 *    call. Session state is lost, and the timeout error says so.
 *  - Each process has its own response reader; a response from a retired
 *    process can never settle a later call. Every timer is cleared on settle.
 */

import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { LOCAL_ENGINE_CHILD_SOURCE } from "./local-engine-child-source"
import { pack, unpack } from "./local-engine-codec"
import { QueryTimeoutError } from "./types"

/** Grace for a killed process to be reaped before we move on. */
const REAP_TIMEOUT_MS = 2_000
/** Grace for a polite close before the process is killed. */
const CLOSE_TIMEOUT_MS = 2_000
/** Short grace when close must bypass an in-flight query. */
const ACTIVE_CLOSE_TIMEOUT_MS = 500

type Engine = "sqlite" | "duckdb"

// This package is typechecked without Bun's ambient types; describe only what is used.
declare const Bun: { spawn(opts: Record<string, unknown>): ChildProc }
interface ChildProc {
  stdin: { write(data: string): unknown; flush(): unknown }
  stdout: AsyncIterable<Uint8Array>
  exited: Promise<number>
  kill(signal?: string): void
}

interface Pending {
  id: number
  resolve(value: any): void
  reject(err: Error): void
}

interface Child {
  proc: ChildProc
  pending?: Pending
  /** No further responses are accepted from this process. */
  retired: boolean
  /** We ended it on purpose; its exit is not a crash. */
  killedByUs: boolean
}

const liveChildren = new Set<Child>()
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  globalThis.process?.on?.("exit", () => {
    for (const child of liveChildren) {
      try {
        child.proc.kill("SIGKILL")
      } catch {}
    }
    removeHelperDir()
  })
}

/**
 * The per-process private directory that holds the helper script and serves as
 * the helper's HOME and explicit Bun configuration. It is created with an unpredictable
 * name and mode 0700, then verified (real directory, not a symlink, ours,
 * private) before anything is written into it or executed from it; any doubt
 * fails closed. Nobody else can swap its contents. The helper uses this empty
 * config explicitly, so project-controlled Bun startup files are never read.
 */
let helperDir: string | undefined

function assertPrivateDirectory(dir: string): void {
  const st = fs.lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`Local engine helper directory is not a plain directory: ${dir}`)
  if (typeof process.getuid === "function") {
    if (st.uid !== process.getuid()) throw new Error(`Local engine helper directory is not owned by this user: ${dir}`)
    if ((st.mode & 0o077) !== 0) throw new Error(`Local engine helper directory is not private (mode ${(st.mode & 0o777).toString(8)}): ${dir}`)
  }
}

function removeHelperDir(): void {
  const dir = helperDir
  helperDir = undefined
  if (!dir) return
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {}
}

function privateHelperDir(): string {
  if (helperDir) {
    try {
      assertPrivateDirectory(helperDir)
      return helperDir
    } catch (err) {
      // Gone (e.g. a temp cleaner ran): rebuild. Anything else is tampering.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err
      helperDir = undefined
    }
  }
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "altimate-local-engine-"))
  try {
    if (process.platform !== "win32") fs.chmodSync(dir, 0o700)
    assertPrivateDirectory(dir)
    // An explicit empty config overrides the caller's project Bun config.
    fs.writeFileSync(path.join(dir, "bunfig.toml"), "", { flag: "wx", mode: 0o600 })
  } catch (err) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
    throw err
  }
  helperDir = dir
  return dir
}

/** Where the helper script lives: written once per content hash into the private directory. */
function ensureChildScript(source: string): { dir: string; file: string } {
  const dir = privateHelperDir()
  const hash = crypto.createHash("sha256").update(source).digest("hex").slice(0, 16)
  const file = path.join(dir, `child-${hash}.mjs`)
  try {
    fs.writeFileSync(file, source, { flag: "wx", mode: 0o600 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err
    const st = fs.lstatSync(file)
    if (!st.isFile() || st.isSymbolicLink() || fs.readFileSync(file, "utf8") !== source) {
      throw new Error(`Local engine helper script failed verification: ${file}`)
    }
  }
  return { dir, file }
}

/**
 * The helper's entire environment. Forward database settings and cloud access
 * variables used by DuckDB extensions, while excluding unrelated model-provider
 * variables and Bun startup options. HOME/XDG point at the private directory so
 * no user-level Bun config is found. `BUN_BE_BUN` makes a compiled executable act as plain bun.
 */
export function buildHelperEnv(dir: string, parent: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {
    PATH: parent["PATH"] ?? "",
    HOME: dir,
    USERPROFILE: dir,
    XDG_CONFIG_HOME: dir,
    XDG_DATA_HOME: dir,
    XDG_CACHE_HOME: dir,
    XDG_STATE_HOME: dir,
    TMPDIR: dir,
    TMP: dir,
    TEMP: dir,
    BUN_BE_BUN: "1",
  }
  for (const name of [
    "LANG", "LC_ALL", "TZ", "SystemRoot", "windir", "COMSPEC", "PATHEXT", "GOOGLE_APPLICATION_CREDENTIALS",
    "motherduck_token", "MOTHERDUCK_TOKEN", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  ]) {
    const v = parent[name]
    if (v !== undefined) env[name] = v
  }
  for (const [name, value] of Object.entries(parent)) {
    if (name.startsWith("AWS_") && value !== undefined) env[name] = value
  }
  return env
}

/** Keep store paths anchored to the same caller directory across helper restarts. */
function absolutizeStorePath(payload: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const p = payload["path"]
  if (typeof p !== "string" || p === "" || p === ":memory:" || path.isAbsolute(p)) return payload
  // Keep URI-style locations (file:, md:, s3:) as they are; a Windows drive path is absolute above.
  if (/^[a-z][a-z0-9+.-]+:/i.test(p)) return payload
  return { ...payload, path: path.resolve(cwd, p) }
}

export interface LocalEngineOptions {
  engine: Engine
  /** Human label used in errors, e.g. "SQLite". */
  label: string
  /** Where the store lives, used to word the lost-state disclosure. */
  storePath: string
  /** Directory used for relative paths inside SQL; captured at construction by default. */
  cwd?: string
  /** Test seam: replaces the helper program. */
  childSource?: string
}

interface OpenRequest {
  payload: Record<string, unknown>
  timeoutMs: number | undefined
  onTimeout: (() => Error) | undefined
}

export class LocalEngine {
  private child: Child | undefined
  private openRequest: OpenRequest | undefined
  private seq = 0
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  private readonly cwd: string

  constructor(private readonly opts: LocalEngineOptions) {
    this.cwd = path.resolve(opts.cwd ?? process.cwd())
  }

  /**
   * Open the store. `timeoutMs` bounds the open itself (a liveness guard); on
   * expiry the process is killed and `onOpenTimeout` supplies the error. The
   * payload is remembered only once the open succeeds, so a respawn reopens
   * exactly what worked.
   */
  open(payload: Record<string, unknown>, timeoutMs?: number, onOpenTimeout?: () => Error): Promise<void> {
    this.closed = false
    return this.enqueue(async () => {
      if (this.closed) throw new Error(`${this.opts.label} connection closed`)
      const request: OpenRequest = { payload: absolutizeStorePath(payload, this.cwd), timeoutMs, onTimeout: onOpenTimeout }
      const child = this.spawn()
      try {
        await this.sendOpen(child, request)
        if (this.closed) throw new Error(`${this.opts.label} connection closed`)
      } catch (err) {
        await this.retire(child)
        throw err
      }
      // Kept with its deadline, so a respawn is bounded by the same open budget.
      this.openRequest = request
    })
  }

  private sendOpen(child: Child, request: OpenRequest): Promise<void> {
    return this.send(child, "open", { ...request.payload, engine: this.opts.engine }, request.timeoutMs, () =>
      request.onTimeout
        ? request.onTimeout()
        : new Error(`${this.opts.label} store did not finish opening in ${request.timeoutMs}ms`),
    )
  }

  /** Run one request. `timeoutMs` undefined means no deadline. */
  call<T = any>(op: "all" | "run", payload: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    return this.enqueue(async () => {
      if (this.closed || !this.openRequest) throw new Error(`${this.opts.label} connection not open`)
      const child = await this.ensureChild()
      if (this.closed) throw new Error(`${this.opts.label} connection closed`)
      return this.send(child, op, payload, timeoutMs, () => this.timeoutQueryError(timeoutMs!)) as Promise<T>
    })
  }

  async close(): Promise<void> {
    this.closed = true
    this.openRequest = undefined
    const child = this.child
    if (!child) return
    // Do not enqueue close behind a query that may have no execution deadline.
    // Keep its pending promise: the process-exit handler clears child.pending.
    const pending = child.pending
    if (pending) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        this.tail,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, ACTIVE_CLOSE_TIMEOUT_MS) }),
      ])
      if (timer) clearTimeout(timer)
    } else {
      try {
        await this.send(child, "close", {}, CLOSE_TIMEOUT_MS, () => new Error("close timed out"))
      } catch {}
    }
    await this.retire(child)
    pending?.reject(new Error(`${this.opts.label} connection closed`))
  }

  // -- internals -------------------------------------------------------------

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.catch(() => {})
    return run
  }

  private timeoutQueryError(timeoutMs: number): QueryTimeoutError {
    const memory = this.opts.storePath === ":memory:" || this.opts.storePath === ""
    return new QueryTimeoutError({
      engine: this.opts.label,
      timeoutMs,
      stateLost: true,
      detail:
        "The database session was restarted to stop it: " +
        (memory ? "the in-memory database was emptied, and " : "") +
        "temporary tables, session settings and any open transaction were discarded" +
        (memory ? "." : "; data already committed to the store is unaffected, and an interrupted write was rolled back."),
    })
  }

  private spawn(): Child {
    installExitHook()
    const { dir, file } = ensureChildScript(this.opts.childSource ?? LOCAL_ENGINE_CHILD_SOURCE)
    const proc = Bun.spawn({
      // Preserve relative SQL paths without loading project preloads or .env files.
      cmd: [process.execPath, `--config=${path.join(dir, "bunfig.toml")}`, "--no-env-file", file, String(process.pid)],
      cwd: this.cwd,
      env: buildHelperEnv(dir),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    })
    const child: Child = { proc, retired: false, killedByUs: false }
    liveChildren.add(child)
    this.child = child
    void this.readLoop(child)
    void proc.exited.then(() => {
      liveChildren.delete(child)
      child.retired = true
      if (this.child === child) this.child = undefined
      const pending = child.pending
      child.pending = undefined
      if (pending && !child.killedByUs) pending.reject(new Error(`${this.opts.label} helper process exited unexpectedly`))
    })
    return child
  }

  private async readLoop(child: Child): Promise<void> {
    const decoder = new TextDecoder()
    let buf = ""
    try {
      for await (const chunk of child.proc.stdout) {
        buf += decoder.decode(chunk, { stream: true })
        let nl: number
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (!line.trim()) continue
          let msg: any
          try {
            msg = JSON.parse(line)
          } catch {
            continue
          }
          // A retired process (killed on timeout) must not settle anything.
          if (child.retired && child.killedByUs) return
          const pending = child.pending
          if (!pending || pending.id !== msg.id) continue
          child.pending = undefined
          if (msg.ok) pending.resolve(unpack(msg.result))
          else {
            const err: any = new Error(msg.error?.message ?? "unknown error")
            if (msg.error?.code !== undefined) err.code = msg.error.code
            if (msg.error?.errno !== undefined) err.errno = msg.error.errno
            pending.reject(err)
          }
        }
      }
    } catch {
      // stream error: the exit handler rejects the pending call
    }
  }

  /** The live process, respawned and reopened after a kill or crash. */
  private async ensureChild(): Promise<Child> {
    if (this.child && !this.child.retired) return this.child
    const child = this.spawn()
    try {
      await this.sendOpen(child, this.openRequest!)
    } catch (err) {
      await this.retire(child)
      throw err
    }
    return child
  }

  private send(
    child: Child,
    op: string,
    payload: Record<string, unknown>,
    timeoutMs: number | undefined,
    onTimeout: () => Error,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      if (child.retired) return reject(new Error(`${this.opts.label} helper process is not running`))
      const id = ++this.seq
      let timer: ReturnType<typeof setTimeout> | undefined
      let settled = false
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (child.pending?.id === id) child.pending = undefined
        fn()
      }
      child.pending = {
        id,
        resolve: (v) => settle(() => resolve(v)),
        reject: (e) => settle(() => reject(e)),
      }
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (settled) return
          // Stop the work first, then report: the caller must not see the
          // timeout while the process still holds the store.
          void this.retire(child).then(() => settle(() => reject(onTimeout())))
        }, timeoutMs)
      }
      try {
        child.proc.stdin.write(JSON.stringify({ id, op, payload: pack(payload) }) + "\n")
        child.proc.stdin.flush()
      } catch (err) {
        settle(() => reject(err as Error))
      }
    })
  }

  /** Kill a process and wait (bounded) for it to be reaped so its locks are gone. */
  private async retire(child: Child): Promise<void> {
    child.retired = true
    child.killedByUs = true
    if (this.child === child) this.child = undefined
    try {
      child.proc.kill("SIGKILL")
    } catch {}
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      child.proc.exited,
      new Promise((r) => {
        timer = setTimeout(r, REAP_TIMEOUT_MS)
      }),
    ])
    if (timer) clearTimeout(timer)
    liveChildren.delete(child)
  }
}
