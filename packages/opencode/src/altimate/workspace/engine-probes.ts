// altimate_change - new file
//
// Everything that asks the outside world a question: the binary, its
// version, the workspace allowlist, and the user-facing surfaces.
import { readFileSync, readdirSync, statSync } from "fs"
import { homedir } from "os"
import { isAbsolute, join, relative, resolve, sep } from "path"
import launch from "cross-spawn"
import { which as whichBinary } from "@opencode-ai/core/util/which"
import { AltimateApi } from "@/altimate/api/client"
import { AppRuntime } from "@/effect/app-runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TuiEvent } from "@/server/tui-event"
import { readLocalBindingScopedStrict } from "./state"
import { log, syncInternals, type BindingRead, type ScopedBinding } from "./engine-seams"
import type { Declared, Toast } from "./engine-types"

/** How long the allowlist lookup may hold a turn. Once per workspace per process. */
export const DECLARED_TIMEOUT_MS = 4_000

/** The directory's binding, read strictly: a cache or credentials file that
 * is present but unreadable is `failed`, never `unbound`, so a transient read
 * error cannot pass for an unlink and hand the key to another source. The
 * test seam keeps the plain shape and may throw; a throw from it takes the
 * same path a production one does. */
export async function resolveBinding(directory: string): Promise<BindingRead> {
  try {
    const binding = syncInternals.resolveBinding
      ? await syncInternals.resolveBinding(directory)
      : await readScoped(directory)
    return binding ? { kind: "bound", binding } : { kind: "unbound" }
  } catch (err) {
    log.warn("could not read the workspace binding", { err: String(err) })
    return { kind: "failed", error: String(err) }
  }
}

async function readScoped(directory: string): Promise<ScopedBinding | null> {
  // One credential snapshot validates the hit and names its scope, so the
  // binding cannot be paired with another tenant's scope by a credentials
  // change between two reads. The id alone is tenant-local.
  const { binding, scope } = await readLocalBindingScopedStrict(directory)
  if (!binding) return null
  return { ...binding, scope: scope ?? undefined }
}

export function which(cmd: string): string | null {
  return syncInternals.which ? syncInternals.which(cmd) : whichBinary(cmd)
}

/** Identity of the file behind a PATH hit, cheap enough to ask every turn:
 * inode, size, mtime and ctime of the target (symlinks followed, so an npm
 * bin shim whose package was reinstalled reads as changed). A replacement
 * file has a new inode; a rewrite in place that keeps the length and restores
 * the mtime still moves the ctime, which nothing in userland can set back —
 * so an update cannot read as the same file. Null when it cannot be stat'ed;
 * with nothing to compare, the caller's memo falls back to its TTL. */
export function fingerprint(bin: string): string | null {
  if (syncInternals.fingerprint) return syncInternals.fingerprint(bin)
  try {
    const stat = statSync(bin)
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  } catch {
    return null
  }
}

/** `datamate --version`, stdout only. The engine prints its real package
 * version here; its MCP `serverInfo` was a hard-coded placeholder on the very
 * engines the floor excludes, so the handshake cannot be asked instead.
 *
 * cross-spawn, not execFile: an npm-installed engine on Windows resolves to a
 * `.cmd` shim that Node cannot execute without a shell. */
/** How long `--version` may take before the engine counts as unreadable. */
export const VERSION_TIMEOUT_MS = 5_000

export function versionOf(bin: string): Promise<string | null> {
  if (syncInternals.versionOf) return syncInternals.versionOf(bin)
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (value: string | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    try {
      const child = launch(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] })
      let out = ""
      child.stdout?.on("data", (chunk) => {
        out += String(chunk)
      })
      // Settle on `exit`, not `close`: a descendant that inherited stdout would
      // keep `close` from firing after the engine itself has answered. The
      // deadline is ours as well — the runtime's `timeout` only signals the
      // direct child, so it could not end a wait on a straggler's pipe.
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          // Already gone.
        }
        child.stdout?.destroy()
        done(null)
      }, VERSION_TIMEOUT_MS)
      child.on("error", () => done(null))
      child.on("exit", (code) => {
        // Let any bytes still in flight land before reading `out`.
        setImmediate(() => {
          child.stdout?.destroy()
          if (code !== 0) return done(null)
          const line = out.trim().split(/\r?\n/)[0] ?? ""
          done(line || null)
        })
      })
    } catch {
      done(null)
    }
  })
}

/** The workspace allowlist, split by whether the CLI can serve it. */
export async function declared(workspaceId: string): Promise<Declared | null> {
  if (syncInternals.declared) return syncInternals.declared(workspaceId)
  try {
    if (!(await AltimateApi.isConfigured())) return null
    const [workspace, catalog] = await Promise.all([
      AltimateApi.getDatamate(workspaceId),
      AltimateApi.listIntegrations(),
    ])
    const extensionIds = new Set(catalog.filter((i) => i.type === "extension").map((i) => i.id))
    const keys: string[] = []
    const extensionKeys: string[] = []
    for (const integration of workspace.integrations ?? []) {
      const target = extensionIds.has(integration.id) ? extensionKeys : keys
      for (const tool of integration.tools ?? []) target.push(tool.key)
    }
    return { keys, extensionKeys }
  } catch (err) {
    log.warn("could not read the declared workspace integrations", { workspaceId, err: String(err) })
    return null
  }
}

/** The allowlist, bounded. Reporting only; the losing timer is cancelled so a
 * lookup that succeeded in time is not later reported as timed out. */
