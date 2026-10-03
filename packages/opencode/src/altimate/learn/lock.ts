// altimate_change - new file
// Security posture: reflection runs the model outside this lock; the lock protects only the
// short read-curate-write step. A writer paused inside that step beyond the 10-minute stale
// threshold can still race a successor between ownership checks and writes. This is an
// accepted residual risk; the lease and token checks are best-effort guards, not fencing.
// Reuse the repository's cross-process lock (heartbeat, stale-owner recovery, retry and token-checked
// release). Async-local ownership lets nested store and signal operations share one transaction.
import { AsyncLocalStorage } from "node:async_hooks"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Flock } from "@opencode-ai/core/util/flock"
import { Hash } from "@opencode-ai/core/util/hash"

interface Owner {
  active: boolean
  metadata: string
  token: string
  lost?: Error
}

const owners = new AsyncLocalStorage<Map<string, Owner>>()

async function readToken(metadata: string): Promise<string> {
  const parsed = JSON.parse(await fs.readFile(metadata, "utf8"))
  if (typeof parsed?.token !== "string" || !parsed.token) throw new Error("Invalid learn lock metadata")
  return parsed.token
}

async function deadOwner(lock: string): Promise<string | undefined> {
  const owner = await fs.readFile(path.join(lock, "meta.json"), "utf8").then((raw) => JSON.parse(raw)).catch(() => undefined)
  if (owner?.hostname !== os.hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return
  if (typeof owner.token !== "string" || !owner.token) return
  try {
    process.kill(owner.pid, 0)
    if (os.platform() === "linux") {
      const stat = await fs.readFile(`/proc/${owner.pid}/stat`, "utf8").catch(() => undefined)
      // The command name can contain spaces and parentheses; state follows the final ')'.
      if (stat?.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) return owner.token
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return owner.token
  }
}

async function recoverDeadOwner(lock: string): Promise<void> {
  const token = await deadOwner(lock)
  if (!token) return
  // Coordinate with Flock's stale-heartbeat recovery, and recheck ownership after claiming it.
  const breaker = lock + ".breaker"
  try {
    await fs.mkdir(breaker, { mode: 0o700 })
  } catch (error) {
    if (["EEXIST", "ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return
    throw error
  }
  try {
    if (await deadOwner(lock) !== token) return
    await fs.rm(lock, { recursive: true, force: true })
  } finally {
    await fs.rm(breaker, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Check immediately before each filesystem mutation; async-local ownership alone can outlive a lease. */
export async function assertLearnLock(root: string): Promise<void> {
  const owner = owners.getStore()?.get(await fs.realpath(root))
  if (!owner?.active) throw new Error("Learn state write requires an active lock")
  if (owner.lost) throw owner.lost
  try {
    if (await readToken(owner.metadata) === owner.token) return
  } catch {}
  owner.lost = new Error("Learn lock lease lost; refusing state write")
  throw owner.lost
}

export async function withLearnLock<T>(root: string, task: () => Promise<T>, options: { timeoutMs?: number } = {}): Promise<T> {
  const key = await fs.realpath(root)
  if (owners.getStore()?.get(key)?.active) return task()
  const dir = path.join(key, ".altimate-code", "learn")
  const lock = path.join(dir, Hash.fast("learn-state") + ".lock")
  let failure: unknown
  try {
    await recoverDeadOwner(lock)
    return await Flock.withLock("learn-state", async () => {
      // Flock does not expose its token, so read its metadata while entering the acquired lease.
      const metadata = path.join(lock, "meta.json")
      const owner: Owner = { active: true, metadata, token: await readToken(metadata) }
      const context = new Map(owners.getStore())
      context.set(key, owner)
      try {
        return await owners.run(context, async () => {
          // Every learn writer enters here after Flock creates the directory. Share approved
          // lessons with the team while keeping operational state local; preserve user edits.
          const file = path.join(dir, ".gitignore")
          const rules = "# Share approved lessons; keep signals and other local learning state out of Git.\n*\n!/*/\n!/*/approved.json\n!/.gitignore\n"
          await assertLearnLock(key)
          await fs.writeFile(file, rules, { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error
            if ((await fs.lstat(file)).isSymbolicLink()) throw new Error("Learn .gitignore must not be a symlink")
            const handle = await fs.open(file, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW)
            try {
              if (!(await handle.stat()).isFile()) throw new Error("Learn .gitignore must be a regular file")
              const current = await handle.readFile("utf8")
              if (current.includes(rules)) return
              await assertLearnLock(key)
              await handle.appendFile((current && !current.endsWith("\n") ? "\n" : "") + rules)
            } finally { await handle.close() }
          })
          return task()
        })
      } catch (error) {
        failure = error
        throw error
      } finally {
        // Detached work inheriting this context must acquire its own lock after the transaction ends.
        owner.active = false
      }
    }, {
      dir,
      // Laptop sleep and long event-loop pauses should not evict a live learning transaction quickly.
      // Token checks catch observed lease loss but cannot fence every takeover race.
      staleMs: 10 * 60_000,
      timeoutMs: options.timeoutMs ?? 10 * 60_000,
      maxDelayMs: options.timeoutMs === undefined ? undefined : 100,
      onWait: () => recoverDeadOwner(lock),
    })
  } catch (error) {
    // A displaced Flock also rejects release; keep the transaction's original failure visible.
    throw failure ?? error
  }
}
