// altimate_change - new file
// Security posture: reflection runs the model outside this lock; the lock protects only the
// short read-curate-write step. A writer paused inside that step beyond the 10-minute stale
// threshold can still race a successor between ownership checks and writes. This is an
// accepted residual risk; the lease and token checks are best-effort guards, not fencing.
// Reuse the repository's cross-process lock (heartbeat, stale-owner recovery, retry and token-checked
// release). Async-local ownership lets nested store and signal operations share one transaction.
import { AsyncLocalStorage } from "node:async_hooks"
import fs from "node:fs/promises"
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

export async function withLearnLock<T>(root: string, task: () => Promise<T>): Promise<T> {
  const key = await fs.realpath(root)
  if (owners.getStore()?.get(key)?.active) return task()
  const dir = path.join(key, ".altimate-code", "learn")
  let failure: unknown
  try {
    return await Flock.withLock("learn-state", async () => {
      // Flock does not expose its token, so read its metadata while entering the acquired lease.
      const metadata = path.join(dir, Hash.fast("learn-state") + ".lock", "meta.json")
      const owner: Owner = { active: true, metadata, token: await readToken(metadata) }
      const context = new Map(owners.getStore())
      context.set(key, owner)
      try {
        return await owners.run(context, task)
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
      timeoutMs: 10 * 60_000,
    })
  } catch (error) {
    // A displaced Flock also rejects release; keep the transaction's original failure visible.
    throw failure ?? error
  }
}
