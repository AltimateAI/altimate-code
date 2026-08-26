import fs from "node:fs/promises"
import path from "node:path"

import { getLocalPaths, type LocalPaths } from "./paths"

// PID liveness is the primary staleness signal (checked in isOwnerStale
// below). This age is only a last-resort fallback for the rare case where
// the OS has recycled the recorded pid onto an unrelated live process — it
// must stay far longer than any legitimate setup step (model downloads can
// run well past ten minutes) or it forcibly evicts a live, working lock.
const PID_REUSE_FALLBACK_MS = 24 * 60 * 60_000

export function isOwnerStale(owner: { pid?: number; at?: number } | undefined, now: number): boolean {
  const dead = (() => {
    if (!owner?.pid) return true
    try {
      process.kill(owner.pid, 0)
      return false
    } catch {
      return true
    }
  })()
  if (dead) return true
  return Boolean(owner?.at && now - owner.at > PID_REUSE_FALLBACK_MS)
}

// Cross-process mutex for the local-server lifecycle: concurrent
// `altimate local` / `local stop` invocations otherwise race on state.json
// (last-writer-wins) and can orphan a server the other command just started.
export async function withLifecycleLock<T>(run: () => Promise<T>, paths: LocalPaths = getLocalPaths()): Promise<T> {
  const dir = path.join(paths.root, ".lifecycle-lock")
  const meta = path.join(dir, "owner.json")
  const deadline = Date.now() + 30_000
  // Ensure the lock's parent directory exists once, up front: on a truly
  // fresh install paths.root does not exist yet, so a plain fs.mkdir(dir)
  // below fails with ENOENT (not EEXIST) and the catch branch below treats
  // that the same as "no owner file", loops back to mkdir, and ENOENTs
  // forever without ever reaching the deadline check.
  await fs.mkdir(paths.root, { recursive: true })
  for (;;) {
    try {
      await fs.mkdir(dir)
      await fs.writeFile(meta, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 })
      break
    } catch {
      const owner = await fs
        .readFile(meta, "utf8")
        .then((raw) => JSON.parse(raw) as { pid?: number; at?: number })
        .catch(() => undefined)
      if (isOwnerStale(owner, Date.now())) {
        await fs.rm(dir, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline)
        throw new Error(`Another altimate local command (pid ${owner?.pid}) is running. Retry in a moment.`)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  try {
    return await run()
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
