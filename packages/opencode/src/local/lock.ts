import fs from "node:fs/promises"
import path from "node:path"

import { getLocalPaths, type LocalPaths } from "./paths"

// PID liveness is the primary staleness signal (checked in isOwnerStale
// below). This age is only a last-resort fallback for the rare case where
// the OS has recycled the recorded pid onto an unrelated live process — it
// must stay far longer than any legitimate setup step (model downloads can
// run well past ten minutes) or it forcibly evicts a live, working lock.
const PID_REUSE_FALLBACK_MS = 24 * 60 * 60_000

// Acquisition is two steps — mkdir(dir) publishes exclusivity, then
// owner.json is written into it — so a waiter can observe the dir existing
// with owner.json still missing. That's not proof the holder crashed: it
// may just be mid-way through those two steps. Only treat a missing
// owner.json as stale once the dir itself has existed longer than any
// legitimate mkdir-then-write gap could take; otherwise a waiter would
// delete the lock out from under a live holder and steal it while the
// holder still believes it holds it exclusively.
const OWNER_PUBLISH_GRACE_MS = 2_000

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

async function isLockStale(dir: string, meta: string, now: number): Promise<boolean> {
  const owner = await fs
    .readFile(meta, "utf8")
    .then((raw) => JSON.parse(raw) as { pid?: number; at?: number })
    .catch(() => undefined)
  if (owner) return isOwnerStale(owner, now)
  const dirAge = await fs
    .stat(dir)
    .then((s) => now - s.mtimeMs)
    .catch(() => Infinity)
  return dirAge > OWNER_PUBLISH_GRACE_MS
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
    // Checked unconditionally at the top of every attempt (not only in the
    // "live owner, keep waiting" branch below): a persistent filesystem
    // error (ENOSPC, EACCES) makes `mkdir` fail for a reason that is neither
    // EEXIST nor a stale lock, so `meta` never exists either — the old
    // deadline check, reachable only from the non-stale branch, was never
    // hit and the loop spun forever.
    if (Date.now() > deadline) throw new Error(`Timed out acquiring the local lifecycle lock at ${dir}.`)
    try {
      await fs.mkdir(dir)
      await fs.writeFile(meta, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 })
      break
    } catch {
      if (await isLockStale(dir, meta, Date.now())) {
        await fs.rm(dir, { recursive: true, force: true })
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  try {
    return await run()
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