export async function declaredBounded(workspaceId: string): Promise<Declared | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      declared(workspaceId),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          log.warn("workspace allowlist lookup timed out; continuing without the declared-vs-delivered report", {
            workspaceId,
            timeoutMs: DECLARED_TIMEOUT_MS,
          })
          resolve(null)
        }, DECLARED_TIMEOUT_MS)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Whether a live VS Code bridge would serve `cwd`, resolved the way the
 * engine resolves it at spawn (see the engine's extensionRpcDiscovery): a
 * sidecar whose recorded workspaceFolders contain `cwd`, else the sole live
 * bridge. Read-only — a dead pid is skipped, never unlinked; GC of stale
 * sidecars belongs to the engine and the extension. Presentation only: the
 * engine remains the authority on what actually connects. */
export function liveBridge(cwd: string, dir: string = join(homedir(), ".altimate", "extension-rpc")): boolean {
  if (syncInternals.liveBridge) return syncInternals.liveBridge(cwd)
  const bridges: string[][] = []
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue
      try {
        const data = JSON.parse(readFileSync(join(dir, entry), "utf8")) as {
          socketPath?: string
          workspaceFolders?: string[]
          pid?: number
        }
        if (typeof data.socketPath !== "string" || !data.socketPath) continue
        // A sidecar without a pid counts as live, matching the engine's own
        // discovery. A PRESENT pid must be a live real process: the bridge
        // extension always writes a positive integer, so a string, null, or
        // non-positive value is a corrupt record, not a legacy shape — and
        // unlike the engine, this probe has no connection attempt behind it
        // to catch a bad guess. kill(0)/kill(-1) probe process groups, which
        // would read garbage pids as alive. (codex r3, cubic)
        if ("pid" in data && !(typeof data.pid === "number" && Number.isInteger(data.pid) && data.pid > 0 && pidAlive(data.pid)))
          continue
        // Validate the folders shape: this is an unvalidated JSON file, and a
        // non-array must degrade to "live bridge, no recorded folders", not
        // throw out of the probe. Only fully qualified strings survive —
        // anything resolve() would complete from the process's own cwd or
        // drive could spuriously match and bypass the two-bridge decline.
        // (codex r3+r4)
        const folders = Array.isArray(data.workspaceFolders)
          ? data.workspaceFolders.filter((f): f is string => typeof f === "string" && qualifiedFolder(f))
          : []
        bridges.push(folders)
      } catch {
        // An unreadable sidecar is not a live bridge.
      }
    }
  } catch {
    return false
  }
  if (bridges.length === 0) return false
  const within = (folder: string) => {
    const rel = relative(resolve(folder), resolve(cwd))
    // ".." must be a complete path component: a child literally named
    // "..cache" yields rel "..cache", which is inside. (bot review)
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  }
  if (bridges.some((folders) => folders.some(within))) return true
  return bridges.length === 1
}

/** A recorded folder must be fully qualified. On Windows, drive-relative
 * paths like "\repo" count as absolute to Node, but resolve() completes them
 * with the process's CURRENT drive — so a corrupt entry could match any cwd
 * on that drive and defeat the two-bridge decline. Drive-qualified (C:\ or
 * C:/) or UNC (\\server\share) only; POSIX keeps plain isAbsolute. The
 * platform parameter exists for tests. (codex r4) */
export function qualifiedFolder(f: string, win: boolean = process.platform === "win32"): boolean {
  if (!f) return false
  return win ? /^([a-zA-Z]:[\\/]|\\\\)/.test(f) : isAbsolute(f)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM is a live process owned by someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

export async function notify(toast: Toast): Promise<void> {
  if (syncInternals.notify) return syncInternals.notify(toast)
  try {
    await AppRuntime.runPromise(
      EventV2Bridge.Service.use((events) => events.publish(TuiEvent.ToastShow, { ...toast, duration: 10000 })),
    )
  } catch (err) {
    log.warn("could not show the workspace engine toast", { err: String(err) })
  }
}

// altimate_change start — see `printLine`.
function stripControl(text: string): string {
  // C0 minus TAB (a tab is harmless here and legitimate in a name), DEL, and
  // C1 (U+0080-U+009F) — U+009B is CSI, so a terminal decoding C1 from UTF-8
  // would still act on an escape sequence the C0-only range let through.
  // (review)
  // eslint-disable-next-line no-control-regex
  // U+2028/U+2029 are Unicode line/paragraph separators: not C0 or C1, but they
  // still break the one-notice-per-line framing this writer depends on. (bot review)
  return text.replace(/[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u2028\u2029]/g, "")
}
// altimate_change end

/** stderr, deliberately: `run --format json` documents stdout as raw JSON
 * events, and this is a status notice, not run output. */
export function printLine(line: string): void {
  // altimate_change — strip BEFORE the test-seam branch. Stripping after it
  // meant the override path (and therefore anything routed through it) never
  // got sanitised at all, so the guard covered only one of the two exits.
  // (review)
  const safe = stripControl(line)
  if (syncInternals.printLine) return syncInternals.printLine(safe)
  try {
    // altimate_change — these lines embed the workspace NAME, which is
    // set server-side and never validated for control characters. Writing it
    // raw lets a workspace name carrying ANSI escapes repaint or hide
    // surrounding output — including, in a CI log, the "engine not usable"
    // notice this function exists to deliver. Strip C0 and DEL; the newline is
    // added below, so nothing legitimate here needs them. (review)
    process.stderr.write(safe + "\n")
  } catch {
    // A closed stream must not take down the turn.
  }
}
