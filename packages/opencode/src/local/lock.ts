import fs from "node:fs/promises"
import path from "node:path"

import { getLocalPaths, type LocalPaths } from "./paths"

const STALE_MS = 10 * 60_000

// Cross-process mutex for the local-server lifecycle: concurrent
// `altimate local` / `local stop` invocations otherwise race on state.json
// (last-writer-wins) and can orphan a server the other command just started.
export async function withLifecycleLock<T>(run: () => Promise<T>, paths: LocalPaths = getLocalPaths()): Promise<T> {
  const dir = path.join(paths.root, ".lifecycle-lock")
  const meta = path.join(dir, "owner.json")
  const deadline = Date.now() + 30_000
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
      const dead = (() => {
        if (!owner?.pid) return true
        try {
          process.kill(owner.pid, 0)
          return false
        } catch {
          return true
        }
      })()
      if (dead || (owner?.at && Date.now() - owner.at > STALE_MS)) {
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
