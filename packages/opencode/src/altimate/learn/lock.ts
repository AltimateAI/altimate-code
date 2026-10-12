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
import path from "node:path"
import { Flock } from "@opencode-ai/core/util/flock"
import { Hash } from "@opencode-ai/core/util/hash"
import * as SafeFS from "./safe-fs"

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
  // Flock creates its own directories, so validate its paths before handing it the project directory.
  for (const file of [dir, lock, lock + ".breaker", path.join(lock, "meta.json"), path.join(lock, "heartbeat")])
    await SafeFS.assertSafePath(key, file)
  let failure: unknown
  try {
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
          await SafeFS.open(key, file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL).then(async (handle) => {
            try { await handle.writeFile(rules) } finally { await handle.close() }
          }).catch(async (error: NodeJS.ErrnoException) => {
            // An existing read-only file can already contain the required rules.
            if (error.code !== "EEXIST" && error.code !== "EACCES") throw error
            const reader = await SafeFS.open(key, file, constants.O_RDONLY)
            try {
              if (!(await reader.stat()).isFile()) throw new Error("Learn .gitignore must be a regular file")
              if ((await reader.readFile("utf8")).includes(rules)) return
            } finally { await reader.close() }
            const handle = await SafeFS.open(key, file, constants.O_RDWR | constants.O_APPEND)
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
      // PID liveness cannot shorten this floor: same-host containers may use different PID namespaces.
      // Token checks catch observed lease loss but cannot fence every takeover race.
      staleMs: 10 * 60_000,
      timeoutMs: options.timeoutMs ?? 10 * 60_000,
      maxDelayMs: options.timeoutMs === undefined ? undefined : 100,
    })
  } catch (error) {
    // A displaced Flock also rejects release; keep the transaction's original failure visible.
    throw failure ?? error
  }
}
