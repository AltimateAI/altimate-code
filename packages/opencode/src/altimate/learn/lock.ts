// altimate_change - new file
// Reuse the repository's cross-process lock (heartbeat, stale-owner recovery, retry and token-checked
// release). Async-local ownership lets nested store and signal operations share one transaction.
import { AsyncLocalStorage } from "node:async_hooks"
import fs from "node:fs/promises"
import path from "node:path"
import { Flock } from "@opencode-ai/core/util/flock"

const owners = new AsyncLocalStorage<Map<string, { active: boolean }>>()

export async function withLearnLock<T>(root: string, task: () => Promise<T>): Promise<T> {
  const key = await fs.realpath(root)
  if (owners.getStore()?.get(key)?.active) return task()
  return Flock.withLock("learn-state", async () => {
    const owner = { active: true }
    const context = new Map(owners.getStore())
    context.set(key, owner)
    try {
      return await owners.run(context, task)
    } finally {
      // Detached work inheriting this context must acquire its own lock after the transaction ends.
      owner.active = false
    }
  }, {
    dir: path.join(key, ".altimate-code", "learn"),
    timeoutMs: 10 * 60_000,
  })
}
